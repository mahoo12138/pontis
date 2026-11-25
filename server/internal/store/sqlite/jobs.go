package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"pontis/internal/jobs"
)

// JobStore implements the SQLite job queue with claim+lease semantics.
type JobStore struct {
	db *sql.DB
}

// NewJobStore returns a job store.
func NewJobStore(db *sql.DB) *JobStore { return &JobStore{db: db} }

const jobColumns = `
	id, type, status, owner_user_id, COALESCE(space_id, ''), payload, COALESCE(error, ''),
	COALESCE(phase, ''), progress_current, progress_total, attempt, max_attempts,
	COALESCE(cancel_requested_at, ''), COALESCE(schedule_id, ''), scheduled_for,
	scheduled_at, started_at, finished_at`

func scanJob(row interface{ Scan(dest ...any) error }) (jobs.Job, error) {
	var j jobs.Job
	var typ, status, scheduledAt, cancelFlag, scheduleID string
	var scheduledFor, startedAt, finishedAt *string
	var progressCur, progressTot *int64
	var owner *string
	if err := row.Scan(&j.ID, &typ, &status, &owner, &j.SpaceID, &j.Payload, &j.Error,
		&j.Phase, &progressCur, &progressTot, &j.Attempt, &j.MaxAttempts,
		&cancelFlag, &scheduleID, &scheduledFor, &scheduledAt, &startedAt, &finishedAt); err != nil {
		return j, err
	}
	if owner != nil {
		j.OwnerUserID = *owner
	}
	j.CancelRequested = cancelFlag != ""
	j.Type = jobs.Type(typ)
	j.Status = jobs.Status(status)
	j.ScheduleID = scheduleID
	if scheduledFor != nil {
		v, _ := time.Parse(time.RFC3339Nano, *scheduledFor)
		j.ScheduledFor = &v
	}
	j.ScheduledAt, _ = time.Parse(time.RFC3339Nano, scheduledAt)
	if startedAt != nil {
		v, _ := time.Parse(time.RFC3339Nano, *startedAt)
		j.StartedAt = &v
	}
	if finishedAt != nil {
		v, _ := time.Parse(time.RFC3339Nano, *finishedAt)
		j.FinishedAt = &v
	}
	j.ProgressCur = progressCur
	j.ProgressTot = progressTot
	return j, nil
}

// Enqueue writes a queued job. Empty owner = system job (NULL).
func (s *JobStore) Enqueue(ctx context.Context, j jobs.Job) error {
	var owner any
	if j.OwnerUserID != "" {
		owner = j.OwnerUserID
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO jobs (id, type, status, owner_user_id, space_id, payload,
			attempt, max_attempts, priority, next_run_at, scheduled_at, created_at, updated_at)
		VALUES (?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
		j.ID, string(j.Type), owner, nullableString(j.SpaceID), j.Payload,
		j.MaxAttempts, j.Priority, formatTime(j.ScheduledAt), formatTime(j.ScheduledAt),
		formatTime(j.ScheduledAt), formatTime(j.ScheduledAt))
	return err
}

// FindActiveByTypeAndSpace returns an existing queued, running, or retry_wait
// job matching (type, space_id) so repeated triggers coalesce (R50).
func (s *JobStore) FindActiveByTypeAndSpace(ctx context.Context, t jobs.Type, spaceID string) (jobs.Job, bool, error) {
	if spaceID == "" {
		return jobs.Job{}, false, nil
	}
	row := s.db.QueryRowContext(ctx, `
		SELECT `+jobColumns+` FROM jobs
		WHERE type = ? AND space_id = ?
		  AND status IN ('queued', 'running', 'retry_wait')
		  AND cancel_requested_at IS NULL
		ORDER BY created_at ASC LIMIT 1`, string(t), spaceID)
	j, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return jobs.Job{}, false, nil
	}
	return j, err == nil, err
}

// Claim atomically moves one due job (queued or retry_wait past its backoff,
// not cancelled) to running with a lease, respecting optional per-type running
// concurrency caps (R49, R50).
func (s *JobStore) Claim(ctx context.Context, workerID string, leaseUntil time.Time, typeLimits map[jobs.Type]int) (jobs.Job, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return jobs.Job{}, err
	}
	defer tx.Rollback()

	var excluded []any
	if len(typeLimits) > 0 {
		runningRows, err := tx.QueryContext(ctx, `
			SELECT type, COUNT(*) FROM jobs WHERE status = 'running' GROUP BY type`)
		if err != nil {
			return jobs.Job{}, err
		}
		for runningRows.Next() {
			var typ string
			var cnt int
			if err := runningRows.Scan(&typ, &cnt); err != nil {
				runningRows.Close()
				return jobs.Job{}, err
			}
			if limit, ok := typeLimits[jobs.Type(typ)]; ok && limit > 0 && cnt >= limit {
				excluded = append(excluded, typ)
			}
		}
		runningRows.Close()
		if err := runningRows.Err(); err != nil {
			return jobs.Job{}, err
		}
	}

	args := []any{formatTime(time.Now().UTC())}
	query := `
		SELECT id FROM jobs
		WHERE status IN ('queued', 'retry_wait')
		  AND cancel_requested_at IS NULL
		  AND next_run_at <= ?`
	if len(excluded) > 0 {
		placeholders := strings.Repeat("?,", len(excluded))
		placeholders = placeholders[:len(placeholders)-1]
		query += ` AND type NOT IN (` + placeholders + `)`
		args = append(args, excluded...)
	}
	query += ` ORDER BY priority DESC, next_run_at LIMIT 1`

	var id string
	err = tx.QueryRowContext(ctx, query, args...).Scan(&id)
	if err == sql.ErrNoRows {
		return jobs.Job{}, jobs.ErrNotFound
	}
	if err != nil {
		return jobs.Job{}, err
	}
	now := time.Now().UTC()
	res := tx.QueryRowContext(ctx, `
		UPDATE jobs SET status = 'running', worker_id = ?, lease_until = ?,
			started_at = COALESCE(started_at, ?), updated_at = ?
		WHERE id = ? AND status IN ('queued', 'retry_wait') AND cancel_requested_at IS NULL
		RETURNING `+jobColumns,
		workerID, formatTime(leaseUntil), formatTime(now), formatTime(now), id)
	j, err := scanJob(res)
	if errors.Is(err, sql.ErrNoRows) {
		return jobs.Job{}, jobs.ErrNotFound
	}
	if err != nil {
		return jobs.Job{}, err
	}
	if err := tx.Commit(); err != nil {
		return jobs.Job{}, err
	}
	return j, nil
}

// RenewLease extends a running job's lease only if workerID still holds it (R47).
func (s *JobStore) RenewLease(ctx context.Context, id, workerID string, leaseUntil time.Time) (bool, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE jobs SET lease_until = ?, updated_at = ?
		WHERE id = ? AND worker_id = ? AND status = 'running'`,
		formatTime(leaseUntil), formatTime(time.Now().UTC()), id, workerID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// UpdateProgress rewrites phase/progress while the job is running. When
// workerID is non-empty, the write is fenced to the current lease holder (R47).
func (s *JobStore) UpdateProgress(ctx context.Context, id, workerID, phase string, current, total *int64) error {
	if workerID != "" {
		_, err := s.db.ExecContext(ctx, `
			UPDATE jobs SET phase = ?, progress_current = ?, progress_total = ?, updated_at = ?
			WHERE id = ? AND worker_id = ? AND status = 'running'`,
			phase, nullableInt64(current), nullableInt64(total),
			formatTime(time.Now().UTC()), id, workerID)
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE jobs SET phase = ?, progress_current = ?, progress_total = ?, updated_at = ?
		WHERE id = ?`, phase, nullableInt64(current), nullableInt64(total),
		formatTime(time.Now().UTC()), id)
	return err
}

// Finish marks the terminal state. When workerID is non-empty, the write is
// fenced to the current lease holder so a stale worker never clobbers a
// reclaimed run (R47).
func (s *JobStore) Finish(ctx context.Context, id, workerID string, status jobs.Status, jobErr string, at time.Time) error {
	var result any
	if status == jobs.StatusSucceeded {
		result = "{}"
	}
	if workerID != "" {
		_, err := s.db.ExecContext(ctx, `
			UPDATE jobs SET status = ?, error = NULLIF(?, ''), result = ?,
				worker_id = NULL, lease_until = NULL, finished_at = ?, updated_at = ?
			WHERE id = ? AND worker_id = ? AND status = 'running'`,
			string(status), jobErr, result, formatTime(at), formatTime(at), id, workerID)
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE jobs SET status = ?, error = NULLIF(?, ''), result = ?,
			worker_id = NULL, lease_until = NULL, finished_at = ?, updated_at = ?
		WHERE id = ?`, string(status), jobErr, result, formatTime(at), formatTime(at), id)
	return err
}

// ScheduleRetry puts a job back to retry_wait with backoff (fenced by workerID when non-empty).
func (s *JobStore) ScheduleRetry(ctx context.Context, id, workerID string, attempt int, nextRunAt time.Time, jobErr string) error {
	if workerID != "" {
		_, err := s.db.ExecContext(ctx, `
			UPDATE jobs SET status = 'retry_wait', attempt = ?, next_run_at = ?, error = ?,
				worker_id = NULL, lease_until = NULL, updated_at = ?
			WHERE id = ? AND worker_id = ? AND status = 'running'`,
			attempt, formatTime(nextRunAt), jobErr, formatTime(time.Now().UTC()), id, workerID)
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE jobs SET status = 'retry_wait', attempt = ?, next_run_at = ?, error = ?,
			worker_id = NULL, lease_until = NULL, updated_at = ?
		WHERE id = ?`, attempt, formatTime(nextRunAt), jobErr, formatTime(time.Now().UTC()), id)
	return err
}

// RequestCancel immediately transitions queued/retry_wait jobs to cancelled
// via CAS so they never run, and flags running jobs for cooperative
// cancellation (R49).
func (s *JobStore) RequestCancel(ctx context.Context, id string, at time.Time) error {
	ts := formatTime(at)
	res, err := s.db.ExecContext(ctx, `
		UPDATE jobs
		SET status = 'cancelled',
		    cancel_requested_at = COALESCE(cancel_requested_at, ?),
		    finished_at = ?,
		    updated_at = ?
		WHERE id = ? AND status IN ('queued', 'retry_wait')`,
		ts, ts, ts, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return nil
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE jobs
		SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ?
		WHERE id = ? AND status = 'running'`, ts, ts, id)
	return err
}

// Get loads one job.
func (s *JobStore) Get(ctx context.Context, id string) (jobs.Job, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+jobColumns+` FROM jobs WHERE id = ?`, id)
	j, err := scanJob(row)
	if err == sql.ErrNoRows {
		return j, jobs.ErrNotFound
	}
	return j, err
}

// List returns recent jobs, newest first (admin view: all owners).
func (s *JobStore) List(ctx context.Context, limit int) ([]jobs.Job, error) {
	return s.listQuery(ctx, `SELECT `+jobColumns+` FROM jobs ORDER BY created_at DESC, id LIMIT ?`, limit)
}

// ListByOwner returns one user's recent jobs (user task view).
func (s *JobStore) ListByOwner(ctx context.Context, owner string, limit int) ([]jobs.Job, error) {
	return s.listQuery(ctx, `SELECT `+jobColumns+` FROM jobs WHERE owner_user_id = ? ORDER BY created_at DESC, id LIMIT ?`, owner, limit)
}

func (s *JobStore) listQuery(ctx context.Context, query string, args ...any) ([]jobs.Job, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []jobs.Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// RecoverExpiredLeases increments attempt on jobs whose worker lease expired,
// failing poison pills that reached max_attempts and requeuing the rest.
func (s *JobStore) RecoverExpiredLeases(ctx context.Context, at time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	ts := formatTime(at)
	if _, err := tx.ExecContext(ctx, `
		UPDATE jobs
		SET status = 'failed',
		    attempt = attempt + 1,
		    error = 'worker lease expired after max attempts',
		    worker_id = NULL, lease_until = NULL,
		    finished_at = ?, updated_at = ?
		WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?
		  AND attempt + 1 >= max_attempts`, ts, ts, ts); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE jobs
		SET status = 'queued',
		    attempt = attempt + 1,
		    worker_id = NULL, lease_until = NULL,
		    updated_at = ?
		WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?`,
		ts, ts); err != nil {
		return err
	}
	return tx.Commit()
}

// EnqueueOccurrence inserts a scheduled-occurrence job. The partial unique
// index on (schedule_id, scheduled_for) absorbs replays; created=false
// reports a dedupe instead of an error (doc 13 §8).
func (s *JobStore) EnqueueOccurrence(ctx context.Context, j jobs.Job) (bool, error) {
	var owner any
	if j.OwnerUserID != "" {
		owner = j.OwnerUserID
	}
	var scheduledFor any
	if j.ScheduledFor != nil {
		scheduledFor = formatTime(*j.ScheduledFor)
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO jobs (id, type, status, owner_user_id, space_id, payload,
			attempt, max_attempts, priority, next_run_at, schedule_id, scheduled_for,
			scheduled_at, created_at, updated_at)
		VALUES (?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT DO NOTHING`,
		j.ID, string(j.Type), owner, nullableString(j.SpaceID), j.Payload,
		j.MaxAttempts, j.Priority, formatTime(j.ScheduledAt), nullableString(j.ScheduleID),
		scheduledFor, formatTime(j.ScheduledAt), formatTime(j.ScheduledAt),
		formatTime(j.ScheduledAt))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// PurgeFinishedBefore deletes terminal jobs that finished before `at`
// (job summary retention, doc 13 §7). Queued/running rows are never touched.
func (s *JobStore) PurgeFinishedBefore(ctx context.Context, at time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `
		DELETE FROM jobs
		WHERE status IN ('succeeded', 'failed', 'cancelled') AND finished_at < ?`,
		formatTime(at))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullableInt64(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}
