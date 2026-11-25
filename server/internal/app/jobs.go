package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"pontis/internal/activity"
	"pontis/internal/backup"
	"pontis/internal/canonical"
	"pontis/internal/jobs"
	"pontis/internal/organizer"
	"pontis/internal/store/sqlite"
)

// activityRetentionDays bounds how long uploaded browsing aggregates live on
// the server. The client's own aggregate retention (180 days) is the tighter
// bound in practice — days that fell off the client stop being re-sent — so
// the server matches it rather than promising a longer memory than the
// device the data came from keeps.
const activityRetentionDays = 180

// buildJobService wires the queue with the concrete handlers available in
// this deployment (doc 13 §18).
func buildJobService(
	db *sql.DB,
	backups *backup.Service,
	organizerSvc *organizer.Service,
	activitySvc *activity.Service,
	accounts *sqlite.AccountStore,
	library *sqlite.LibraryStore,
	tokens *sqlite.TokenStore,
) (*jobs.Service, error) {
	store := sqlite.NewJobStore(db)
	reconcileStore := sqlite.NewReconcileStore(db)
	// 3 workers with organizer.link_check capped at 1 leaves 2 workers free for
	// scheduled backups and system maintenance (R50).
	svc := jobs.NewService(store, 3)

	// session.cleanup: drop expired web sessions, reset tokens and API tokens
	// that can no longer work, and prune finished job history past the 90-day
	// summary retention (doc 13 §7).
	svc.Register(jobs.TypeSessionCleanup, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if err := report("清理过期会话与凭据", nil, nil); err != nil {
			return err
		}
		now := time.Now().UTC()
		if _, err := accounts.PurgeExpiredSessions(ctx, now); err != nil {
			return err
		}
		if err := accounts.PurgeExpiredResetTokens(ctx, now); err != nil {
			return err
		}
		if _, err := tokens.PurgeDeadTokensBefore(ctx, now.Add(-90*24*time.Hour)); err != nil {
			return err
		}
		n, err := store.PurgeFinishedBefore(ctx, now.Add(-90*24*time.Hour))
		if err != nil {
			return err
		}
		if n > 0 {
			return report(fmt.Sprintf("清理 %d 条过期任务记录", n), nil, nil)
		}
		return nil
	})

	// backup.create: capture one space's tree. Storage key is derived from
	// job.ID so at-least-once retries stay idempotent (doc 13 §10).
	svc.Register(jobs.TypeBackupCreate, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if job.SpaceID == "" {
			return fmt.Errorf("%w: job has no space", jobs.FatalError)
		}
		if err := report("捕获空间快照", nil, nil); err != nil {
			return err
		}
		b, err := backups.CreateForJob(ctx, canonical.SpaceID(job.SpaceID), backup.KindScheduled, job.ID)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return jobs.Retryable{Err: err}
			}
			return fmt.Errorf("%w: %v", jobs.FatalError, err)
		}
		return report("备份完成: "+b.Filename, nil, nil)
	})

	// organizer.link_check: the organizer's persisted run does the work,
	// item by item, under this job's context (doc 12 §2).
	svc.Register(jobs.TypeLinkCheck, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		return organizerSvc.CheckRun(ctx, job, report)
	})

	// journal.gc: advance the floor and prune history (doc 14 §3).
	svc.Register(jobs.TypeJournalGC, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if err := report("推进 journal floor", nil, nil); err != nil {
			return err
		}
		spaceIDs, err := library.ListAllSpaces(ctx)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		var removed int64
		for _, sid := range spaceIDs {
			_, n, err := library.JournalGCSpace(ctx, sid, now, 50000)
			if err != nil {
				return err
			}
			removed += n
		}
		return report(fmt.Sprintf("journal GC 完成,清理 %d 行", removed), nil, nil)
	})

	// receipt.gc: receipts follow the journal floor; handled with the
	// journal sweep.
	svc.Register(jobs.TypeReceiptGC, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		return report("receipts 随 journal floor 一并清理", nil, nil)
	})

	// artifact.cleanup: purge expired safety backups and reconciliation
	// artifacts/snapshots (R36).
	svc.Register(jobs.TypeArtifactCleanup, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if err := report("清理过期安全备份与对账工件", nil, nil); err != nil {
			return err
		}
		n, err := backups.PurgeExpiredSafety(ctx, 30*24*time.Hour)
		if err != nil {
			return err
		}
		artRemoved, err := reconcileStore.PurgeExpiredArtifacts(ctx, time.Now().UTC())
		if err != nil {
			return err
		}
		return report(fmt.Sprintf("artifact 清理完成,移除 %d 份安全备份与 %d 条对账工件", n, artRemoved), nil, nil)
	})

	// backup.retention: keep the newest 10 scheduled backups per space.
	svc.Register(jobs.TypeBackupRetention, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if err := report("按保留策略清理定时备份", nil, nil); err != nil {
			return err
		}
		n, err := backups.ApplyScheduledRetention(ctx, 10)
		if err != nil {
			return err
		}
		return report(fmt.Sprintf("保留策略完成,移除 %d 份定时备份", n), nil, nil)
	})

	// mail.send: SMTP has not landed. Reporting success would file an
	// undelivered message as delivered, so the job fails with a stable
	// reason and the queue keeps a visible record instead (doc 13 §14).
	svc.Register(jobs.TypeMailSend, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		return fmt.Errorf("%w: SMTP is not configured, nothing was sent", jobs.FatalError)
	})

	// activity.gc: browsing statistics outlive nothing. Aggregates past the
	// retention day and the batch audit trail past 30 days are removed, the
	// same promise the extension's own settings page makes about the device.
	svc.Register(jobs.TypeActivityGC, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if err := report("按保留策略清理浏览统计", nil, nil); err != nil {
			return err
		}
		now := time.Now().UTC()
		cutoffDay := now.AddDate(0, 0, -activityRetentionDays).Format("2006-01-02")
		removed, err := activitySvc.Purge(ctx, cutoffDay, now.Add(-30*24*time.Hour))
		if err != nil {
			return err
		}
		return report(fmt.Sprintf("activity GC 完成,清理 %d 行", removed), nil, nil)
	})

	return svc, nil
}
