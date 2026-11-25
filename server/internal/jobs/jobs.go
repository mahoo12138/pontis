// Package jobs implements the SQLite persistent job queue with claim+lease
// workers, bounded exponential backoff and cooperative cancellation
// (doc 13), plus the Task Definition Registry that keeps the generic
// infrastructure out of the product layer (doc 13 §4.3).
package jobs

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
)

// Type is a registered domain job type. Only types present in Definitions
// exist; user APIs may only reference user_visible && schedulable ones.
type Type string

// User-visible domain tasks.
const (
	TypeBackupCreate Type = "backup.create"
	TypeLinkCheck    Type = "organizer.link_check"
)

// System maintenance tasks.
const (
	TypeJournalGC       Type = "journal.gc"
	TypeReceiptGC       Type = "receipt.gc"
	TypeSessionCleanup  Type = "session.cleanup"
	TypeArtifactCleanup Type = "artifact.cleanup"
	TypeBackupRetention Type = "backup.retention"
	TypeMailSend        Type = "mail.send"
	TypeImportRun       Type = "import.run"
	TypeActivityGC      Type = "activity.gc"
)

// Definition describes one domain task in the registry (doc 13 §4.3).
type Definition struct {
	Type        Type
	UserVisible bool
	Schedulable bool
	// TitleKey is the product-layer display name key; the web UI maps it
	// to localized domain wording.
	TitleKey string
}

// Definitions is the closed Task Definition Registry.
var Definitions = []Definition{
	{Type: TypeBackupCreate, UserVisible: true, Schedulable: true, TitleKey: "task.backup_create"},
	{Type: TypeLinkCheck, UserVisible: true, Schedulable: true, TitleKey: "task.link_check"},
	{Type: TypeJournalGC, UserVisible: false, Schedulable: false, TitleKey: "task.journal_gc"},
	{Type: TypeReceiptGC, UserVisible: false, Schedulable: false, TitleKey: "task.receipt_gc"},
	{Type: TypeSessionCleanup, UserVisible: false, Schedulable: false, TitleKey: "task.session_cleanup"},
	{Type: TypeArtifactCleanup, UserVisible: false, Schedulable: false, TitleKey: "task.artifact_cleanup"},
	{Type: TypeBackupRetention, UserVisible: false, Schedulable: false, TitleKey: "task.backup_retention"},
	{Type: TypeMailSend, UserVisible: false, Schedulable: false, TitleKey: "task.mail_send"},
	{Type: TypeImportRun, UserVisible: false, Schedulable: false, TitleKey: "task.import_run"},
	{Type: TypeActivityGC, UserVisible: false, Schedulable: false, TitleKey: "task.activity_gc"},
}

// DefinitionOf returns the registry entry for a type.
func DefinitionOf(t Type) (Definition, bool) {
	for _, d := range Definitions {
		if d.Type == t {
			return d, true
		}
	}
	return Definition{}, false
}

// ErrUnknownType is returned for types outside the registry.
var ErrUnknownType = errors.New("jobs: unknown task type")

// Status is the job lifecycle state.
type Status string

const (
	StatusQueued     Status = "queued"
	StatusRunning    Status = "running"
	StatusRetryWait  Status = "retry_wait"
	StatusSucceeded  Status = "succeeded"
	StatusFailed     Status = "failed"
	StatusCancelled  Status = "cancelled"
)

// Errors.
var (
	ErrNotFound = errors.New("jobs: not found")
	// ErrForbidden marks ownership failures on user operations.
	ErrForbidden = errors.New("jobs: not the owner")
	// FatalError marks a handler failure as non-retryable.
	FatalError = errors.New("jobs: fatal")
)

// Job is one queue entry. OwnerUserID empty = system job (doc 13 §3.1).
type Job struct {
	ID          string
	Type        Type
	Status      Status
	OwnerUserID string
	SpaceID     string
	Payload     string
	Error       string
	Phase       string
	ProgressCur *int64
	ProgressTot *int64
	Attempt     int
	MaxAttempts int
	Priority    int
	CancelRequested bool
	// ScheduleID / ScheduledFor tie one occurrence to its plan schedule;
	// the (schedule_id, scheduled_for) unique index makes the scheduler
	// idempotent across crash-restarts (doc 13 §8).
	ScheduleID   string
	ScheduledFor *time.Time
	ScheduledAt time.Time
	StartedAt   *time.Time
	FinishedAt  *time.Time
}

// Retryable wraps an error to force a retry despite being non-fatal.
type Retryable struct{ Err error }

func (r Retryable) Error() string { return r.Err.Error() }

// Handler executes one job. Long handlers must check ctx (cooperative
// cancellation) and report progress through the callback.
type Handler func(ctx context.Context, job Job, report ReportFunc) error

// ReportFunc persists coarse progress: phase text beats fake percentages
// (doc 13 §13).
type ReportFunc func(phase string, current, total *int64) error

// Store is the persistence contract.
type Store interface {
	Enqueue(ctx context.Context, j Job) error
	// FindActiveByTypeAndSpace returns an already queued/running/retry_wait
	// job of the same type on the same space so repeated triggers coalesce
	// instead of stacking duplicate runs (R50).
	FindActiveByTypeAndSpace(ctx context.Context, t Type, spaceID string) (Job, bool, error)
	// Claim atomically moves one due job to running with a lease, respecting
	// optional per-type running concurrency caps and excluding cancelled jobs.
	Claim(ctx context.Context, workerID string, leaseUntil time.Time, typeLimits map[Type]int) (Job, error)
	// RenewLease extends a running job's lease only if workerID still owns it.
	// Returns false when the lease was reclaimed or the job is no longer running.
	RenewLease(ctx context.Context, id, workerID string, leaseUntil time.Time) (bool, error)
	// UpdateProgress rewrites phase/progress while running (fenced by workerID when non-empty).
	UpdateProgress(ctx context.Context, id, workerID, phase string, current, total *int64) error
	// Finish marks the terminal state (fenced by workerID when non-empty).
	Finish(ctx context.Context, id, workerID string, status Status, jobErr string, at time.Time) error
	// ScheduleRetry puts a job back to retry_wait with backoff (fenced by workerID when non-empty).
	ScheduleRetry(ctx context.Context, id, workerID string, attempt int, nextRunAt time.Time, jobErr string) error
	// RequestCancel immediately cancels queued/retry_wait jobs via CAS and
	// flags running jobs for cooperative cancellation (R49).
	RequestCancel(ctx context.Context, id string, at time.Time) error
	// Get loads one job.
	Get(ctx context.Context, id string) (Job, error)
	// List returns recent jobs, newest first.
	List(ctx context.Context, limit int) ([]Job, error)
	// ListByOwner returns one user's recent jobs (user task view).
	ListByOwner(ctx context.Context, owner string, limit int) ([]Job, error)
	// RecoverExpiredLeases increments attempts and requeues (or fails poison
	// pills reaching max_attempts) jobs whose worker lease expired.
	RecoverExpiredLeases(ctx context.Context, at time.Time) error
	// EnqueueOccurrence inserts a scheduled occurrence. created=false means
	// the (schedule_id, scheduled_for) dedupe index absorbed a replay
	// (crash between enqueue and next_run advance, doc 13 §8).
	EnqueueOccurrence(ctx context.Context, j Job) (bool, error)
	// PurgeFinishedBefore deletes terminal jobs that ended before `at`.
	PurgeFinishedBefore(ctx context.Context, at time.Time) (int64, error)
}

// Service runs the queue: a poll loop claims due jobs and executes them on
// a small worker pool.
type Service struct {
	store    Store
	handlers map[Type]Handler
	workers  int

	// LeaseDuration and RenewInterval govern lease heartbeats (R47). Zero
	// values fall back to 10m and 2m (or LeaseDuration/3 when shortened).
	LeaseDuration time.Duration
	RenewInterval time.Duration

	// TypeLimits caps concurrent running jobs per task type so heavy user
	// tasks (like link checks) never starve system maintenance (R50).
	TypeLimits map[Type]int

	mu      sync.Mutex
	started bool
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// NewService returns a job service with the given worker count.
func NewService(store Store, workers int) *Service {
	if workers < 1 {
		workers = 2
	}
	return &Service{
		store:      store,
		handlers:   map[Type]Handler{},
		workers:    workers,
		TypeLimits: map[Type]int{TypeLinkCheck: 1},
	}
}

func (s *Service) leaseDuration() time.Duration {
	if s.LeaseDuration > 0 {
		return s.LeaseDuration
	}
	return 10 * time.Minute
}

func (s *Service) renewInterval() time.Duration {
	if s.RenewInterval > 0 {
		return s.RenewInterval
	}
	if s.LeaseDuration > 0 {
		iv := s.LeaseDuration / 3
		if iv < 10*time.Millisecond {
			return 10 * time.Millisecond
		}
		return iv
	}
	return 2 * time.Minute
}

func priorityFor(def Definition) int {
	if !def.UserVisible {
		return 10 // system maintenance runs ahead of background user tasks
	}
	return 0
}

// Register installs a handler for a job type. Only registry types may be
// handled.
func (s *Service) Register(t Type, h Handler) error {
	if _, ok := DefinitionOf(t); !ok {
		return ErrUnknownType
	}
	s.handlers[t] = h
	return nil
}

// Enqueue creates a job that is due immediately. For space-scoped tasks, if an
// active (queued/running/retry_wait) job of the same type already exists on
// that space, it returns the existing job instead of stacking duplicates (R50).
func (s *Service) Enqueue(ctx context.Context, t Type, owner canonical.UserID, spaceID string, payload string) (Job, error) {
	def, ok := DefinitionOf(t)
	if !ok {
		return Job{}, ErrUnknownType
	}
	if _, ok := s.handlers[t]; !ok {
		return Job{}, fmt.Errorf("jobs: no handler for %s", t)
	}
	if spaceID != "" {
		if existing, found, err := s.store.FindActiveByTypeAndSpace(ctx, t, spaceID); err != nil {
			return Job{}, err
		} else if found {
			return existing, nil
		}
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Job{}, err
	}
	now := time.Now().UTC()
	j := Job{
		ID:          id.String(),
		Type:        t,
		Status:      StatusQueued,
		OwnerUserID: string(owner),
		SpaceID:     spaceID,
		Payload:     payload,
		MaxAttempts: 3,
		Priority:    priorityFor(def),
		ScheduledAt: now,
	}
	if err := s.store.Enqueue(ctx, j); err != nil {
		return Job{}, err
	}
	return j, nil
}

// EnqueueForSchedule creates the job for one schedule occurrence. The
// (schedule_id, scheduled_for) unique index makes replays harmless: the
// scheduler may crash after enqueue but before advancing next_run_at, and
// the next tick dedupes instead of doubling the occurrence (doc 13 §8).
func (s *Service) EnqueueForSchedule(ctx context.Context, t Type, owner canonical.UserID, spaceID, scheduleID string, scheduledFor time.Time) (bool, error) {
	def, ok := DefinitionOf(t)
	if !ok {
		return false, ErrUnknownType
	}
	if _, ok := s.handlers[t]; !ok {
		return false, fmt.Errorf("jobs: no handler for %s", t)
	}
	if spaceID != "" {
		if _, found, err := s.store.FindActiveByTypeAndSpace(ctx, t, spaceID); err != nil {
			return false, err
		} else if found {
			return false, nil
		}
	}
	id, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	now := time.Now().UTC()
	j := Job{
		ID:           id.String(),
		Type:         t,
		Status:       StatusQueued,
		OwnerUserID:  string(owner),
		SpaceID:      spaceID,
		MaxAttempts:  3,
		Priority:     priorityFor(def),
		ScheduleID:   scheduleID,
		ScheduledFor: &scheduledFor,
		ScheduledAt:  now,
	}
	return s.store.EnqueueOccurrence(ctx, j)
}

// Retry re-enqueues a failed or cancelled job as a fresh attempt. The
// original row is kept for the audit trail (doc 13 §4.2 ops path).
func (s *Service) Retry(ctx context.Context, id string) (Job, error) {
	old, err := s.store.Get(ctx, id)
	if err != nil {
		return Job{}, err
	}
	if old.Status != StatusFailed && old.Status != StatusCancelled {
		return Job{}, fmt.Errorf("jobs: %s job cannot be retried", old.Status)
	}
	return s.Enqueue(ctx, old.Type, canonical.UserID(old.OwnerUserID), old.SpaceID, old.Payload)
}

// Start launches the poll loop and workers; safe to call once.
func (s *Service) Start(ctx context.Context) {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return
	}
	s.started = true
	ctx, s.cancel = context.WithCancel(ctx)
	s.mu.Unlock()

	for i := 0; i < s.workers; i++ {
		s.wg.Add(1)
		go s.workerLoop(ctx, fmt.Sprintf("worker-%d", i))
	}
}

// Stop signals the workers and waits for the current jobs to finish.
func (s *Service) Stop() {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
}

func (s *Service) workerLoop(ctx context.Context, workerID string) {
	defer s.wg.Done()
	poll := time.NewTicker(500 * time.Millisecond)
	defer poll.Stop()
	for {
		// Recover leases from dead workers opportunistically.
		_ = s.store.RecoverExpiredLeases(ctx, time.Now().UTC())

		job, err := s.store.Claim(ctx, workerID, time.Now().UTC().Add(s.leaseDuration()), s.TypeLimits)
		switch {
		case err == nil:
			s.run(ctx, workerID, job)
			continue
		case errors.Is(err, ErrNotFound):
			// nothing due
		default:
			// Transient store failure: back off the poll loop.
		}

		select {
		case <-ctx.Done():
			return
		case <-poll.C:
		}
	}
}

func (s *Service) run(ctx context.Context, workerID string, job Job) {
	handler, ok := s.handlers[job.Type]
	if !ok {
		_ = s.store.Finish(ctx, job.ID, workerID, StatusFailed, "no handler registered", time.Now().UTC())
		return
	}
	// Cancellation & lease-renewal watcher (doc 13 §9/§12, R47): polls
	// cooperative cancellation and periodically extends the lease. If the lease
	// is lost (reclaimed by another worker), runCtx is cancelled immediately.
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	var leaseLost atomic.Bool
	go func() {
		cancelTicker := time.NewTicker(200 * time.Millisecond)
		defer cancelTicker.Stop()
		renewTicker := time.NewTicker(s.renewInterval())
		defer renewTicker.Stop()
		for {
			select {
			case <-done:
				return
			case <-cancelTicker.C:
				latest, err := s.store.Get(context.Background(), job.ID)
				if err == nil && latest.CancelRequested {
					cancel()
					return
				}
			case <-renewTicker.C:
				ok, err := s.store.RenewLease(context.Background(), job.ID, workerID, time.Now().UTC().Add(s.leaseDuration()))
				if err == nil && !ok {
					leaseLost.Store(true)
					cancel()
					return
				}
			}
		}
	}()

	report := func(phase string, current, total *int64) error {
		return s.store.UpdateProgress(runCtx, job.ID, workerID, phase, current, total)
	}
	err := handler(runCtx, job, report)

	// If another worker already reclaimed the lease, do not overwrite its state
	// (the SQL writes below are also fenced by worker_id AND status='running').
	if leaseLost.Load() {
		return
	}

	// The terminal write must survive the reason the handler stopped: if the
	// service is shutting down, its context is already cancelled, and losing
	// this write would leave the row 'running' with a dropped attempt count
	// instead of a scheduled retry.
	settleCtx := context.WithoutCancel(ctx)

	// Re-read cancel flag: handlers may finish despite a cancel request.
	latest, gerr := s.store.Get(context.Background(), job.ID)
	if gerr == nil && latest.CancelRequested {
		_ = s.store.Finish(settleCtx, job.ID, workerID, StatusCancelled, "", time.Now().UTC())
		return
	}

	now := time.Now().UTC()
	switch {
	case err == nil:
		_ = s.store.Finish(settleCtx, job.ID, workerID, StatusSucceeded, "", now)
	case errors.Is(err, FatalError):
		_ = s.store.Finish(settleCtx, job.ID, workerID, StatusFailed, err.Error(), now)
	default:
		attempt := job.Attempt + 1
		if attempt >= job.MaxAttempts {
			_ = s.store.Finish(settleCtx, job.ID, workerID, StatusFailed, err.Error(), now)
			return
		}
		// Bounded exponential backoff, capped at 15 minutes.
		backoff := 2 * time.Second
		for i := 1; i < attempt; i++ {
			backoff *= 4
			if backoff >= 15*time.Minute {
				backoff = 15 * time.Minute
				break
			}
		}
		// Server shutdown / context interruption is always retryable so a
		// rolling upgrade does not turn interrupted maintenance into a failure.
		interrupted := ctx.Err() != nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded))
		if _, retryable := err.(Retryable); !retryable && !isRetryableKind(err) && !interrupted {
			_ = s.store.Finish(settleCtx, job.ID, workerID, StatusFailed, err.Error(), now)
			return
		}
		_ = s.store.ScheduleRetry(settleCtx, job.ID, workerID, attempt, now.Add(backoff), err.Error())
	}
}

// isRetryableKind keeps the default policy: transport-ish failures retry,
// everything else fails fast unless wrapped in Retryable.
func isRetryableKind(err error) bool {
	type retryable interface{ Retryable() bool }
	if r, ok := err.(retryable); ok {
		return r.Retryable()
	}
	return false
}

// Cancel flags a job for cooperative cancellation.
func (s *Service) Cancel(ctx context.Context, id string) error {
	j, err := s.store.Get(ctx, id)
	if err != nil {
		return err
	}
	if terminal(j.Status) {
		return nil // nothing to cancel
	}
	return s.store.RequestCancel(ctx, id, time.Now().UTC())
}

// CancelOwned is the user task page path (doc 13 §4.1): the caller may
// only cancel one of their own jobs. System jobs (owner empty) are out
// of reach from the user API.
func (s *Service) CancelOwned(ctx context.Context, id string, owner canonical.UserID) error {
	j, err := s.store.Get(ctx, id)
	if err != nil {
		return err
	}
	if j.OwnerUserID == "" || j.OwnerUserID != string(owner) {
		return ErrForbidden
	}
	if terminal(j.Status) {
		return nil
	}
	return s.store.RequestCancel(ctx, id, time.Now().UTC())
}

func terminal(st Status) bool {
	return st == StatusSucceeded || st == StatusFailed || st == StatusCancelled
}

// List returns recent jobs for the admin view (all owners).
func (s *Service) List(ctx context.Context, limit int) ([]Job, error) {
	return s.store.List(ctx, limit)
}

// ListMine returns the user's recent jobs for the user task view.
func (s *Service) ListMine(ctx context.Context, owner canonical.UserID, limit int) ([]Job, error) {
	return s.store.ListByOwner(ctx, string(owner), limit)
}
