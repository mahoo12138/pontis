// Package activity holds the browsing-statistics domain: ingesting the
// replace-per-day batches the extension uploads, and reading them back for
// the analysis page.
//
// The domain's whole privacy stance lives in these types: a day entry is a
// host label and counters. There is no URL, no title, no timestamp finer
// than a local calendar day (plus a host-agnostic hour histogram), so the
// storage cannot hold what the protocol never carried.
package activity

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
)

// HostRow is one host's totals for one local day.
type HostRow struct {
	Host    string
	Seconds int64
	Visits  int64
}

// HourRow is one clock hour's attention seconds for one local day,
// across all hosts.
type HourRow struct {
	Hour    int
	Seconds int64
}

// DayEntry is the complete upload for one (device, day): the batch entry the
// server's stored rows are replaced with.
type DayEntry struct {
	Day   string
	Hosts []HostRow
	Hours []HourRow
}

// Batch limits, mirrored from the extension's wire module. A device that
// returns from a month offline splits its catch-up; one request can never
// hold the whole queue hostage.
const (
	MaxDaysPerBatch  = 14
	MaxHostsPerDay   = 500
	MaxHostLength    = 253
	MaxSecondsPerDay = 24 * 60 * 60
)

var dayPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// ValidDay reports whether day looks like a YYYY-MM-DD calendar string. The
// query handlers share the ingest's strictness: a malformed day is refused,
// never silently defaulted.
func ValidDay(day string) bool { return dayPattern.MatchString(day) }

// Validation failures carry a machine code the handler maps straight onto
// the error envelope, the way doc 04 §14 prescribes for the sync protocol.
var (
	ErrEmptyBatch     = errors.New("activity: batch has no days")
	ErrTooManyDays    = errors.New("activity: batch has too many days")
	ErrBadDay         = errors.New("activity: day must be YYYY-MM-DD")
	ErrTooManyHosts   = errors.New("activity: day has too many host rows")
	ErrBadHost        = errors.New("activity: host must be a hostname of at most 253 characters")
	ErrBadSeconds     = errors.New("activity: seconds out of range")
	ErrBadVisits      = errors.New("activity: visits out of range")
	ErrBadHour        = errors.New("activity: hour out of range")
	ErrDeviceNotFound = errors.New("activity: device not found")
)

// Store is the persistence boundary.
type Store interface {
	// ReplaceDay swaps the stored rows for (userID, deviceID, day) with the
	// entry, in one transaction. Returns false when the day was a no-op
	// replay of an already-recorded batch id.
	ReplaceDay(ctx context.Context, userID canonical.UserID, deviceID, batchID string,
		entry DayEntry, receivedAt time.Time) (bool, error)
	// Overview aggregates totals, per-day totals and the 24-hour histogram
	// across the user's devices (one device when deviceID is set).
	Overview(ctx context.Context, userID canonical.UserID, fromDay, toDay, deviceID string) (Overview, error)
	// Hosts ranks hosts across the range. Total is the rank-before-paging,
	// so the page can size itself.
	Hosts(ctx context.Context, userID canonical.UserID, fromDay, toDay, deviceID string,
		limit, offset int) ([]HostStat, int, error)
	// PurgeBefore drops aggregates older than the retention day and the
	// batch audit trail older than the given instant.
	PurgeBefore(ctx context.Context, aggregateCutoffDay string, batchCutoff time.Time) (removed int64, err error)
}

// Totals is the range summary the overview header shows.
type Totals struct {
	Seconds int64 `json:"seconds"`
	Visits  int64 `json:"visits"`
}

// DayTotal is one day's line in the trend.
type DayTotal struct {
	Day     string `json:"day"`
	Seconds int64  `json:"seconds"`
	Visits  int64  `json:"visits"`
}

// Overview is the GET /activity/overview body.
type Overview struct {
	From    string     `json:"from"`
	To      string     `json:"to"`
	Totals  Totals     `json:"totals"`
	ByDay   []DayTotal `json:"by_day"`
	// ByHour has exactly 24 slots, index = local clock hour. A fixed-length
	// array spares the chart from re-bucketing and shows empty hours as 0.
	ByHour []int64 `json:"by_hour"`
}

// HostStat is one line of the host ranking.
type HostStat struct {
	Host    string `json:"host"`
	Seconds int64  `json:"seconds"`
	Visits  int64  `json:"visits"`
}

// HostPage is the GET /activity/hosts body.
type HostPage struct {
	Total int        `json:"total"`
	Items []HostStat `json:"items"`
}

// Service is the activity domain service.
type Service struct {
	store Store
}

// NewService wires the service onto a store.
func NewService(store Store) *Service { return &Service{store: store} }

// Ingest validates and applies one replace-per-day batch. It answers the
// days the server actually applied, in the order received — the extension
// marks exactly these as sent.
func (s *Service) Ingest(ctx context.Context, userID canonical.UserID, deviceID string,
	days []DayEntry, now time.Time) ([]string, error) {
	if len(days) == 0 {
		return nil, ErrEmptyBatch
	}
	if len(days) > MaxDaysPerBatch {
		return nil, fmt.Errorf("%w: %d > %d", ErrTooManyDays, len(days), MaxDaysPerBatch)
	}
	batchID, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	applied := make([]string, 0, len(days))
	for _, entry := range days {
		if err := validateDay(entry); err != nil {
			return nil, err
		}
		ok, err := s.store.ReplaceDay(ctx, userID, deviceID, batchID.String(), entry, now)
		if err != nil {
			return nil, err
		}
		if ok {
			applied = append(applied, entry.Day)
		}
	}
	return applied, nil
}

func validateDay(entry DayEntry) error {
	if !dayPattern.MatchString(entry.Day) {
		return fmt.Errorf("%w: %q", ErrBadDay, entry.Day)
	}
	if len(entry.Hosts) > MaxHostsPerDay {
		return fmt.Errorf("%w: %d > %d", ErrTooManyHosts, len(entry.Hosts), MaxHostsPerDay)
	}
	if len(entry.Hours) > 24 {
		return fmt.Errorf("%w: %d > 24", ErrBadHour, len(entry.Hours))
	}
	for _, h := range entry.Hosts {
		host := strings.ToLower(strings.TrimSuffix(h.Host, "."))
		if host == "" || len(host) > MaxHostLength || strings.ContainsAny(host, "/ \t\r\n") {
			return fmt.Errorf("%w: %q", ErrBadHost, h.Host)
		}
		if h.Seconds < 0 || h.Seconds > MaxSecondsPerDay {
			return fmt.Errorf("%w: %d for host %q", ErrBadSeconds, h.Seconds, h.Host)
		}
		if h.Visits < 0 {
			return fmt.Errorf("%w: %d for host %q", ErrBadVisits, h.Visits, h.Host)
		}
	}
	seenHours := make(map[int]bool, len(entry.Hours))
	for _, hr := range entry.Hours {
		if hr.Hour < 0 || hr.Hour > 23 {
			return fmt.Errorf("%w: %d", ErrBadHour, hr.Hour)
		}
		if hr.Seconds < 0 || hr.Seconds > MaxSecondsPerDay {
			return fmt.Errorf("%w: %d for hour %d", ErrBadSeconds, hr.Seconds, hr.Hour)
		}
		if seenHours[hr.Hour] {
			return fmt.Errorf("%w: %d twice", ErrBadHour, hr.Hour)
		}
		seenHours[hr.Hour] = true
	}
	return nil
}

// Overview aggregates the range for the user's own devices.
func (s *Service) Overview(ctx context.Context, userID canonical.UserID,
	fromDay, toDay, deviceID string) (Overview, error) {
	return s.store.Overview(ctx, userID, fromDay, toDay, deviceID)
}

// Hosts ranks the range's hosts.
func (s *Service) Hosts(ctx context.Context, userID canonical.UserID,
	fromDay, toDay, deviceID string, limit, offset int) (HostPage, error) {
	items, total, err := s.store.Hosts(ctx, userID, fromDay, toDay, deviceID, limit, offset)
	if err != nil {
		return HostPage{}, err
	}
	if items == nil {
		items = []HostStat{}
	}
	return HostPage{Total: total, Items: items}, nil
}

// Purge applies the retention policy; it runs from the activity.gc job.
func (s *Service) Purge(ctx context.Context, aggregateCutoffDay string, batchCutoff time.Time) (int64, error) {
	return s.store.PurgeBefore(ctx, aggregateCutoffDay, batchCutoff)
}
