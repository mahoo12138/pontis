// Package sqlite provides the SQLite-backed store: connection setup with the
// required pragmas and the forward-only migration runner.
package sqlite

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "github.com/ncruces/go-sqlite3/driver"
)

// Open opens (creating if needed) the SQLite database at dbPath with the
// baseline pragmas from the design docs: WAL journal, foreign keys on,
// busy timeout, synchronous FULL, and IMMEDIATE write transactions so
// writers serialize cleanly without read-to-write upgrade deadlocks (R22).
func Open(dbPath string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	dsn := "file:" + filepath.ToSlash(dbPath) +
		"?_pragma=busy_timeout(5000)" +
		"&_pragma=foreign_keys(1)" +
		"&_pragma=journal_mode(WAL)" +
		"&_pragma=synchronous(FULL)" +
		"&_txlock=immediate"

	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	return db, nil
}

// OpenReadPool opens a separate read-only WAL connection pool against an
// already-initialized SQLite database file so concurrent readers (snapshots,
// explorer queries, sync pulls) proceed without queuing behind the single
// writer connection (R22).
func OpenReadPool(dbPath string) (*sql.DB, error) {
	dsn := "file:" + filepath.ToSlash(dbPath) +
		"?mode=ro" +
		"&_pragma=busy_timeout(5000)" +
		"&_pragma=query_only(1)" +
		"&_pragma=foreign_keys(1)"

	ro, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite read pool: %w", err)
	}
	ro.SetMaxOpenConns(4)
	ro.SetMaxIdleConns(4)
	ro.SetConnMaxLifetime(0)

	if err := ro.Ping(); err != nil {
		ro.Close()
		return nil, fmt.Errorf("ping sqlite read pool: %w", err)
	}
	return ro, nil
}

// now returns the canonical timestamp format used across the schema
// (UTC RFC3339 with nanoseconds).
func now() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}
