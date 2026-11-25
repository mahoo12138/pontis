package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"pontis/internal/backup"
	"pontis/internal/canonical"
	"pontis/internal/changeset"
	"pontis/internal/device"
	"pontis/internal/reconcile"
)

// setupReconcileTest returns a reconciliation service over one space
// (s1, root slot "main").
func setupReconcileTest(t *testing.T) (*reconcile.Service, *reconcileDeps) {
	t.Helper()
	db := openTestDB(t)
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	for _, stmt := range []string{testUser, testSpace, testRootSlot} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	return reconcile.NewService(NewReconcileStore(db), changeset.NewService(NewChangeSetStore(db))), &reconcileDeps{t: t, db: db}
}

type reconcileDeps struct {
	t  *testing.T
	db *sql.DB
}

// registerPendingBinding registers a device and binds it to s1 without
// activating: the binding stays pending_initial.
func (d *reconcileDeps) registerPendingBinding(name string) (deviceID, bindingID string) {
	d.t.Helper()
	devSvc := device.NewService(NewDeviceStore(d.db))
	dev, _, err := devSvc.RegisterDevice(context.Background(), "u1", name, "extension", "edge", "windows")
	if err != nil {
		d.t.Fatal(err)
	}
	binding, err := devSvc.BindSpace(context.Background(), dev.ID, canonical.SpaceID("s1"))
	if err != nil {
		d.t.Fatal(err)
	}
	return dev.ID, binding.ID
}

func (d *reconcileDeps) activateBinding(bindingID string) {
	d.t.Helper()
	if _, err := d.db.Exec(`UPDATE device_space_bindings SET state = 'active', initialized_at = '2026-01-01T00:00:00Z' WHERE id = ?`, bindingID); err != nil {
		d.t.Fatal(err)
	}
}

func (d *reconcileDeps) bindingWatermarks(bindingID string) (state string, epoch, applied, received int64) {
	d.t.Helper()
	err := d.db.QueryRow(`SELECT state, epoch, applied_revision, received_revision FROM device_space_bindings WHERE id = ?`, bindingID).
		Scan(&state, &epoch, &applied, &received)
	if err != nil {
		d.t.Fatal(err)
	}
	return
}

// mustNode loads a canonical node through a read transaction.
func (d *reconcileDeps) mustNode(id canonical.NodeID) canonical.Node {
	d.t.Helper()
	ctx := context.Background()
	tx, err := NewStore(d.db).BeginTx(ctx)
	if err != nil {
		d.t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	node, err := tx.LoadNode(ctx, "s1", id)
	if err != nil {
		d.t.Fatalf("node %s: %v", id, err)
	}
	return node
}

// clientSnapshot builds a client snapshot in the doc 08 §10 wire shape.
func clientSnapshot(roots []reconcile.ClientRootJSON, nodes []reconcile.ClientNodeJSON) reconcile.ClientSnapshotJSON {
	return reconcile.ClientSnapshotJSON{Epoch: 0, Revision: 0, Roots: roots, Nodes: nodes}
}

func initialBrowserSnapshot() reconcile.ClientSnapshotJSON {
	return clientSnapshot(
		[]reconcile.ClientRootJSON{{LocalRef: "l_bar", RootKey: "main", Title: "Bar"}},
		[]reconcile.ClientNodeJSON{
			{LocalRef: "l_f1", ParentLocalRef: "l_bar", Type: "folder", Title: "Development"},
			{LocalRef: "l_b1", ParentLocalRef: "l_f1", Type: "bookmark", Title: "GitHub", URL: "https://github.com"},
		},
	)
}

func TestReconcileInitialFlow(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")

	sess, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "first pairing")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if _, _, err := svc.Plan(ctx, sess.ID); !errors.Is(err, reconcile.ErrSnapshotMissing) {
		t.Fatalf("plan before snapshots = %v, want ErrSnapshotMissing", err)
	}

	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, initialBrowserSnapshot()); err != nil {
		t.Fatalf("SubmitClientSnapshot: %v", err)
	}
	snap, err := svc.CreateServerSnapshot(ctx, bindingID)
	if err != nil {
		t.Fatalf("CreateServerSnapshot: %v", err)
	}
	if snap.Epoch != 1 || snap.Revision != 0 || snap.NodeCount != 1 {
		t.Fatalf("snapshot = %+v, want epoch 1 revision 0 with one root node", snap)
	}

	updated, issues, err := svc.Plan(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if len(issues) != 0 {
		t.Fatalf("clean merge must not raise issues: %+v", issues)
	}
	if updated.State != reconcile.StateRunning || updated.Phase != reconcile.PhasePlanned {
		t.Fatalf("state/phase = %s/%s, want running/planned", updated.State, updated.Phase)
	}

	steps, err := svc.Steps(ctx, sess.ID)
	if !errors.Is(err, reconcile.ErrInvalidSessionState) {
		t.Fatalf("steps before commit = %v, want ErrInvalidSessionState", err)
	}

	committed, err := svc.Commit(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if !committed.ServerCommitted || committed.CommitRevision != 2 {
		t.Fatalf("commit state: %+v", committed)
	}

	// The canonical tree now holds the imported browser nodes under the
	// pre-assigned ids the steps hand out.
	steps, err = svc.Steps(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Steps: %v", err)
	}
	ids := map[string]string{} // local ref → canonical id
	for _, step := range steps.Steps {
		if step.Kind != reconcile.StepAssignIdentity {
			t.Fatalf("empty-server initial merge must only assign identities: %+v", step)
		}
		ids[step.LocalRef] = step.CanonicalID
	}
	if len(ids) != 2 {
		t.Fatalf("want two identity assignments, got %v", ids)
	}
	folder := deps.mustNode(canonical.NodeID(ids["l_f1"]))
	if folder.Parent.RootKey != "main" || folder.Title != "Development" {
		t.Fatalf("folder node: %+v", folder)
	}
	bookmark := deps.mustNode(canonical.NodeID(ids["l_b1"]))
	if bookmark.Parent.NodeID != folder.ID || bookmark.URL != "https://github.com" {
		t.Fatalf("bookmark node: %+v", bookmark)
	}

	// Journal entries carry the reconciliation origin for same-binding
	// bookkeeping.
	var originType, originBinding string
	if err := deps.db.QueryRow(`SELECT origin_type, COALESCE(origin_binding_id, '') FROM journal WHERE space_id = 's1' AND revision = 1`).
		Scan(&originType, &originBinding); err != nil {
		t.Fatal(err)
	}
	if originType != "reconciliation" || originBinding != bindingID {
		t.Fatalf("journal origin = %s/%s", originType, originBinding)
	}

	done, err := svc.Complete(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if done.State != reconcile.StateCompleted {
		t.Fatalf("state = %s", done.State)
	}
	state, epoch, applied, received := deps.bindingWatermarks(bindingID)
	if state != "active" || epoch != 1 || applied != 2 || received != 2 {
		t.Fatalf("binding watermarks = %s %d %d %d", state, epoch, applied, received)
	}

	// A second session of the same type is no longer eligible.
	if _, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "again"); !errors.Is(err, reconcile.ErrBindingNotEligible) {
		t.Fatalf("second initial session = %v, want ErrBindingNotEligible", err)
	}
}

func TestReconcileOneActiveSessionPerBinding(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")

	if _, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "first"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "second"); !errors.Is(err, reconcile.ErrActiveSessionExists) {
		t.Fatalf("second session = %v, want ErrActiveSessionExists", err)
	}
}

func TestReconcilePlanStale(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")

	sess, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "pairing")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, initialBrowserSnapshot()); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateServerSnapshot(ctx, bindingID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Plan(ctx, sess.ID); err != nil {
		t.Fatal(err)
	}

	// The canonical head advances after the plan was computed.
	seedSystem(t, deps.db, canonical.CreateNode{
		SpaceID: "s1", NodeID: "nX", Type: canonical.NodeTypeBookmark,
		Title: "Late", URL: "https://late.example", Parent: canonical.NewRootParent("main"),
	})

	if _, err := svc.Commit(ctx, sess.ID); !errors.Is(err, reconcile.ErrPlanStale) {
		t.Fatalf("commit = %v, want ErrPlanStale", err)
	}
	// Re-planning against the new head succeeds.
	if _, _, err := svc.Plan(ctx, sess.ID); err != nil {
		t.Fatalf("re-plan: %v", err)
	}
	if _, err := svc.Commit(ctx, sess.ID); err != nil {
		t.Fatalf("commit after re-plan: %v", err)
	}
}

func TestReconcileServerSnapshotStable(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")
	deps.activateBinding(bindingID)

	if _, err := svc.CreateSession(ctx, bindingID, reconcile.TypeFullResync, "drift"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, clientSnapshot(nil, nil)); err != nil {
		t.Fatal(err)
	}
	snap, err := svc.CreateServerSnapshot(ctx, bindingID)
	if err != nil {
		t.Fatal(err)
	}
	if snap.NodeCount != 1 {
		t.Fatalf("node count = %d, want 1 (root only)", snap.NodeCount)
	}
	before, err := NewReconcileStore(deps.db).ListSnapshotNodes(ctx, snap.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}

	// Canonical writes after the snapshot must not leak into it.
	seedSystem(t, deps.db, canonical.CreateNode{
		SpaceID: "s1", NodeID: "n1", Type: canonical.NodeTypeBookmark,
		Title: "New", URL: "https://new.example", Parent: canonical.NewRootParent("main"),
	})
	after, err := NewReconcileStore(deps.db).ListSnapshotNodes(ctx, snap.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != len(after) {
		t.Fatalf("snapshot mutated: %d → %d nodes", len(before), len(after))
	}
}

func TestReconcileMergePlan(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")

	// Canonical side: Development/Go.
	seedSystem(t, deps.db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "n1", Type: canonical.NodeTypeFolder,
			Title: "Development", Parent: canonical.NewRootParent("main")},
		canonical.CreateNode{SpaceID: "s1", NodeID: "n2", Type: canonical.NodeTypeBookmark,
			Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("n1")},
	)

	snapshot := clientSnapshot(
		[]reconcile.ClientRootJSON{{LocalRef: "l_bar", RootKey: "main", Title: "Bar"}},
		[]reconcile.ClientNodeJSON{
			{LocalRef: "l_f1", ParentLocalRef: "l_bar", Type: "folder", Title: "Development"},
			{LocalRef: "l_b1", ParentLocalRef: "l_f1", Type: "bookmark", Title: "Go (renamed)", URL: "https://go.dev"},
			{LocalRef: "l_b2", ParentLocalRef: "l_f1", Type: "bookmark", Title: "Browser only", URL: "https://only.example"},
		},
	)

	sess, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "pairing")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateServerSnapshot(ctx, bindingID); err != nil {
		t.Fatal(err)
	}
	_, _, err = svc.Plan(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if _, err := svc.Commit(ctx, sess.ID); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// Matched bookmark: source title wins through an UPDATE.
	n2 := deps.mustNode("n2")
	if n2.Title != "Go (renamed)" {
		t.Fatalf("matched node title = %q", n2.Title)
	}
	// Browser-only bookmark was created under the matched folder.
	var count int
	if err := deps.db.QueryRow(`SELECT COUNT(*) FROM nodes WHERE space_id = 's1' AND url = 'https://only.example'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("browser-only bookmark missing (count=%d)", count)
	}
}

func TestReconcileAmbiguityDecision(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")

	// Two identical bookmarks on the server: the browser counterpart is
	// ambiguous and must not be guessed (doc 06 §6).
	seedSystem(t, deps.db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "t1", Type: canonical.NodeTypeBookmark,
			Title: "First", URL: "https://x.example", Parent: canonical.NewRootParent("main")},
		canonical.CreateNode{SpaceID: "s1", NodeID: "t2", Type: canonical.NodeTypeBookmark,
			Title: "Second", URL: "https://x.example", Parent: canonical.NewRootParent("main")},
	)

	snapshot := clientSnapshot(
		[]reconcile.ClientRootJSON{{LocalRef: "l_bar", RootKey: "main", Title: "Bar"}},
		[]reconcile.ClientNodeJSON{
			{LocalRef: "l_b1", ParentLocalRef: "l_bar", Type: "bookmark", Title: "Same", URL: "https://x.example"},
		},
	)

	sess, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "pairing")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateServerSnapshot(ctx, bindingID); err != nil {
		t.Fatal(err)
	}
	sess, issues, err := svc.Plan(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if sess.State != reconcile.StateWaitingUser || len(issues) != 1 {
		t.Fatalf("state = %s issues = %d, want waiting_user with one issue", sess.State, len(issues))
	}
	if len(issues[0].Payload.Candidates) != 2 {
		t.Fatalf("candidates: %+v", issues[0])
	}

	// The user picks t2 as the real counterpart.
	updated, _, err := svc.Decide(ctx, sess.ID, map[string]string{issues[0].ID: "t2"})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if updated.State != reconcile.StateRunning {
		t.Fatalf("state after decision = %s, want running", updated.State)
	}
	if _, err := svc.Commit(ctx, sess.ID); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// t2 keeps its identity and takes the source title; t1 survives as a
	// target-only keep (merge never deletes).
	t2 := deps.mustNode("t2")
	if t2.Title != "Same" {
		t.Fatalf("t2 title = %q, want the source title", t2.Title)
	}
	t1 := deps.mustNode("t1")
	if t1.Title != "First" {
		t.Fatalf("t1 title = %q", t1.Title)
	}
}

func TestReconcileFullResyncFlow(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")
	deps.activateBinding(bindingID)

	seedSystem(t, deps.db, canonical.CreateNode{SpaceID: "s1", NodeID: "n1", Type: canonical.NodeTypeBookmark,
		Title: "Server", URL: "https://srv.example", Parent: canonical.NewRootParent("main")})

	// Browser holds the mapped node plus one local extra that full resync
	// drops (no pending intent by definition of a resync).
	snapshot := clientSnapshot(
		[]reconcile.ClientRootJSON{{LocalRef: "l_bar", RootKey: "main", Title: "Bar"}},
		[]reconcile.ClientNodeJSON{
			{LocalRef: "l1", ParentLocalRef: "l_bar", Type: "bookmark", Title: "Server", URL: "https://srv.example", CanonicalID: "n1"},
			{LocalRef: "l2", ParentLocalRef: "l_bar", Type: "bookmark", Title: "Local extra", URL: "https://extra.example"},
		},
	)

	sess, err := svc.CreateSession(ctx, bindingID, reconcile.TypeFullResync, "history expired")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, snapshot); err != nil {
		t.Fatal(err)
	}
	snap, err := svc.CreateServerSnapshot(ctx, bindingID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Plan(ctx, sess.ID); err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if _, err := svc.Commit(ctx, sess.ID); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// The commit must not have touched the canonical tree.
	var revision int64
	if err := deps.db.QueryRow(`SELECT current_revision FROM sync_spaces WHERE id = 's1'`).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if revision != 1 {
		t.Fatalf("resync commit changed the canonical revision to %d", revision)
	}

	steps, err := svc.Steps(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Steps: %v", err)
	}
	deletes := 0
	for _, step := range steps.Steps {
		if step.Kind == reconcile.StepDelete && step.LocalRef == "l2" {
			deletes++
		}
	}
	if deletes != 1 {
		t.Fatalf("resync must delete the browser-only node: %+v", steps.Steps)
	}

	done, err := svc.Complete(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if done.CommitRevision != 1 {
		t.Fatalf("commit revision = %d, want 1", done.CommitRevision)
	}
	state, _, applied, received := deps.bindingWatermarks(bindingID)
	if state != "active" || applied != snap.Revision || received != snap.Revision {
		t.Fatalf("watermarks after resync = %s %d %d, want snapshot revision %d", state, applied, received, snap.Revision)
	}
}

// A backup restore rebuilds the space underneath an open reconciliation: new
// epoch, revision 0, every binding back to pending_initial. That session now
// describes a tree that no longer exists, and letting it finish would hand the
// new baseline a watermark it never reached and activate a binding that still
// owes its initialization (doc 06 §8).
func TestRestoreSupersedesAnOpenReconciliation(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")
	deps.activateBinding(bindingID)

	seedSystem(t, deps.db, canonical.CreateNode{SpaceID: "s1", NodeID: "n1", Type: canonical.NodeTypeBookmark,
		Title: "Server", URL: "https://srv.example", Parent: canonical.NewRootParent("main")})

	sess, err := svc.CreateSession(ctx, bindingID, reconcile.TypeFullResync, "history expired")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, clientSnapshot(
		[]reconcile.ClientRootJSON{{LocalRef: "l_bar", RootKey: "main", Title: "Bar"}},
		[]reconcile.ClientNodeJSON{
			{LocalRef: "l1", ParentLocalRef: "l_bar", Type: "bookmark", Title: "Server", URL: "https://srv.example", CanonicalID: "n1"},
		},
	)); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateServerSnapshot(ctx, bindingID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Plan(ctx, sess.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Commit(ctx, sess.ID); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// The restore lands: the session is committed but not completed.
	if _, err := NewBackupStore(deps.db).ReplaceBaseline(ctx, "s1",
		[]backup.SlotDTO{{Key: "main", DisplayName: "Main", Position: 0, CreatedAt: "2026-01-01T00:00:00Z"}},
		[]backup.NodeDTO{{ID: "r1", Type: "bookmark", Title: "Restored", URL: ref("https://restored"),
			RootKey: ref("main"), Position: 0,
			CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"}}); err != nil {
		t.Fatalf("ReplaceBaseline: %v", err)
	}

	if after, err := svc.Session(ctx, sess.ID); err != nil {
		t.Fatal(err)
	} else if after.State != reconcile.StateFailed {
		t.Fatalf("session after the restore = %s, want failed", after.State)
	}
	if _, err := svc.Complete(ctx, sess.ID); !errors.Is(err, reconcile.ErrSessionSuperseded) {
		t.Fatalf("complete err = %v, want ErrSessionSuperseded", err)
	}

	// The second layer stands on its own: a request that had already passed
	// the restore's UPDATE must still be refused by the epoch it was frozen
	// against, so the guard cannot lean on the restore alone.
	if _, err := deps.db.ExecContext(ctx,
		`UPDATE reconciliations SET state = 'running', phase = 'planned' WHERE id = ?`, sess.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Complete(ctx, sess.ID); !errors.Is(err, reconcile.ErrSessionSuperseded) {
		t.Fatalf("complete of a re-opened old-epoch session = %v, want ErrSessionSuperseded", err)
	}
	if _, err := svc.Commit(ctx, sess.ID); !errors.Is(err, reconcile.ErrPlanStale) {
		t.Fatalf("commit of an old-epoch session = %v, want ErrPlanStale", err)
	}

	state, epoch, applied, received := deps.bindingWatermarks(bindingID)
	if state != "pending_initial" || epoch != 2 || applied != 0 || received != 0 {
		t.Fatalf("binding = %s epoch %d at %d/%d, want pending_initial at the new baseline",
			state, epoch, applied, received)
	}
}

// R29: Full Resync matches by canonical ID and must NEVER emit an
// assign_identity step whose local_ref is a canonical UUID instead of a client
// snapshot local_ref.
func TestReconcileFullResyncDoesNotEmitBogusAssignIdentity(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Chrome")
	deps.activateBinding(bindingID)

	seedSystem(t, deps.db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "n1", Type: canonical.NodeTypeFolder,
			Title: "Work", Parent: canonical.NewRootParent("main")},
		canonical.CreateNode{SpaceID: "s1", NodeID: "n2", Type: canonical.NodeTypeBookmark,
			Title: "RenamedOnServer", URL: "https://srv.example", Parent: canonical.NewNodeParent("n1")},
		canonical.CreateNode{SpaceID: "s1", NodeID: "n3", Type: canonical.NodeTypeBookmark,
			Title: "ServerOnly", URL: "https://new.example", Parent: canonical.NewNodeParent("n1")},
	)

	snapshot := clientSnapshot(
		[]reconcile.ClientRootJSON{{LocalRef: "l_1", RootKey: "main", Title: "Bar"}},
		[]reconcile.ClientNodeJSON{
			{LocalRef: "l_2", ParentLocalRef: "l_1", Type: "folder", Title: "Work", CanonicalID: "n1"},
			{LocalRef: "l_3", ParentLocalRef: "l_2", Type: "bookmark", Title: "OldLocal", URL: "https://srv.example", CanonicalID: "n2"},
			{LocalRef: "l_4", ParentLocalRef: "l_1", Type: "bookmark", Title: "StaleLocal", URL: "https://stale.example"},
		},
	)
	knownLocalRefs := map[string]bool{"l_1": true, "l_2": true, "l_3": true, "l_4": true}

	sess, err := svc.CreateSession(ctx, bindingID, reconcile.TypeFullResync, "history expired")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateServerSnapshot(ctx, bindingID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Plan(ctx, sess.ID); err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if _, err := svc.Commit(ctx, sess.ID); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	steps, err := svc.Steps(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Steps: %v", err)
	}
	var creates, updates, deletes int
	for _, st := range steps.Steps {
		if st.Kind == reconcile.StepAssignIdentity {
			t.Fatalf("full_resync must not emit assign_identity for already-mapped nodes: %+v", st)
		}
		if st.LocalRef != "" && !knownLocalRefs[st.LocalRef] {
			t.Fatalf("step references unknown local_ref %q (not in client snapshot): %+v", st.LocalRef, st)
		}
		switch st.Kind {
		case reconcile.StepCreate:
			creates++
		case reconcile.StepUpdate:
			updates++
		case reconcile.StepDelete:
			deletes++
		}
	}
	if creates != 1 || updates != 1 || deletes != 1 {
		t.Fatalf("steps counts create=%d update=%d delete=%d, want 1/1/1: %+v", creates, updates, deletes, steps.Steps)
	}
}

// R31 & R33: Empty choice "" converges (duplicate-create), invalid decisions do
// not poison DB state, partial multi-round decisions keep earlier choices, and
// disambiguating folders recursively matches their children.
func TestReconcileDecisionsAndFolderDisambiguation(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Firefox")

	// Two folders with the same name "Dev" on the server, plus two bookmarks with
	// the same URL under root.
	seedSystem(t, deps.db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "fA", Type: canonical.NodeTypeFolder,
			Title: "Dev", Parent: canonical.NewRootParent("main")},
		canonical.CreateNode{SpaceID: "s1", NodeID: "fB", Type: canonical.NodeTypeFolder,
			Title: "Dev", Parent: canonical.NewRootParent("main")},
		canonical.CreateNode{SpaceID: "s1", NodeID: "bInB", Type: canonical.NodeTypeBookmark,
			Title: "Go Docs", URL: "https://go.dev/doc", Parent: canonical.NewNodeParent("fB")},
		canonical.CreateNode{SpaceID: "s1", NodeID: "x1", Type: canonical.NodeTypeBookmark,
			Title: "Dup1", URL: "https://dup.example", Parent: canonical.NewRootParent("main")},
		canonical.CreateNode{SpaceID: "s1", NodeID: "x2", Type: canonical.NodeTypeBookmark,
			Title: "Dup2", URL: "https://dup.example", Parent: canonical.NewRootParent("main")},
	)

	snapshot := clientSnapshot(
		[]reconcile.ClientRootJSON{{LocalRef: "l_bar", RootKey: "main", Title: "Bar"}},
		[]reconcile.ClientNodeJSON{
			{LocalRef: "l_dev", ParentLocalRef: "l_bar", Type: "folder", Title: "Dev"},
			{LocalRef: "l_go", ParentLocalRef: "l_dev", Type: "bookmark", Title: "Go Docs (local)", URL: "https://go.dev/doc"},
			{LocalRef: "l_dup", ParentLocalRef: "l_bar", Type: "bookmark", Title: "Keep Separate", URL: "https://dup.example"},
		},
	)

	sess, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "pairing")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateServerSnapshot(ctx, bindingID); err != nil {
		t.Fatal(err)
	}
	sess, issues, err := svc.Plan(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if sess.State != reconcile.StateWaitingUser || len(issues) != 2 {
		t.Fatalf("want waiting_user with 2 issues, got %s (%d issues)", sess.State, len(issues))
	}

	issueByRef := map[string]reconcile.Issue{}
	for _, iss := range issues {
		issueByRef[iss.Payload.SourceRef] = iss
	}

	// Invalid choice must be rejected without poisoning the issue row.
	if _, _, err := svc.Decide(ctx, sess.ID, map[string]string{issueByRef["l_dev"].ID: "nonexistent"}); !errors.Is(err, reconcile.ErrDecisionInvalid) {
		t.Fatalf("invalid decision err = %v, want ErrDecisionInvalid", err)
	}

	// Round 1: answer only the folder ambiguity (pick fB).
	sess, remaining, err := svc.Decide(ctx, sess.ID, map[string]string{issueByRef["l_dev"].ID: "fB"})
	if err != nil {
		t.Fatalf("Decide round 1: %v", err)
	}
	if sess.State != reconcile.StateWaitingUser || len(remaining) != 1 || remaining[0].Payload.SourceRef != "l_dup" {
		t.Fatalf("after round 1 want 1 remaining issue for l_dup, got state=%s remaining=%+v", sess.State, remaining)
	}

	// Round 2: pick "" (duplicate-create) for l_dup; must converge to running with 0 open issues!
	sess, remaining, err = svc.Decide(ctx, sess.ID, map[string]string{remaining[0].ID: ""})
	if err != nil {
		t.Fatalf("Decide round 2: %v", err)
	}
	if sess.State != reconcile.StateRunning || len(remaining) != 0 {
		t.Fatalf("after round 2 want running with 0 issues, got state=%s remaining=%+v", sess.State, remaining)
	}

	if _, err := svc.Commit(ctx, sess.ID); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// R33: child bookmark inside disambiguated folder fB must match bInB (update title),
	// NOT create a duplicate bookmark!
	bInB := deps.mustNode("bInB")
	if bInB.Title != "Go Docs (local)" {
		t.Fatalf("bInB title = %q, want matched local title", bInB.Title)
	}
	var goCount int
	if err := deps.db.QueryRow(`SELECT COUNT(*) FROM nodes WHERE space_id = 's1' AND url = 'https://go.dev/doc'`).Scan(&goCount); err != nil {
		t.Fatal(err)
	}
	if goCount != 1 {
		t.Fatalf("go.dev/doc count = %d, want 1 (must not duplicate matched child)", goCount)
	}
	// Duplicate-create choice on l_dup created a 3rd bookmark without overwriting x1/x2.
	var dupCount int
	if err := deps.db.QueryRow(`SELECT COUNT(*) FROM nodes WHERE space_id = 's1' AND url = 'https://dup.example'`).Scan(&dupCount); err != nil {
		t.Fatal(err)
	}
	if dupCount != 3 {
		t.Fatalf("dup.example count = %d, want 3", dupCount)
	}
}

// R35 & R36: Commit guards against subsequent Decide/Plan, artifact cleanup
// runs on re-plan/complete/revoke, and R43/R14 initial commit creates an
// undoable ChangeSet even with empty-title bookmarks.
func TestReconcileLifecycleCleanupChangeSetAndEmptyTitle(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Safari")

	snapshot := clientSnapshot(
		[]reconcile.ClientRootJSON{{LocalRef: "l_bar", RootKey: "main", Title: "Bar"}},
		[]reconcile.ClientNodeJSON{
			{LocalRef: "l_empty", ParentLocalRef: "l_bar", Type: "bookmark", Title: "", URL: "https://icon-only.example"},
		},
	)

	sess, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "pairing")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateServerSnapshot(ctx, bindingID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Plan(ctx, sess.ID); err != nil {
		t.Fatal(err)
	}
	// Re-plan cleans superseded plan/steps artifacts (R36).
	if _, _, err := svc.Plan(ctx, sess.ID); err != nil {
		t.Fatal(err)
	}
	var artCount int
	if err := deps.db.QueryRow(`SELECT COUNT(*) FROM sync_artifacts WHERE binding_id = ?`, bindingID).Scan(&artCount); err != nil {
		t.Fatal(err)
	}
	if artCount != 4 {
		t.Fatalf("artifacts after re-plan = %d, want 4 (client + server + latest plan + latest steps)", artCount)
	}

	if _, err := svc.Commit(ctx, sess.ID); err != nil {
		t.Fatalf("Commit with empty-title bookmark: %v", err)
	}
	// R35: Cannot re-plan or commit again once committed.
	if _, _, err := svc.Plan(ctx, sess.ID); !errors.Is(err, reconcile.ErrInvalidSessionState) {
		t.Fatalf("Plan after commit = %v, want ErrInvalidSessionState", err)
	}
	if _, err := svc.Commit(ctx, sess.ID); !errors.Is(err, reconcile.ErrInvalidSessionState) {
		t.Fatalf("second Commit = %v, want ErrInvalidSessionState", err)
	}

	// R43: Initial commit recorded an undoable reconciliation ChangeSet.
	csStore := NewChangeSetStore(deps.db)
	csList, err := csStore.ListChangeSets(ctx, "s1", 10)
	if err != nil {
		t.Fatalf("ListChangeSets: %v", err)
	}
	if len(csList) != 1 || csList[0].Kind != changeset.KindReconciliation || csList[0].UndoDataJSON == "" {
		t.Fatalf("changesets = %+v, want 1 undoable reconciliation changeset", csList)
	}

	// R36: Complete purges all session artifacts and server snapshots.
	if _, err := svc.Complete(ctx, sess.ID); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if err := deps.db.QueryRow(`SELECT COUNT(*) FROM sync_artifacts WHERE binding_id = ?`, bindingID).Scan(&artCount); err != nil {
		t.Fatal(err)
	}
	var snapCount int
	if err := deps.db.QueryRow(`SELECT COUNT(*) FROM server_snapshots WHERE binding_id = ?`, bindingID).Scan(&snapCount); err != nil {
		t.Fatal(err)
	}
	if artCount != 0 || snapCount != 0 {
		t.Fatalf("after Complete: artifacts=%d snapshots=%d, want 0/0", artCount, snapCount)
	}

	// R35 & R36: Revoking a binding atomically fails open reconciliations and purges artifacts.
	sess2, err := svc.CreateSession(ctx, bindingID, reconcile.TypeFullResync, "resync")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateServerSnapshot(ctx, bindingID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Plan(ctx, sess2.ID); err != nil {
		t.Fatal(err)
	}
	if err := NewDeviceStore(deps.db).RevokeBinding(ctx, bindingID, sess2.CreatedAt); err != nil {
		t.Fatalf("RevokeBinding: %v", err)
	}
	if _, err := svc.Commit(ctx, sess2.ID); !errors.Is(err, reconcile.ErrInvalidSessionState) {
		t.Fatalf("Commit after RevokeBinding = %v, want ErrInvalidSessionState", err)
	}
	if err := deps.db.QueryRow(`SELECT COUNT(*) FROM sync_artifacts WHERE binding_id = ?`, bindingID).Scan(&artCount); err != nil {
		t.Fatal(err)
	}
	if err := deps.db.QueryRow(`SELECT COUNT(*) FROM server_snapshots WHERE binding_id = ?`, bindingID).Scan(&snapCount); err != nil {
		t.Fatal(err)
	}
	if artCount != 0 || snapCount != 0 {
		t.Fatalf("after RevokeBinding: artifacts=%d snapshots=%d, want 0/0", artCount, snapCount)
	}
}
