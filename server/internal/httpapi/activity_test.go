package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The activity handlers' contract: ingest is device-credential territory and
// writes only that device's rows; reads are session territory and scoped to
// the session's user; the stored granularity is day × host and there is no
// way to get a URL back out, because none went in.

func activityDeviceToken(t *testing.T, ts *httptest.Server, sessionToken, name string) string {
	t.Helper()
	device := restPOST(t, ts, sessionToken, "/api/v1/devices", map[string]string{
		"name": name, "browser": "chrome", "platform": "macos",
	})
	token, _ := device["token"].(string)
	if token == "" {
		t.Fatalf("device registration returned no token: %v", device)
	}
	return token
}

func ingestBatch(t *testing.T, ts *httptest.Server, deviceToken string, body map[string]any) map[string]any {
	t.Helper()
	return restPOST(t, ts, deviceToken, "/api/v1/device/activity/batches", body)
}

func batchBody(entries ...map[string]any) map[string]any {
	return map[string]any{"days": entries}
}

func dayEntry(day string, hosts []map[string]any, hours []map[string]any) map[string]any {
	return map[string]any{"day": day, "hosts": hosts, "hours": hours}
}

func host(host string, seconds int, visits int) map[string]any {
	return map[string]any{"host": host, "seconds": seconds, "visits": visits}
}

func hour(h int, seconds int) map[string]any {
	return map[string]any{"hour": h, "seconds": seconds}
}

func TestActivityIngestReplacesPerDay(t *testing.T) {
	srv, ts := newTestServer(t)
	_ = srv
	token := restBootstrap(t, ts)
	deviceToken := activityDeviceToken(t, ts, token, "Chrome@Home")

	day := "2026-11-03"
	ingestBatch(t, ts, deviceToken, batchBody(
		dayEntry(day, []map[string]any{host("github.com", 600, 2)}, []map[string]any{hour(10, 600)}),
	))

	// A corrected entry for the same day REPLACES the rows: re-sending is
	// how the client converges, so it must never double.
	ingestBatch(t, ts, deviceToken, batchBody(
		dayEntry(day, []map[string]any{host("github.com", 900, 3)}, []map[string]any{hour(10, 600), hour(22, 300)}),
	))

	overview := restGET(t, ts, token, "/api/v1/activity/overview?from=2026-11-01&to=2026-11-30")
	totals := overview["totals"].(map[string]any)
	if got := totals["seconds"].(float64); got != 900 {
		t.Fatalf("totals.seconds = %v, want 900 (replace, not add)", got)
	}
	byDay := overview["by_day"].([]any)
	if len(byDay) != 1 {
		t.Fatalf("by_day rows = %d, want 1", len(byDay))
	}
	byHour := overview["by_hour"].([]any)
	if len(byHour) != 24 {
		t.Fatalf("by_hour slots = %d, want 24", len(byHour))
	}
	if byHour[10].(float64) != 600 || byHour[22].(float64) != 300 {
		t.Fatalf("by_hour[10]=%v by_hour[22]=%v, want 600/300", byHour[10], byHour[22])
	}

	hosts := restGET(t, ts, token, "/api/v1/activity/hosts?from=2026-11-01&to=2026-11-30")
	if hosts["total"].(float64) != 1 {
		t.Fatalf("hosts.total = %v, want 1", hosts["total"])
	}
	item := hosts["items"].([]any)[0].(map[string]any)
	if item["host"] != "github.com" || item["seconds"].(float64) != 900 {
		t.Fatalf("host row = %v, want github.com/900", item)
	}
}

func TestActivityFocusMetricsReplaceAndAggregate(t *testing.T) {
	_, ts := newTestServer(t)
	token := restBootstrap(t, ts)
	deviceToken := activityDeviceToken(t, ts, token, "Chrome@Home")

	day := "2026-11-03"
	switches := int64(42)
	longest := int64(1500)
	ingestBatch(t, ts, deviceToken, batchBody(dayEntry(day,
		[]map[string]any{host("github.com", 600, 2)}, nil)))
	// Re-send with focus metrics attached: the replace carries them, and a
	// later batch without them would drop them again — one day, one truth.
	ingestWithMetrics(t, ts, deviceToken, day, &switches, &longest)

	overview := restGET(t, ts, token, "/api/v1/activity/overview?from=2026-11-01&to=2026-11-30")
	metrics := overview["metrics"].(map[string]any)
	if metrics["switches"].(float64) != 42 || metrics["longest_focus_seconds"].(float64) != 1500 {
		t.Fatalf("metrics = %v, want switches 42 longest 1500", metrics)
	}
}

// ingestWithMetrics posts a batch whose day entry carries the optional focus
// fields; the plain batchBody helper cannot express nil-able pointers.
func ingestWithMetrics(t *testing.T, ts *httptest.Server, deviceToken, day string, switches, longest *int64) map[string]any {
	t.Helper()
	body := map[string]any{"days": []any{map[string]any{
		"day": day, "hosts": []any{}, "hours": []any{},
		"switches": switches, "longest_focus_seconds": longest,
	}}}
	return restPOST(t, ts, deviceToken, "/api/v1/device/activity/batches", body)
}

func TestActivityIngestRequiresDeviceCredential(t *testing.T) {
	_, ts := newTestServer(t)
	restExpect(t, ts, "", http.StatusUnauthorized, http.MethodPost,
		"/api/v1/device/activity/batches", batchBody(dayEntry("2026-11-03", nil, nil)))
}

func TestActivityIngestValidatesRows(t *testing.T) {
	_, ts := newTestServer(t)
	token := restBootstrap(t, ts)
	deviceToken := activityDeviceToken(t, ts, token, "Chrome@Home")

	cases := []struct {
		name string
		body map[string]any
	}{
		{"empty batch", batchBody()},
		{"bad day", batchBody(dayEntry("11/03/2026", []map[string]any{host("github.com", 10, 1)}, nil))},
		{"url in host field", batchBody(dayEntry("2026-11-03",
			[]map[string]any{host("https://github.com/x", 10, 1)}, nil))},
		{"seconds over a day", batchBody(dayEntry("2026-11-03",
			[]map[string]any{host("github.com", 90000, 1)}, nil))},
		{"negative visits", batchBody(dayEntry("2026-11-03",
			[]map[string]any{host("github.com", 10, -1)}, nil))},
		{"hour out of range", batchBody(dayEntry("2026-11-03", nil, []map[string]any{hour(24, 60)}))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := restExpect(t, ts, deviceToken, http.StatusBadRequest, http.MethodPost,
				"/api/v1/device/activity/batches", tc.body)
			if out["error"].(map[string]any)["code"] != "ACTIVITY_ROW_INVALID" &&
				out["error"].(map[string]any)["code"] != "BATCH_REQUIRED" {
				t.Fatalf("error code = %v", out["error"])
			}
		})
	}
}

func TestActivityScopesToUser(t *testing.T) {
	_, ts := newTestServer(t)
	alice := restBootstrap(t, ts)
	aliceDevice := activityDeviceToken(t, ts, alice, "Alice@Home")
	ingestBatch(t, ts, aliceDevice, batchBody(
		dayEntry("2026-11-03", []map[string]any{host("github.com", 600, 2)}, nil),
	))

	// A second account exists and looks: it must not see Alice's numbers,
	// and its own overview is empty rather than an error. The setup account
	// is the admin, so the second user comes from the admin surface.
	restPOST(t, ts, alice, "/api/v1/admin/users", map[string]string{
		"username": "bob", "password": "password123", "email": "bob@example.com",
	})
	bob := restPOST(t, ts, "", "/api/v1/auth/login", map[string]string{
		"username": "bob", "password": "password123",
	})["token"].(string)

	overview := restGET(t, ts, bob, "/api/v1/activity/overview?from=2026-11-01&to=2026-11-30")
	if got := overview["totals"].(map[string]any)["seconds"].(float64); got != 0 {
		t.Fatalf("bob saw alice's activity: %v", got)
	}
	hosts := restGET(t, ts, bob, "/api/v1/activity/hosts?from=2026-11-01&to=2026-11-30")
	if hosts["total"].(float64) != 0 {
		t.Fatalf("bob saw alice's hosts: %v", hosts["total"])
	}
}

func TestActivityDeviceDeleteCascades(t *testing.T) {
	_, ts := newTestServer(t)
	token := restBootstrap(t, ts)
	deviceToken := activityDeviceToken(t, ts, token, "Chrome@Old")
	deviceID := ""
	for _, d := range restGET(t, ts, token, "/api/v1/devices/overview")["devices"].([]any) {
		deviceID = d.(map[string]any)["id"].(string)
		break
	}
	ingestBatch(t, ts, deviceToken, batchBody(
		dayEntry("2026-11-03", []map[string]any{host("github.com", 600, 2)}, nil),
	))
	overview := restGET(t, ts, token, "/api/v1/activity/overview?from=2026-11-01&to=2026-11-30")
	if overview["totals"].(map[string]any)["seconds"].(float64) != 600 {
		t.Fatal("ingest did not land")
	}

	// Removing the device removes its statistics with it — "delete" means
	// "no trace", not "orphan the rows". Revoke first: a live device cannot
	// be deleted, and that order is the account page's guardrail too.
	restExpect(t, ts, token, http.StatusNoContent, http.MethodPost,
		fmt.Sprintf("/api/v1/devices/%s/revoke", deviceID), map[string]any{})
	restExpect(t, ts, token, http.StatusNoContent, http.MethodDelete,
		fmt.Sprintf("/api/v1/devices/%s", deviceID), nil)
	overview = restGET(t, ts, token, "/api/v1/activity/overview?from=2026-11-01&to=2026-11-30")
	if got := overview["totals"].(map[string]any)["seconds"].(float64); got != 0 {
		t.Fatalf("device deletion left %v seconds of activity behind", got)
	}
}

func TestActivityHostsPaging(t *testing.T) {
	_, ts := newTestServer(t)
	token := restBootstrap(t, ts)
	deviceToken := activityDeviceToken(t, ts, token, "Chrome@Home")

	hosts := make([]map[string]any, 0, 5)
	for i := 0; i < 5; i++ {
		hosts = append(hosts, host(fmt.Sprintf("h%d.example", i), (5-i)*100, 1))
	}
	ingestBatch(t, ts, deviceToken, batchBody(dayEntry("2026-11-03", hosts, nil)))

	page1 := restGET(t, ts, token, "/api/v1/activity/hosts?from=2026-11-01&to=2026-11-30&limit=2")
	if page1["total"].(float64) != 5 || len(page1["items"].([]any)) != 2 {
		t.Fatalf("page1 = %v", page1)
	}
	if page1["items"].([]any)[0].(map[string]any)["host"] != "h0.example" {
		t.Fatalf("ranking not seconds-descending: %v", page1)
	}
	page2 := restGET(t, ts, token, "/api/v1/activity/hosts?from=2026-11-01&to=2026-11-30&limit=2&offset=4")
	if len(page2["items"].([]any)) != 1 {
		t.Fatalf("page2 = %v", page2)
	}
}

func TestActivityIngestNormalizesAndRejectsDuplicateHosts(t *testing.T) {
	_, ts := newTestServer(t)
	token := restBootstrap(t, ts)
	deviceToken := activityDeviceToken(t, ts, token, "Chrome@Home")

	// Trailing dot normalizes cleanly on insert.
	ingestBatch(t, ts, deviceToken, batchBody(
		dayEntry("2026-11-04", []map[string]any{host("GitHub.COM.", 120, 2)}, nil),
	))
	hosts := restGET(t, ts, token, "/api/v1/activity/hosts?from=2026-11-01&to=2026-11-30")
	item := hosts["items"].([]any)[0].(map[string]any)
	if item["host"] != "github.com" {
		t.Fatalf("stored host = %v, want github.com", item["host"])
	}

	// Duplicate host after normalization (with/without trailing dot) is rejected
	// as 400 ACTIVITY_ROW_INVALID rather than failing with 500 PK collision.
	out := restExpect(t, ts, deviceToken, http.StatusBadRequest, http.MethodPost,
		"/api/v1/device/activity/batches", batchBody(
			dayEntry("2026-11-05", []map[string]any{
				host("github.com", 60, 1),
				host("github.com.", 60, 1),
			}, nil),
		))
	if out["error"].(map[string]any)["code"] != "ACTIVITY_ROW_INVALID" {
		t.Fatalf("duplicate host error = %v, want ACTIVITY_ROW_INVALID", out["error"])
	}
}
