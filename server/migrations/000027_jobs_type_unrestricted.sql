-- 000027_jobs_type_unrestricted: remove the rigid SQL enum CHECK on jobs.type
-- (R46). Task type validation lives in jobs.Definitions so newly added domain
-- tasks like activity.gc can never drift out of sync with the schema.

CREATE TABLE jobs_new (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL CHECK (type <> ''),
    status              TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
    owner_user_id       TEXT REFERENCES users(id),
    space_id            TEXT,
    payload             TEXT NOT NULL DEFAULT '{}',
    result              TEXT,
    error               TEXT,
    phase               TEXT,
    progress_current    INTEGER,
    progress_total      INTEGER,
    attempt             INTEGER NOT NULL DEFAULT 0,
    max_attempts        INTEGER NOT NULL DEFAULT 3,
    priority            INTEGER NOT NULL DEFAULT 0,
    cancel_requested_at TEXT,
    next_run_at         TEXT NOT NULL,
    schedule_id         TEXT,
    scheduled_for       TEXT,
    worker_id           TEXT,
    lease_until         TEXT,
    scheduled_at        TEXT NOT NULL,
    started_at          TEXT,
    finished_at         TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

INSERT INTO jobs_new (
    id, type, status, owner_user_id, space_id, payload, result, error, phase,
    progress_current, progress_total, attempt, max_attempts, priority,
    cancel_requested_at, next_run_at, schedule_id, scheduled_for, worker_id,
    lease_until, scheduled_at, started_at, finished_at, created_at, updated_at)
SELECT
    id, type, status, owner_user_id, space_id, payload, result, error, phase,
    progress_current, progress_total, attempt, max_attempts, priority,
    cancel_requested_at, next_run_at, schedule_id, scheduled_for, worker_id,
    lease_until, scheduled_at, started_at, finished_at, created_at, updated_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX idx_jobs_poll ON jobs(status, next_run_at);
CREATE UNIQUE INDEX idx_jobs_schedule_dedupe
    ON jobs(schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL;
CREATE INDEX idx_jobs_owner ON jobs(owner_user_id, created_at);
CREATE INDEX idx_jobs_active_space
    ON jobs(type, space_id)
    WHERE status IN ('queued', 'running', 'retry_wait') AND space_id IS NOT NULL;
