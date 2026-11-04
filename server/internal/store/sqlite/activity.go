package sqlite

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"pontis/internal/activity"
	"pontis/internal/canonical"
)

// ActivityStore persists the browsing statistics the extension uploads.
// Every write is a replace: the day entry is the whole truth for its
// (device, day), so an apply deletes the previous rows and inserts the
// batch's, in one transaction. Reads aggregate on demand — a personal
// instance's row counts (a few hundred a day per device) never justify a
// rollup table, and the indexes below keep every query a bounded scan.

type ActivityStore struct {
	db *sql.DB
}

// NewActivityStore returns an activity store.
func NewActivityStore(db *sql.DB) *ActivityStore { return &ActivityStore{db: db} }

// ReplaceDay swaps the stored rows for one (user, device, day) with the
// batch entry. The audit row rides in the same transaction: a batch either
// fully happened or fully did not.
func (s *ActivityStore) ReplaceDay(ctx context.Context, userID canonical.UserID, deviceID, batchID string,
	entry activity.DayEntry, receivedAt time.Time) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO activity_batches (batch_id, device_id, day, rows, received_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(batch_id, day) DO NOTHING`,
		batchID, deviceID, entry.Day, len(entry.Hosts), formatTime(receivedAt)); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM activity_daily WHERE user_id = ? AND device_id = ? AND day = ?`,
		string(userID), deviceID, entry.Day); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM activity_hourly WHERE user_id = ? AND device_id = ? AND day = ?`,
		string(userID), deviceID, entry.Day); err != nil {
		return false, err
	}
	for _, h := range entry.Hosts {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO activity_daily (user_id, device_id, day, host, seconds, visits)
			VALUES (?, ?, ?, ?, ?, ?)`,
			string(userID), deviceID, entry.Day, strings.ToLower(h.Host), h.Seconds, h.Visits); err != nil {
			return false, err
		}
	}
	for _, h := range entry.Hours {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO activity_hourly (user_id, device_id, day, hour, seconds)
			VALUES (?, ?, ?, ?, ?)`,
			string(userID), deviceID, entry.Day, h.Hour, h.Seconds); err != nil {
			return false, err
		}
	}
	return true, tx.Commit()
}

func (s *ActivityStore) rangeWhere(userID canonical.UserID, fromDay, toDay, deviceID string) (string, []any) {
	where := `user_id = ? AND day >= ? AND day <= ?`
	args := []any{string(userID), fromDay, toDay}
	if deviceID != "" {
		where += ` AND device_id = ?`
		args = append(args, deviceID)
	}
	return where, args
}

// Overview aggregates the range: totals, per-day lines and the 24-hour
// histogram. The histogram always comes back with 24 slots.
func (s *ActivityStore) Overview(ctx context.Context, userID canonical.UserID,
	fromDay, toDay, deviceID string) (activity.Overview, error) {
	where, args := s.rangeWhere(userID, fromDay, toDay, deviceID)

	out := activity.Overview{From: fromDay, To: toDay, ByHour: make([]int64, 24)}

	var totals activity.Totals
	if err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(seconds), 0), COALESCE(SUM(visits), 0)
		FROM activity_daily WHERE `+where, args...).Scan(&totals.Seconds, &totals.Visits); err != nil {
		return out, err
	}
	out.Totals = totals

	rows, err := s.db.QueryContext(ctx, `
		SELECT day, SUM(seconds), SUM(visits)
		FROM activity_daily WHERE `+where+`
		GROUP BY day ORDER BY day`, args...)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var t activity.DayTotal
		if err := rows.Scan(&t.Day, &t.Seconds, &t.Visits); err != nil {
			return out, err
		}
		out.ByDay = append(out.ByDay, t)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}

	hourRows, err := s.db.QueryContext(ctx, `
		SELECT hour, SUM(seconds)
		FROM activity_hourly WHERE `+where+`
		GROUP BY hour`, args...)
	if err != nil {
		return out, err
	}
	defer hourRows.Close()
	for hourRows.Next() {
		var hour int
		var seconds int64
		if err := hourRows.Scan(&hour, &seconds); err != nil {
			return out, err
		}
		out.ByHour[hour] = seconds
	}
	return out, hourRows.Err()
}

// Hosts ranks hosts by seconds across the range. The total counts distinct
// hosts before paging, so the client knows whether a "load more" exists.
func (s *ActivityStore) Hosts(ctx context.Context, userID canonical.UserID,
	fromDay, toDay, deviceID string, limit, offset int) ([]activity.HostStat, int, error) {
	where, args := s.rangeWhere(userID, fromDay, toDay, deviceID)

	var total int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(DISTINCT host) FROM activity_daily WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT host, SUM(seconds), SUM(visits)
		FROM activity_daily WHERE `+where+`
		GROUP BY host
		ORDER BY SUM(seconds) DESC, host ASC
		LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []activity.HostStat
	for rows.Next() {
		var h activity.HostStat
		if err := rows.Scan(&h.Host, &h.Seconds, &h.Visits); err != nil {
			return nil, 0, err
		}
		out = append(out, h)
	}
	return out, total, rows.Err()
}

// PurgeBefore applies retention: aggregates older than the cutoff day and
// batch audit rows older than the cutoff instant.
func (s *ActivityStore) PurgeBefore(ctx context.Context, aggregateCutoffDay string, batchCutoff time.Time) (int64, error) {
	var removed int64
	res, err := s.db.ExecContext(ctx, `DELETE FROM activity_daily WHERE day < ?`, aggregateCutoffDay)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	removed += n
	res, err = s.db.ExecContext(ctx, `DELETE FROM activity_hourly WHERE day < ?`, aggregateCutoffDay)
	if err != nil {
		return removed, err
	}
	n, _ = res.RowsAffected()
	removed += n
	res, err = s.db.ExecContext(ctx, `DELETE FROM activity_batches WHERE received_at < ?`, formatTime(batchCutoff))
	if err != nil {
		return removed, err
	}
	n, _ = res.RowsAffected()
	return removed + n, nil
}
