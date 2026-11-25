package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// R21: global body limit returns 413 PAYLOAD_TOO_LARGE, /sync caps operations
// per batch at 200 with 400 TOO_MANY_OPERATIONS, and public auth enforces
// rate limiting with 429 RATE_LIMITED + Retry-After.
func TestHardeningBodyLimitsSyncCapRateLimitAndBackupProtection(t *testing.T) {
	st := bootstrapFlow(t)
	h := map[string]string{"Authorization": "Bearer " + st.sessionToken}
	deviceAuth := map[string]string{"Authorization": "Bearer " + st.deviceToken}

	// 1. Oversized request body (> 2 MiB default limit) -> 413 PAYLOAD_TOO_LARGE.
	hugeBody := []byte(`{"name":"` + strings.Repeat("a", 2<<20+1024) + `"}`)
	req, err := http.NewRequest("POST", st.ts.URL+"/api/v1/spaces", bytes.NewReader(hugeBody))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+st.sessionToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var errPayload map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&errPayload)
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge || errCode(t, errPayload) != "PAYLOAD_TOO_LARGE" {
		t.Fatalf("oversized body = %d %v, want 413 PAYLOAD_TOO_LARGE", resp.StatusCode, errPayload)
	}

	// 2. Sync batch exceeding 200 operations -> 400 TOO_MANY_OPERATIONS.
	ops := make([]map[string]any, 201)
	for i := range ops {
		ops[i] = map[string]any{
			"op_id": fmt.Sprintf("op-%d", i), "client_seq": i + 1, "base_revision": 0,
			"type": "create", "node_type": "bookmark", "title": "X", "url": "https://x.test",
			"parent": map[string]string{"type": "root", "key": "main"},
		}
	}
	code, body := doJSON(t, "POST", st.ts.URL+"/api/v1/sync/bindings/"+st.bindingID, deviceAuth, map[string]any{
		"protocol_version": 1, "epoch": 1,
		"applied_revision": 0, "received_revision": 0, "max_changes": 100,
		"operations": ops,
	})
	if code != http.StatusBadRequest || errCode(t, body) != "TOO_MANY_OPERATIONS" {
		t.Fatalf("over-limit sync ops = %d %v, want 400 TOO_MANY_OPERATIONS", code, body)
	}

	// 3. Protected backup cannot be deleted until unprotected (409 BACKUP_PROTECTED).
	code, b := doJSON(t, "POST", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/backups", h, nil)
	if code != http.StatusCreated {
		t.Fatalf("create backup = %d %v", code, b)
	}
	backupID := b["id"].(string)
	code, _ = doJSON(t, "PATCH", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/backups/"+backupID, h, map[string]any{"protected": true})
	if code != http.StatusOK {
		t.Fatalf("protect backup = %d", code)
	}
	code, body = doJSON(t, "DELETE", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/backups/"+backupID, h, nil)
	if code != http.StatusConflict || errCode(t, body) != "BACKUP_PROTECTED" {
		t.Fatalf("delete protected backup = %d %v, want 409 BACKUP_PROTECTED", code, body)
	}

	// 4. Rate limiter rejects burst login attempts with 429 RATE_LIMITED + Retry-After.
	st.srv.AuthRateLimit = NewRateLimiter(3, time.Minute, 3, time.Minute)
	var rateLimited bool
	for i := 0; i < 6; i++ {
		lreq, _ := http.NewRequest("POST", st.ts.URL+"/api/v1/auth/login",
			strings.NewReader(`{"username":"alice","password":"wrong-password"}`))
		lreq.Header.Set("Content-Type", "application/json")
		lresp, lerr := http.DefaultClient.Do(lreq)
		if lerr != nil {
			t.Fatal(lerr)
		}
		var lbody map[string]any
		_ = json.NewDecoder(lresp.Body).Decode(&lbody)
		lresp.Body.Close()
		if lresp.StatusCode == http.StatusTooManyRequests {
			if errCode(t, lbody) != "RATE_LIMITED" || lresp.Header.Get("Retry-After") == "" {
				t.Fatalf("429 response missing RATE_LIMITED or Retry-After: %v %v", lbody, lresp.Header)
			}
			rateLimited = true
			break
		}
	}
	if !rateLimited {
		t.Fatal("burst login attempts were never rate limited")
	}
}
