package transfer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
	"pontis/internal/changeset"
)

// TreeSource reads the canonical tree. The whole export comes from one
// snapshot: a file whose folder list and node list were read across somebody
// else's commit describes a tree that never existed, and re-importing it is
// then not the round trip it claims to be.
type TreeSource interface {
	// Space is the single read the staleness check needs.
	Space(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error)
	SnapshotTree(ctx context.Context, space canonical.SpaceID) (
		canonical.SyncSpace, []canonical.Node, []canonical.RootSlot, error)
}

// Writer supplies canonical transactions for import applies.
type Writer interface {
	BeginTx(ctx context.Context) (canonical.Tx, error)
}

// EntryAction classifies one planned change (doc 11 §8).
type EntryAction string

const (
	ActionCreate      EntryAction = "create"
	ActionUpdate      EntryAction = "update"
	ActionMove        EntryAction = "move"
	ActionDelete      EntryAction = "delete"
	ActionKeep        EntryAction = "keep"
	ActionAmbiguous   EntryAction = "ambiguous"
	ActionUnsupported EntryAction = "unsupported"
)

// Entry is one line of the plan preview.
type Entry struct {
	Title  string `json:"title"`
	URL    string `json:"url,omitempty"`
	Path   string `json:"path"`
	Action string `json:"action"`
	Reason string `json:"reason,omitempty"`
}

// Plan is the persisted-in-memory result of Parse → Validate → Plan.
type Plan struct {
	ID            string         `json:"plan_id"`
	SpaceID       string         `json:"space_id"`
	Format        Format         `json:"format"`
	Total         int            `json:"total"`
	Counts        map[string]int `json:"counts"`
	Warnings      []string       `json:"warnings"`
	Entries       []Entry        `json:"entries"`
	BoundRevision int64          `json:"bound_revision"`
	BoundEpoch    int64          `json:"-"`
	CreatedAt     time.Time      `json:"-"`
	Tree          *ImportNode    `json:"-"`
}

// PreviewOptions optionally scopes a preview to a target strategy and parent
// so replace previews can report deletions accurately (R42).
type PreviewOptions struct {
	Strategy string
	Parent   *canonical.ParentRef
}

// ApplyResult reports real counters from the committed transaction.
type ApplyResult struct {
	Created int64 `json:"created"`
	Updated int64 `json:"updated"`
	Deleted int64 `json:"deleted"`
	Kept    int64 `json:"kept"`
}

// planTTL bounds how long a preview stays valid; plans are operational
// temporary data (doc 14 §7).
const planTTL = time.Hour

// Service implements export and import planning/application.
type Service struct {
	trees      TreeSource
	writer     Writer
	changesets *changeset.Service

	// SafetyBackup, when wired, captures a safety backup before a root-level
	// replace import overwrites existing bookmarks (doc 11 §9).
	SafetyBackup func(ctx context.Context, space canonical.SpaceID) error

	mu    sync.Mutex
	plans map[string]Plan
}

// NewService returns a transfer service.
func NewService(trees TreeSource, writer Writer, changesets *changeset.Service) *Service {
	return &Service{trees: trees, writer: writer, changesets: changesets, plans: map[string]Plan{}}
}

// --- export (side-effect free) ---

// Export renders the space (or one root slot) in the requested format.
func (s *Service) Export(ctx context.Context, space canonical.SpaceID, format Format, rootKey string) (filename, contentType, content string, err error) {
	sp, nodes, slots, err := s.trees.SnapshotTree(ctx, space)
	if err != nil {
		return "", "", "", err
	}
	if rootKey != "" {
		// Collect the root slot's direct children AND all of their descendants.
		childrenOf := make(map[canonical.NodeID][]canonical.Node)
		var queue []canonical.Node
		for _, n := range nodes {
			if n.Parent.Type == canonical.ParentTypeNode {
				childrenOf[n.Parent.NodeID] = append(childrenOf[n.Parent.NodeID], n)
			} else if n.Parent.RootKey == rootKey {
				queue = append(queue, n)
			}
		}
		scoped := make([]canonical.Node, 0, len(queue))
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			scoped = append(scoped, cur)
			queue = append(queue, childrenOf[cur.ID]...)
		}
		nodes = scoped
		var filteredSlots []canonical.RootSlot
		for _, sl := range slots {
			if sl.Key == rootKey {
				filteredSlots = append(filteredSlots, sl)
			}
		}
		slots = filteredSlots
	}

	switch format {
	case FormatNetscapeHTML:
		return fmt.Sprintf("%s-bookmarks.html", sp.Name), "text/html", renderHTML(nodes, slots), nil
	case FormatNativeJSON:
		raw, err := renderJSON(sp, nodes, slots)
		if err != nil {
			return "", "", "", err
		}
		return fmt.Sprintf("%s-export.json", sp.Name), "application/json", raw, nil
	default:
		return "", "", "", ErrInvalidFormat
	}
}

func renderHTML(nodes []canonical.Node, slots []canonical.RootSlot) string {
	childrenOf := map[string][]canonical.Node{}
	rootsBySlot := map[string][]canonical.Node{}
	for _, n := range nodes {
		if n.Parent.Type == canonical.ParentTypeNode {
			key := string(n.Parent.NodeID)
			childrenOf[key] = append(childrenOf[key], n)
		} else {
			rootsBySlot[n.Parent.RootKey] = append(rootsBySlot[n.Parent.RootKey], n)
		}
	}
	for k := range childrenOf {
		list := childrenOf[k]
		sort.Slice(list, func(i, j int) bool { return list[i].Position < list[j].Position })
		childrenOf[k] = list
	}
	for k := range rootsBySlot {
		list := rootsBySlot[k]
		sort.Slice(list, func(i, j int) bool { return list[i].Position < list[j].Position })
		rootsBySlot[k] = list
	}

	sortedSlots := append([]canonical.RootSlot(nil), slots...)
	sort.Slice(sortedSlots, func(i, j int) bool { return sortedSlots[i].Position < sortedSlots[j].Position })

	esc := func(s string) string {
		r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
		return r.Replace(s)
	}
	var b strings.Builder
	b.WriteString("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n")
	b.WriteString("<!-- This is an automatically generated file. DO NOT EDIT! -->\n")
	b.WriteString(`<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">` + "\n")
	b.WriteString("<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n")

	var writeLevel func(list []canonical.Node, depth int)
	writeLevel = func(list []canonical.Node, depth int) {
		pad := strings.Repeat("    ", depth)
		for _, n := range list {
			if n.Type == canonical.NodeTypeFolder {
				b.WriteString(pad + "<DT><H3>" + esc(n.Title) + "</H3>\n")
				// Always emit <DL><p> ... </DL><p> for folders (even empty ones),
				// matching Chrome/Firefox Netscape bookmark output.
				b.WriteString(pad + "<DL><p>\n")
				if kids := childrenOf[string(n.ID)]; len(kids) > 0 {
					writeLevel(kids, depth+1)
				}
				b.WriteString(pad + "</DL><p>\n")
			} else {
				b.WriteString(pad + "<DT><A HREF=\"" + esc(n.URL) + "\">" + esc(n.Title) + "</A>\n")
			}
		}
	}

	// Preserve distinct root slots as top-level <H3> folders when more than one
	// slot holds content; single-slot exports write their children directly so
	// round-tripping into a root slot does not add a redundant wrapper folder.
	nonEmptySlots := 0
	for _, list := range rootsBySlot {
		if len(list) > 0 {
			nonEmptySlots++
		}
	}
	if nonEmptySlots > 1 {
		seen := map[string]bool{}
		for _, sl := range sortedSlots {
			list := rootsBySlot[sl.Key]
			if len(list) == 0 {
				continue
			}
			seen[sl.Key] = true
			name := sl.DisplayName
			if name == "" {
				name = sl.Key
			}
			b.WriteString("    <DT><H3>" + esc(name) + "</H3>\n")
			b.WriteString("    <DL><p>\n")
			writeLevel(list, 2)
			b.WriteString("    </DL><p>\n")
		}
		var extras []string
		for k, list := range rootsBySlot {
			if !seen[k] && len(list) > 0 {
				extras = append(extras, k)
			}
		}
		sort.Strings(extras)
		for _, k := range extras {
			b.WriteString("    <DT><H3>" + esc(k) + "</H3>\n")
			b.WriteString("    <DL><p>\n")
			writeLevel(rootsBySlot[k], 2)
			b.WriteString("    </DL><p>\n")
		}
	} else {
		var roots []canonical.Node
		for _, sl := range sortedSlots {
			if list := rootsBySlot[sl.Key]; len(list) > 0 {
				roots = append(roots, list...)
				delete(rootsBySlot, sl.Key)
			}
		}
		var extras []string
		for k := range rootsBySlot {
			extras = append(extras, k)
		}
		sort.Strings(extras)
		for _, k := range extras {
			roots = append(roots, rootsBySlot[k]...)
		}
		writeLevel(roots, 1)
	}
	b.WriteString("</DL><p>\n")
	return b.String()
}

func renderJSON(sp canonical.SyncSpace, nodes []canonical.Node, slots []canonical.RootSlot) (string, error) {
	file := portableFile{Format: "pontis-portable-bookmarks", Version: 1}
	for _, s := range slots {
		file.RootSlots = append(file.RootSlots, portableSlot{Key: s.Key, DisplayName: s.DisplayName, Position: s.Position})
	}
	for _, n := range nodes {
		pn := portableNode{
			ID:       string(n.ID),
			Type:     string(n.Type),
			Title:    n.Title,
			Position: n.Position,
		}
		if n.URL != "" {
			u := n.URL
			pn.URL = &u
		}
		if n.Parent.Type == canonical.ParentTypeNode {
			p := string(n.Parent.NodeID)
			pn.ParentID = &p
		} else {
			k := n.Parent.RootKey
			pn.RootKey = &k
		}
		file.Nodes = append(file.Nodes, pn)
	}
	raw, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// --- import planning ---

// Preview parses the content and plans against the space's whole tree:
// bookmarks are matched by exact raw URL anywhere in the space, folders by
// full path. Optional PreviewOptions supply a concrete strategy/parent so
// replace previews report deletions up front (R42).
func (s *Service) Preview(ctx context.Context, space canonical.SpaceID, format Format, content string, opts ...PreviewOptions) (*Plan, error) {
	var opt PreviewOptions
	if len(opts) > 0 {
		opt = opts[0]
	}
	if opt.Strategy != "" && opt.Strategy != "merge" && opt.Strategy != "replace" {
		return nil, ErrInvalidStrategy
	}
	tree, warnings, err := ParseImport(format, content)
	if err != nil {
		return nil, err
	}
	// One snapshot: the plan records the revision and epoch it binds to *and*
	// the tree it matched against, so Apply can verify both inside its write tx.
	sp, nodes, _, err := s.trees.SnapshotTree(ctx, space)
	if err != nil {
		return nil, err
	}
	urlSet := map[string]bool{}
	pathSet := map[string]bool{}
	var pathOf func(n canonical.Node) string
	byID := map[canonical.NodeID]canonical.Node{}
	childrenOf := map[canonical.NodeID][]canonical.Node{}
	for _, n := range nodes {
		byID[n.ID] = n
		if n.Parent.Type == canonical.ParentTypeNode {
			childrenOf[n.Parent.NodeID] = append(childrenOf[n.Parent.NodeID], n)
		}
		if n.Type == canonical.NodeTypeBookmark {
			urlSet[n.URL] = true
		}
	}
	pathOf = func(n canonical.Node) string {
		parts := []string{n.Title}
		cur := n
		for cur.Parent.Type == canonical.ParentTypeNode {
			p, ok := byID[cur.Parent.NodeID]
			if !ok {
				break
			}
			parts = append([]string{p.Title}, parts...)
			cur = p
		}
		return "/" + strings.Join(parts, "/")
	}
	for _, n := range nodes {
		if n.Type == canonical.NodeTypeFolder {
			pathSet[strings.ToLower(pathOf(n))] = true
		}
	}

	plan := &Plan{
		SpaceID:       string(space),
		Format:        format,
		Counts:        map[string]int{},
		Warnings:      warnings,
		BoundRevision: sp.CurrentRevision,
		BoundEpoch:    sp.Epoch,
		CreatedAt:     time.Now().UTC(),
		Tree:          tree,
	}

	isReplace := opt.Strategy == "replace"
	if isReplace && opt.Parent != nil {
		var queue []canonical.Node
		for _, n := range nodes {
			if sameParent(n.Parent, *opt.Parent) {
				queue = append(queue, n)
			}
		}
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			plan.Counts[string(ActionDelete)]++
			if len(plan.Entries) < 50 {
				plan.Entries = append(plan.Entries, Entry{
					Title:  cur.Title,
					URL:    cur.URL,
					Path:   pathOf(cur),
					Action: string(ActionDelete),
				})
			}
			queue = append(queue, childrenOf[cur.ID]...)
		}
	}

	var walk func(n ImportNode, path string)
	walk = func(n ImportNode, path string) {
		for _, c := range n.Children {
			p := path + "/" + strings.ToLower(c.Title)
			if c.URL != "" {
				plan.Total++
				switch {
				case !isReplace && urlSet[c.URL]:
					plan.Counts[string(ActionKeep)]++
					plan.Entries = append(plan.Entries, Entry{Title: c.Title, URL: c.URL, Path: path, Action: string(ActionKeep)})
				default:
					plan.Counts[string(ActionCreate)]++
					plan.Entries = append(plan.Entries, Entry{Title: c.Title, URL: c.URL, Path: path, Action: string(ActionCreate)})
				}
			} else {
				plan.Total++
				if !isReplace && pathSet[p] {
					plan.Counts[string(ActionKeep)]++
					plan.Entries = append(plan.Entries, Entry{Title: c.Title, Path: path, Action: string(ActionKeep)})
				} else {
					plan.Counts[string(ActionCreate)]++
					plan.Entries = append(plan.Entries, Entry{Title: c.Title, Path: path, Action: string(ActionCreate)})
				}
				walk(c, p)
			}
		}
	}
	walk(*tree, "")

	id, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	plan.ID = id.String()

	// Prune stale plans while we hold the lock.
	s.mu.Lock()
	now := time.Now().UTC()
	for k, v := range s.plans {
		if now.Sub(v.CreatedAt) > planTTL {
			delete(s.plans, k)
		}
	}
	s.plans[plan.ID] = *plan
	s.mu.Unlock()

	// Cap the preview entries to keep responses bounded.
	if len(plan.Entries) > 50 {
		plan.Entries = plan.Entries[:50]
	}
	return plan, nil
}

func sameParent(a, b canonical.ParentRef) bool {
	if a.Type != b.Type {
		return false
	}
	if a.Type == canonical.ParentTypeNode {
		return a.NodeID == b.NodeID
	}
	return a.RootKey == b.RootKey
}

// Apply re-plans against the concrete target parent with the chosen
// strategy and commits the result through the canonical executor. The
// whole apply — replace deletes plus every merge create — is ONE ChangeSet
// with an atomic Before Image, so it can be undone as a whole (doc 15 §8).
func (s *Service) Apply(ctx context.Context, user canonical.UserID, space canonical.SpaceID, planID string, parent canonical.ParentRef, strategy string) (ApplyResult, error) {
	s.mu.Lock()
	plan, ok := s.plans[planID]
	expired := ok && time.Since(plan.CreatedAt) > planTTL
	if expired {
		delete(s.plans, planID)
	}
	s.mu.Unlock()
	if !ok || expired || plan.SpaceID != string(space) {
		return ApplyResult{}, ErrPlanNotFound
	}
	if strategy != "merge" && strategy != "replace" {
		return ApplyResult{}, ErrInvalidStrategy
	}

	// Capture a safety backup before a root-level replace import overwrites
	// existing bookmarks (doc 11 §9). Runs outside the canonical write tx
	// because backup capture reads and writes its own catalog row; it does
	// not mutate space revision or epoch.
	if strategy == "replace" && parent.Type == canonical.ParentTypeRoot && s.SafetyBackup != nil {
		sp, existingNodes, _, err := s.trees.SnapshotTree(ctx, space)
		if err != nil {
			return ApplyResult{}, err
		}
		if sp.Epoch != plan.BoundEpoch || sp.CurrentRevision != plan.BoundRevision {
			return ApplyResult{}, ErrPlanStale
		}
		if len(existingNodes) > 0 {
			if err := s.SafetyBackup(ctx, space); err != nil {
				return ApplyResult{}, err
			}
		}
	}

	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}
	tx, err := s.writer.BeginTx(ctx)
	if err != nil {
		return ApplyResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	// Re-verify epoch AND revision inside the write transaction so concurrent
	// writes or backup restores cannot slip between preview and apply.
	sp, err := tx.LoadSpace(ctx, space)
	if err != nil {
		return ApplyResult{}, err
	}
	if sp.Epoch != plan.BoundEpoch || sp.CurrentRevision != plan.BoundRevision {
		return ApplyResult{}, ErrPlanStale
	}

	// When importing a multi-slot native JSON export to a space root, preserve
	// each top-level node's RootKey whenever that root slot exists in the space.
	multiSlot := false
	targetParents := []canonical.ParentRef{parent}
	routeFor := func(c ImportNode) canonical.ParentRef { return parent }
	if plan.Format == FormatNativeJSON && parent.Type == canonical.ParentTypeRoot {
		distinctKeys := map[string]bool{}
		for _, c := range plan.Tree.Children {
			if c.RootKey != "" {
				distinctKeys[c.RootKey] = true
			}
		}
		if len(distinctKeys) > 1 {
			validSlots := map[string]bool{}
			seenParent := map[string]bool{}
			targetParents = nil
			for rk := range distinctKeys {
				if _, err := tx.LoadRootSlot(ctx, space, rk); err == nil {
					validSlots[rk] = true
					if !seenParent[rk] {
						seenParent[rk] = true
						targetParents = append(targetParents, canonical.NewRootParent(rk))
					}
				}
			}
			if len(validSlots) > 1 {
				multiSlot = true
				if !seenParent[parent.RootKey] {
					targetParents = append(targetParents, parent)
				}
				routeFor = func(c ImportNode) canonical.ParentRef {
					if c.RootKey != "" && validSlots[c.RootKey] {
						return canonical.NewRootParent(c.RootKey)
					}
					return parent
				}
			} else {
				targetParents = []canonical.ParentRef{parent}
			}
		}
	}

	rec := s.changesets.BeginBatch(space, changeset.KindImport, origin, true)

	var res ApplyResult
	if strategy == "replace" {
		// Replace clears the target's children first — as journaled,
		// tombstoned DeleteNode commands so sync clients observe the
		// removal and the undo has a full Before Image.
		for _, tp := range targetParents {
			children, err := tx.Children(ctx, space, tp)
			if err != nil {
				return ApplyResult{}, err
			}
			for _, child := range children {
				ids, err := tx.SubtreeIDs(ctx, space, child.ID)
				if err != nil {
					return ApplyResult{}, err
				}
				if err := rec.Apply(ctx, tx, canonical.DeleteNode{SpaceID: space, NodeID: child.ID}); err != nil {
					return ApplyResult{}, err
				}
				res.Deleted += int64(len(ids))
			}
		}
	}

	// Merge matcher built per level: each reused folder re-indexes its own
	// children so deep merges match on the real target contents.
	newID := func() (canonical.NodeID, error) {
		id, err := uuid.NewV7()
		if err != nil {
			return "", err
		}
		return canonical.NodeID(id.String()), nil
	}
	indexChildren := func(parent canonical.ParentRef) (byTitle map[string]canonical.NodeID, byURL map[string]canonical.NodeID, err error) {
		children, err := tx.Children(ctx, space, parent)
		if err != nil {
			return nil, nil, err
		}
		byTitle = map[string]canonical.NodeID{}
		byURL = map[string]canonical.NodeID{}
		for _, c := range children {
			if c.Type == canonical.NodeTypeFolder {
				byTitle[c.Title] = c.ID
			} else {
				byURL[c.URL] = c.ID
			}
		}
		return byTitle, byURL, nil
	}
	var walk func(n ImportNode, parent canonical.ParentRef, byTitle, byURL map[string]canonical.NodeID) error
	walk = func(n ImportNode, parent canonical.ParentRef, byTitle, byURL map[string]canonical.NodeID) error {
		for _, c := range n.Children {
			if c.URL == "" {
				if existing, ok := byTitle[c.Title]; ok {
					res.Kept++
					// Recurse into the existing folder with a fresh index
					// of its actual children.
					subTitle, subURL, err := indexChildren(canonical.NewNodeParent(existing))
					if err != nil {
						return err
					}
					if err := walk(c, canonical.NewNodeParent(existing), subTitle, subURL); err != nil {
						return err
					}
					continue
				}
				id, err := newID()
				if err != nil {
					return err
				}
				if err := rec.Apply(ctx, tx, canonical.CreateNode{
					SpaceID: space, NodeID: id, Type: canonical.NodeTypeFolder,
					Title: c.Title, Parent: parent,
				}); err != nil {
					return err
				}
				byTitle[c.Title] = id
				res.Created++
				empty := map[string]canonical.NodeID{}
				if err := walk(c, canonical.NewNodeParent(id), empty, empty); err != nil {
					return err
				}
				continue
			}
			if _, ok := byURL[c.URL]; ok {
				res.Kept++
				continue
			}
			id, err := newID()
			if err != nil {
				return err
			}
			if err := rec.Apply(ctx, tx, canonical.CreateNode{
				SpaceID: space, NodeID: id, Type: canonical.NodeTypeBookmark,
				Title: c.Title, URL: c.URL, Parent: parent,
			}); err != nil {
				return err
			}
			byURL[c.URL] = id
			res.Created++
		}
		return nil
	}

	if multiSlot {
		type slotIdx struct {
			byTitle map[string]canonical.NodeID
			byURL   map[string]canonical.NodeID
		}
		indexes := map[string]*slotIdx{}
		for _, c := range plan.Tree.Children {
			tp := routeFor(c)
			idx, ok := indexes[tp.RootKey]
			if !ok {
				bt, bu, err := indexChildren(tp)
				if err != nil {
					return ApplyResult{}, err
				}
				idx = &slotIdx{byTitle: bt, byURL: bu}
				indexes[tp.RootKey] = idx
			}
			if err := walk(ImportNode{Children: []ImportNode{c}}, tp, idx.byTitle, idx.byURL); err != nil {
				return ApplyResult{}, err
			}
		}
	} else {
		byTitle, byURL, err := indexChildren(parent)
		if err != nil {
			return ApplyResult{}, err
		}
		if err := walk(*plan.Tree, parent, byTitle, byURL); err != nil {
			return ApplyResult{}, err
		}
	}

	summary := fmt.Sprintf("导入合并：新增 %d 项", res.Created)
	if strategy == "replace" {
		summary = fmt.Sprintf("导入替换：删除 %d 项，新增 %d 项", res.Deleted, res.Created)
	}
	if _, err := rec.Finish(ctx, tx, summary); err != nil {
		return ApplyResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ApplyResult{}, err
	}
	committed = true

	s.mu.Lock()
	delete(s.plans, planID)
	s.mu.Unlock()
	return res, nil
}

// Service-level errors mapped by the HTTP layer.
var (
	ErrPlanNotFound    = errors.New("transfer: plan not found or expired")
	ErrPlanStale       = errors.New("transfer: plan is stale, re-run the preview")
	ErrInvalidStrategy = errors.New("transfer: strategy must be merge or replace")
)
