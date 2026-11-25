package reconcile

import (
	"errors"
	"sort"
)

// Strategy controls how target-only subtrees are treated (doc 07 §5).
type Strategy string

const (
	// StrategyMerge keeps target-only subtrees. Matched nodes take the
	// source state; source-only nodes are created.
	StrategyMerge Strategy = "merge"
	// StrategyReplace deletes target-only subtrees.
	StrategyReplace Strategy = "replace"
	// StrategyPreserve keeps target-only subtrees but also keeps the
	// target state on matched nodes: recovery protects new source data
	// without overwriting newer server state (doc 06 §11).
	StrategyPreserve Strategy = "preserve"
)

// Placement controls how a source root lands under its matched target
// root (doc 07 §6).
type Placement string

const (
	// PlacementContents applies the source root's children under the
	// matched target root. This is the initial-sync placement.
	PlacementContents Placement = "contents"
	// PlacementChild makes the source root itself a new folder child of
	// the matched target root. Used by imports.
	PlacementChild Placement = "child"
)

// Policy controls desired-tree construction.
type Policy struct {
	Strategy  Strategy
	Placement Placement
}

// Decisions resolve ambiguities: source ref → chosen target ref. A
// missing entry or empty choice keeps the safe default: no match, the
// source node is created as a duplicate.
type Decisions map[string]string

// Errors.
var (
	// ErrUnmappedRoot is returned when a source root carries no root slot
	// key: the engine refuses to invent a placement.
	ErrUnmappedRoot = errors.New("reconcile: source root has no root slot key")
	// ErrUnknownRoot is returned when a source root references a root slot
	// the target tree does not have.
	ErrUnknownRoot = errors.New("reconcile: source root references unknown root slot")
	// ErrDuplicateRootKey is returned when two source roots map to the
	// same root slot.
	ErrDuplicateRootKey = errors.New("reconcile: duplicate source root key")
	// ErrDecisionInvalid is returned when a decision selects a target that
	// was not offered as a candidate.
	ErrDecisionInvalid = errors.New("reconcile: decision does not match any candidate")
)

// DesiredNode is a node of the desired tree, keyed by canonical id.
type DesiredNode struct {
	ID        string // canonical id; freshly generated for created nodes
	ParentRef string // RootRef(key) or parent folder canonical id
	Type      NodeType
	Title     string
	URL       string
	SourceRef string // source tree linkage; empty for kept target-only nodes
	// LocalOnly marks a browser-only node preserved during a non-mutating
	// recovery (StrategyPreserve). It stays in the desired tree so the client
	// planner never deletes it from the browser, but carries no server-side
	// canonical identity and receives no assign_identity step (R30).
	LocalOnly bool
}

// DesiredTree is the post-reconciliation state of the target space. Root
// slots themselves are containers, not nodes: their children live under
// RootRef(key).
type DesiredTree struct {
	Nodes map[string]*DesiredNode
	Order map[string][]string // container ref → desired child order
}

// Children returns the desired child order of a container.
func (d *DesiredTree) Children(container string) []string { return d.Order[container] }

// IDGenerator allocates canonical ids for created nodes.
type IDGenerator func() (string, error)

// applyDecisions folds user decisions into the match result so that a
// decided ambiguous node follows the same path as a matched one. An explicit
// empty choice ("") or "duplicate" resolves the ambiguity as the safe default
// (unmatched / duplicate create) and removes it from Ambiguous. When a folder
// ambiguity is resolved to a target folder, its children are recursively
// matched so its contents are not duplicated (R31, R33).
func applyDecisions(m *MatchResult, decisions Decisions) error {
	if len(decisions) == 0 || len(m.Ambiguous) == 0 {
		return nil
	}
	srcIdx, err := m.Source.index()
	if err != nil {
		return err
	}
	tgtIdx, err := m.Target.index()
	if err != nil {
		return err
	}

	// Loop until a pass resolves no further ambiguities (resolving a folder
	// may surface child ambiguities that the caller also answered).
	for {
		pending := m.Ambiguous
		m.Ambiguous = nil
		kept := make([]Ambiguity, 0, len(pending))
		progressed := false

		for _, a := range pending {
			choice, ok := decisions[a.SourceRef]
			if !ok {
				kept = append(kept, a)
				continue
			}
			progressed = true
			if choice == "" || choice == "duplicate" {
				// Explicit safe default: treat as source-only (duplicate create).
				continue
			}
			valid := false
			for _, c := range a.Candidates {
				if c == choice {
					valid = true
					break
				}
			}
			if !valid {
				return ErrDecisionInvalid
			}
			// Target must not already be claimed by another source node.
			if claim, taken := m.ByTarget[choice]; taken && claim != a.SourceRef {
				return ErrDecisionInvalid
			}
			m.link(a.SourceRef, choice)
			// Match children of a newly paired folder so its contents merge
			// instead of being duplicated (R33).
			if sn := srcIdx.byRef[a.SourceRef]; sn.Type == NodeFolder {
				m.matchChildren(srcIdx, tgtIdx, a.SourceRef, choice)
			}
		}

		// Any new child ambiguities added by matchChildren sit in m.Ambiguous.
		newlyFound := m.Ambiguous
		m.Ambiguous = append(kept, newlyFound...)
		if !progressed || len(newlyFound) == 0 {
			break
		}
	}

	m.classify(srcIdx, tgtIdx)
	return nil
}

// foldDecisions returns a private copy of the match result with the user
// decisions folded in as resolved pairs. The input is never mutated, so
// the same result can be replanned with different decisions.
func foldDecisions(m *MatchResult, decisions Decisions) (*MatchResult, error) {
	mc := *m
	mc.Pairs = append([]Pair(nil), m.Pairs...)
	mc.SourceOnly = append([]string(nil), m.SourceOnly...)
	mc.TargetOnly = append([]string(nil), m.TargetOnly...)
	mc.Ambiguous = append([]Ambiguity(nil), m.Ambiguous...)
	mc.BySource = make(map[string]string, len(m.BySource))
	for k, v := range m.BySource {
		mc.BySource[k] = v
	}
	mc.ByTarget = make(map[string]string, len(m.ByTarget))
	for k, v := range m.ByTarget {
		mc.ByTarget[k] = v
	}
	if err := applyDecisions(&mc, decisions); err != nil {
		return nil, err
	}
	return &mc, nil
}

// BuildDesired constructs the desired tree from a match result. Matched
// nodes keep their canonical identity; source-only and undecided
// ambiguous nodes get fresh ids; target-only nodes are kept (merge,
// preserve) or dropped (replace).
func BuildDesired(m *MatchResult, policy Policy, decisions Decisions, newID IDGenerator) (*DesiredTree, error) {
	m, err := foldDecisions(m, decisions)
	if err != nil {
		return nil, err
	}
	if policy.Placement == "" {
		policy.Placement = PlacementContents
	}
	srcIdx, err := m.Source.index()
	if err != nil {
		return nil, err
	}
	tgtIdx, err := m.Target.index()
	if err != nil {
		return nil, err
	}

	d := &DesiredTree{
		Nodes: map[string]*DesiredNode{},
		Order: map[string][]string{},
	}

	// keepSubtree copies a target-only subtree into the desired tree,
	// preserving the target structure and identity.
	var keepSubtree func(tref, container string) error
	keepSubtree = func(tref, container string) error {
		tn := tgtIdx.byRef[tref]
		id := tn.CanonicalID
		if id == "" {
			return ErrUnknownRoot
		}
		if _, exists := d.Nodes[id]; exists {
			return nil // already placed via a decision
		}
		d.Nodes[id] = &DesiredNode{
			ID:        id,
			ParentRef: container,
			Type:      tn.Type,
			Title:     tn.Title,
			URL:       tn.URL,
		}
		d.Order[container] = append(d.Order[container], id)
		for _, child := range tgtIdx.children[tref] {
			if _, matched := m.ByTarget[child]; matched {
				continue // matched children are handled by the source walk
			}
			if err := keepSubtree(child, id); err != nil {
				return err
			}
		}
		return nil
	}

	// walkSource resolves one source node under the given container.
	var walkSource func(sref, container string) error
	walkSource = func(sref, container string) error {
		sn := srcIdx.byRef[sref]
		if tref, ok := m.BySource[sref]; ok {
			tn := tgtIdx.byRef[tref]
			id := tn.CanonicalID
			if id == "" {
				return ErrUnknownRoot
			}
			if _, exists := d.Nodes[id]; exists {
				return nil // already placed via a decision
			}
			state := sn // merge: source state wins
			if policy.Strategy == StrategyPreserve {
				state = tn // recovery: keep the newer server state
			}
			d.Nodes[id] = &DesiredNode{
				ID:        id,
				ParentRef: container,
				Type:      state.Type,
				Title:     state.Title,
				URL:       state.URL,
				SourceRef: sn.Ref,
			}
			d.Order[container] = append(d.Order[container], id)
			// Merge and preserve keep target-only children of the matched
			// counterpart after the source-derived children.
			if policy.Strategy != StrategyReplace {
				for _, tc := range tgtIdx.children[tref] {
					if _, matched := m.ByTarget[tc]; matched {
						continue
					}
					if err := keepSubtree(tc, id); err != nil {
						return err
					}
				}
			}
			for _, sc := range srcIdx.children[sn.Ref] {
				if err := walkSource(sc, id); err != nil {
					return err
				}
			}
			return nil
		}
		// Source-only: keep the node's canonical identity when it carries
		// one (full resync: server nodes keep their ids) and it does not
		// collide with the target tree; otherwise allocate a fresh one.
		id := sn.CanonicalID
		if id != "" {
			if _, clash := tgtIdx.byRef[id]; clash {
				id = ""
			}
			if _, clash := tgtIdx.byCID[id]; clash {
				id = ""
			}
		}
		if id == "" {
			var err error
			if id, err = newID(); err != nil {
				return err
			}
		}
		d.Nodes[id] = &DesiredNode{
			ID:        id,
			ParentRef: container,
			Type:      sn.Type,
			Title:     sn.Title,
			URL:       sn.URL,
			SourceRef: sn.Ref,
			// In StrategyPreserve (mapping-lost recovery), the server commits
			// no canonical creates; unmatched browser nodes stay local-only so
			// the client neither deletes them nor assigns them phantom UUIDs.
			LocalOnly: policy.Strategy == StrategyPreserve,
		}
		d.Order[container] = append(d.Order[container], id)
		for _, sc := range srcIdx.children[sn.Ref] {
			if err := walkSource(sc, id); err != nil {
				return err
			}
		}
		return nil
	}

	// Source roots.
	tgtRoots := tgtIdx.rootByKeys()
	seenKeys := map[string]bool{}
	var sawRoot bool
	for _, root := range srcIdx.byRef {
		if root.Type != NodeRoot {
			continue
		}
		sawRoot = true
		if seenKeys[root.RootKey] {
			return nil, ErrDuplicateRootKey
		}
		seenKeys[root.RootKey] = true
		container := RootRef(root.RootKey)
		if _, ok := tgtRoots[root.RootKey]; !ok {
			return nil, ErrUnknownRoot
		}
		if policy.Placement == PlacementChild {
			// The source root itself becomes a new folder under the slot.
			id, err := newID()
			if err != nil {
				return nil, err
			}
			d.Nodes[id] = &DesiredNode{
				ID:        id,
				ParentRef: container,
				Type:      NodeFolder,
				Title:     root.Title,
				SourceRef: root.Ref,
			}
			d.Order[container] = append(d.Order[container], id)
			for _, sc := range srcIdx.children[root.Ref] {
				if err := walkSource(sc, id); err != nil {
					return nil, err
				}
			}
			continue
		}
		// Contents placement: children merge under the slot container.
		for _, sc := range srcIdx.children[root.Ref] {
			if err := walkSource(sc, container); err != nil {
				return nil, err
			}
		}
		// Merge and preserve keep target-only children of the slot itself.
		if policy.Strategy != StrategyReplace {
			tgtRoot := tgtRoots[root.RootKey]
			for _, tc := range tgtIdx.children[tgtRoot.Ref] {
				if _, matched := m.ByTarget[tc]; matched {
					continue
				}
				if err := keepSubtree(tc, container); err != nil {
					return nil, err
				}
			}
		}
	}
	if !sawRoot {
		return nil, ErrUnmappedRoot
	}

	// Replace drops unmatched target subtrees: they never enter the
	// desired tree, and the planner deletes them.
	return d, nil
}

// Containers returns the container refs of the desired tree top-down:
// root slots first, then folders before their children.
func (d *DesiredTree) Containers() []string {
	roots := []string{}
	for container := range d.Order {
		if isRootRef(container) {
			roots = append(roots, container)
		}
	}
	sort.Strings(roots)
	out := make([]string, 0, len(d.Order))
	var collect func(container string)
	collect = func(container string) {
		out = append(out, container)
		for _, id := range d.Order[container] {
			if _, isContainer := d.Order[id]; isContainer {
				collect(id)
			}
		}
	}
	for _, r := range roots {
		collect(r)
	}
	return out
}

func isRootRef(ref string) bool {
	return len(ref) > 5 && ref[:5] == "root:"
}
