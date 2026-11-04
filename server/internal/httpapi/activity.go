package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"pontis/internal/activity"
	"pontis/internal/canonical"
)

// --- handlers: activity ---
//
// Two surfaces. The ingest is device-credential territory (the extension's
// own lane); the reads are web-session territory, scoped to the session's
// user — nobody's browsing numbers are reachable through another principal,
// and no admin path exists by design.

type deviceActivityIngestRequest struct {
	Days []activity.DayEntry `json:"days"`
}

type deviceActivityIngestResponse struct {
	Results []deviceActivityDayAck `json:"results"`
}

type deviceActivityDayAck struct {
	Day    string `json:"day"`
	Status string `json:"status"`
}

// handleDeviceActivityIngest applies one replace-per-day batch. The device
// credential is the whole authorization: a device may only ever write its
// own rows, and the user_id comes from the device record, never from the
// body.
func (s *Server) handleDeviceActivityIngest(w http.ResponseWriter, r *http.Request) {
	d, ok := currentDevice(r)
	if !ok {
		s.writeError(w, r, http.StatusUnauthorized, "UNAUTHORIZED", "device credential required")
		return
	}
	var req deviceActivityIngestRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	applied, err := s.Activity.Ingest(r.Context(), d.OwnerUserID, d.ID, req.Days, time.Now())
	if err != nil {
		if mapped, status := activityValidationError(err); mapped != "" {
			s.writeError(w, r, status, mapped, err.Error())
			return
		}
		s.Logger.Error("activity ingest failed", "err", err, "device", d.ID)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	results := make([]deviceActivityDayAck, 0, len(applied))
	for _, day := range applied {
		results = append(results, deviceActivityDayAck{Day: day, Status: "accepted"})
	}
	writeJSON(w, http.StatusOK, deviceActivityIngestResponse{Results: results})
}

func activityValidationError(err error) (string, int) {
	switch {
	case errors.Is(err, activity.ErrEmptyBatch):
		return "BATCH_REQUIRED", http.StatusBadRequest
	case errors.Is(err, activity.ErrTooManyDays):
		return "BATCH_TOO_LARGE", http.StatusBadRequest
	case errors.Is(err, activity.ErrTooManyHosts):
		return "DAY_TOO_LARGE", http.StatusBadRequest
	case errors.Is(err, activity.ErrBadDay),
		errors.Is(err, activity.ErrBadHost),
		errors.Is(err, activity.ErrBadSeconds),
		errors.Is(err, activity.ErrBadVisits),
		errors.Is(err, activity.ErrBadHour):
		return "ACTIVITY_ROW_INVALID", http.StatusBadRequest
	default:
		return "", 0
	}
}

// activityRange parses the from/to query days, defaulting to the trailing
// seven local days. Days are date strings end to end: no timezone math
// happens on the server, because the day the client named is its own.
func activityRange(r *http.Request) (string, string) {
	today := time.Now().Format("2006-01-02")
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if !activity.ValidDay(from) {
		from = offsetDay(today, -6)
	}
	if !activity.ValidDay(to) {
		to = today
	}
	if from > to {
		from, to = to, from
	}
	return from, to
}

func offsetDay(day string, days int) string {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return day
	}
	return t.AddDate(0, 0, days).Format("2006-01-02")
}

func (s *Server) handleActivityOverview(w http.ResponseWriter, r *http.Request) {
	u, ok := currentUser(r)
	if !ok {
		s.writeError(w, r, http.StatusUnauthorized, "UNAUTHORIZED", "session required")
		return
	}
	from, to := activityRange(r)
	overview, err := s.Activity.Overview(r.Context(), canonical.UserID(u.ID), from, to, r.URL.Query().Get("device_id"))
	if err != nil {
		s.Logger.Error("activity overview failed", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, overview)
}

const (
	activityHostsDefaultLimit = 20
	activityHostsMaxLimit     = 100
)

func (s *Server) handleActivityHosts(w http.ResponseWriter, r *http.Request) {
	u, ok := currentUser(r)
	if !ok {
		s.writeError(w, r, http.StatusUnauthorized, "UNAUTHORIZED", "session required")
		return
	}
	from, to := activityRange(r)
	limit := activityHostsDefaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	if limit > activityHostsMaxLimit {
		limit = activityHostsMaxLimit
	}
	offset := 0
	if raw := r.URL.Query().Get("offset"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			offset = parsed
		}
	}
	page, err := s.Activity.Hosts(r.Context(), canonical.UserID(u.ID), from, to,
		r.URL.Query().Get("device_id"), limit, offset)
	if err != nil {
		s.Logger.Error("activity hosts failed", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, page)
}
