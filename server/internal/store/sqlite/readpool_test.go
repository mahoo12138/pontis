package sqlite

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"pontis/internal/canonical"
)

// R22: concurrent readers on the WAL read pool (SnapshotTree and SyncStore
// BeginReadTx) must proceed immediately even while a write transaction is
// held open on the single writer connection.
func TestReadPoolDoesNotBlockBehindOpenWriteTx(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "wal-concurrent.db")
	rw, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open rw: %v", err)
	}
	defer rw.Close()

	ctx := context.Background()
	seedUserAndSpace(t, rw)

	ro, err := OpenReadPool(dbPath)
	if err != nil {
		t.Fatalf("OpenReadPool: %v", err)
	}
	defer ro.Close()

	lib := NewLibraryStore(rw).WithReadDB(ro)
	syncStore := NewSyncStore(rw).WithReadDB(ro)

	// Hold an IMMEDIATE write transaction open on the single writer connection.
	wtx, err := rw.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin write tx: %v", err)
	}
	defer wtx.Rollback()
	if _, err := wtx.ExecContext(ctx, `UPDATE sync_spaces SET name = 'Locked' WHERE id = 'space-1'`); err != nil {
		t.Fatalf("write inside tx: %v", err)
	}

	// Concurrent reads via the WAL read pool must complete quickly without
	// waiting on wtx.
	readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	sp, _, _, err := lib.SnapshotTree(readCtx, canonical.SpaceID("space-1"))
	if err != nil {
		t.Fatalf("SnapshotTree blocked or failed under open write tx: %v", err)
	}
	if sp.Name != "Personal" {
		t.Fatalf("SnapshotTree saw uncommitted write %q, want Personal", sp.Name)
	}

	rtx, err := syncStore.BeginReadTx(readCtx)
	if err != nil {
		t.Fatalf("SyncStore.BeginReadTx blocked under open write tx: %v", err)
	}
	defer rtx.Rollback(readCtx)
	loaded, err := rtx.LoadSpace(readCtx, canonical.SpaceID("space-1"))
	if err != nil || loaded.Name != "Personal" {
		t.Fatalf("SyncStore read = %+v err=%v", loaded, err)
	}
	if _, err := lib.ListNodes(readCtx, canonical.SpaceID("space-1")); err != nil {
		t.Fatalf("LibraryStore.ListNodes blocked under open write tx: %v", err)
	}
	if _, err := lib.ListChangeSets(readCtx, canonical.SpaceID("space-1"), 10); err != nil {
		t.Fatalf("LibraryStore.ListChangeSets blocked under open write tx: %v", err)
	}
	if _, err := syncStore.LoadSpace(readCtx, canonical.SpaceID("space-1")); err != nil {
		t.Fatalf("SyncStore.LoadSpace blocked under open write tx: %v", err)
	}
}
