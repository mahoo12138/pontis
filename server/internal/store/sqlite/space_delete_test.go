package sqlite

import (
	"context"
	"errors"
	"testing"
	"time"

	"pontis/internal/auth"
	"pontis/internal/canonical"
	"pontis/internal/space"
)

// A space emptied of bookmarks but still bound to one device was answered with
// "this space still has bookmarks, backups or devices bound to it": three
// claims that rule out none of them, so the reader went and re-checked the
// thing that was already clear. The store now names every kind of row still
// referencing the space, in one pass rather than up to the first hit.
func TestDeleteSpaceReportsEveryBlocker(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	user, err := auth.NewService(NewAuthStore(db), time.Hour).CreateUser(ctx, auth.CreateUserParams{
		Username: "alice", Password: "password123", DisplayName: "Alice",
	})
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	owner := canonical.UserID(user.ID)

	stores := NewSpaceStore(db)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	createSpace := func(id string) {
		t.Helper()
		if err := stores.CreateSpace(ctx, canonical.SyncSpace{
			ID: canonical.SpaceID(id), OwnerUserID: owner, Name: id,
			Epoch: 1, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
		}, "书签栏"); err != nil {
			t.Fatalf("create space %s: %v", id, err)
		}
	}
	createSpace("space-held")
	createSpace("space-empty")

	// A device binding and a schedule, and deliberately no node at all.
	if _, err := db.ExecContext(ctx,
		`INSERT INTO devices (id, owner_user_id, name, client_type, created_at)
		 VALUES ('dev-1', ?, 'Chrome', 'extension', ?)`, string(owner), now); err != nil {
		t.Fatalf("insert device: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO device_space_bindings (id, device_id, space_id, state, epoch, created_at, updated_at)
		 VALUES ('bind-1', 'dev-1', 'space-held', 'active', 1, ?, ?)`, now, now); err != nil {
		t.Fatalf("insert binding: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO schedules (id, owner_user_id, type, enabled, schedule_type, schedule_expr,
		                       timezone, payload, next_run_at, created_at, updated_at, space_id)
		 VALUES ('sch-1', ?, 'link_check', 1, 'daily', '03:00', 'UTC', '{}', ?, ?, ?, 'space-held')`,
		string(owner), now, now, now); err != nil {
		t.Fatalf("insert schedule: %v", err)
	}

	deleted, err := stores.DeleteSpace(ctx, owner, "space-held")
	if deleted {
		t.Fatal("DeleteSpace removed a space that is still referenced")
	}
	if !errors.Is(err, space.ErrSpaceNotEmpty) {
		t.Fatalf("err = %v, want ErrSpaceNotEmpty", err)
	}
	var notEmpty *space.NotEmptyError
	if !errors.As(err, &notEmpty) {
		t.Fatalf("err = %v, want a *space.NotEmptyError carrying the blockers", err)
	}
	got := map[space.SpaceBlocker]bool{}
	for _, b := range notEmpty.Blockers {
		got[b] = true
	}
	if !got[space.BlockerBinding] || !got[space.BlockerSchedule] {
		t.Errorf("blockers = %v, want binding and schedule", notEmpty.Blockers)
	}
	if got[space.BlockerContent] {
		t.Errorf("blockers = %v, but the space holds no node", notEmpty.Blockers)
	}

	// The gate is not a wall: a space nothing references still goes, and any
	// residual history/reconciliation/transfer metadata for it is purged (R36).
	for _, stmt := range []string{
		`INSERT INTO journal (space_id, epoch, revision, change_type, node_id, payload, origin_type, created_at)
		 VALUES ('space-empty', 1, 1, 'create', 'n1', '{}', 'user', '` + now + `')`,
		`INSERT INTO tombstones (space_id, node_id, deleted_epoch, deleted_revision, deleted_at)
		 VALUES ('space-empty', 'n1', 1, 1, '` + now + `')`,
		`INSERT INTO changesets (id, space_id, epoch, kind, summary, origin_type, first_revision, last_revision, created_at)
		 VALUES ('cs-empty', 'space-empty', 1, 'node_create', 's', 'user', 1, 1, '` + now + `')`,
		`INSERT INTO reconciliations (id, binding_id, space_id, type, state, phase, created_at, updated_at)
		 VALUES ('rec-empty', 'b-gone', 'space-empty', 'initial', 'completed', 'done', '` + now + `', '` + now + `')`,
		`INSERT INTO sync_artifacts (id, binding_id, kind, storage_key, created_at)
		 VALUES ('art-empty', 'b-gone', 'client_snapshot', 'k', '` + now + `')`,
		`INSERT INTO server_snapshots (id, binding_id, space_id, epoch, revision, node_count, checksum, created_at)
		 VALUES ('snap-empty', 'b-gone', 'space-empty', 1, 1, 0, 'c', '` + now + `')`,
		`INSERT INTO cross_space_transfers (id, owner_user_id, source_space_id, target_space_id, state, request_hash, created_at)
		 VALUES ('xfer-empty', '` + string(owner) + `', 'space-empty', 'space-held', 'completed', 'h', '` + now + `')`,
	} {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			t.Fatalf("seed residual row (%s): %v", stmt[:40], err)
		}
	}
	if _, err := stores.DeleteSpace(ctx, owner, "space-empty"); err != nil {
		t.Fatalf("delete of an empty space: %v", err)
	}
	for _, check := range []struct {
		name, query string
	}{
		{"journal", `SELECT COUNT(*) FROM journal WHERE space_id = 'space-empty'`},
		{"tombstones", `SELECT COUNT(*) FROM tombstones WHERE space_id = 'space-empty'`},
		{"changesets", `SELECT COUNT(*) FROM changesets WHERE space_id = 'space-empty'`},
		{"reconciliations", `SELECT COUNT(*) FROM reconciliations WHERE space_id = 'space-empty'`},
		{"sync_artifacts", `SELECT COUNT(*) FROM sync_artifacts WHERE id = 'art-empty'`},
		{"server_snapshots", `SELECT COUNT(*) FROM server_snapshots WHERE space_id = 'space-empty'`},
		{"cross_space_transfers", `SELECT COUNT(*) FROM cross_space_transfers WHERE source_space_id = 'space-empty'`},
	} {
		var count int
		if err := db.QueryRowContext(ctx, check.query).Scan(&count); err != nil {
			t.Fatalf("count %s: %v", check.name, err)
		}
		if count != 0 {
			t.Errorf("DeleteSpace left %d residual rows in %s", count, check.name)
		}
	}
}
