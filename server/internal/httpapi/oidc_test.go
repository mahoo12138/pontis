package httpapi

// OIDC single sign-on, exercised end to end against a stub provider hosted
// on httptest: real discovery, real token exchange, real ID-token signature
// verification — only the person at the provider's login page is simulated.

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"pontis/internal/auth"
)

// --- stub OIDC provider ---

type stubCodeGrant struct {
	challenge string
	nonce     string
	claims    stubClaims
}

// stubClaims is the profile the stub bakes into the ID token it mints for a
// code — the person who "authenticated" at the provider's authorize step.
type stubClaims struct {
	sub           string
	username      string
	email         string
	emailVerified bool
}

type stubIdP struct {
	ts           *httptest.Server
	key          *rsa.PrivateKey
	kid          string
	clientID     string
	clientSecret string

	mu    sync.Mutex
	codes map[string]stubCodeGrant
	// breakage switches a test flips before completing a flow to verify the
	// server rejects what it should reject.
	breakNonce  bool
	breakSigner bool
}

func newStubIdP(t *testing.T) *stubIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa key: %v", err)
	}
	idp := &stubIdP{
		key:          key,
		kid:          "stub-key",
		clientID:     "pontis-test",
		clientSecret: "pontis-test-secret",
		codes:        map[string]stubCodeGrant{},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"issuer":                                idp.ts.URL,
			"authorization_endpoint":                idp.ts.URL + "/authorize",
			"token_endpoint":                        idp.ts.URL + "/token",
			"jwks_uri":                              idp.ts.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"keys": []map[string]string{{
				"kty": "RSA", "use": "sig", "alg": "RS256", "kid": idp.kid,
				"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
				"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
			}},
		})
	})
	mux.HandleFunc("/token", idp.handleToken)

	idp.ts = httptest.NewServer(mux)
	t.Cleanup(idp.ts.Close)
	return idp
}

// issueCode plays the provider's authorize step: the browser would have
// authenticated there, and the provider would hand back a code bound to the
// challenge and nonce the server put in the authorize URL, plus the profile
// of whoever just signed in.
func (idp *stubIdP) issueCode(challenge, nonce string, claims stubClaims) string {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	code := base64.RawURLEncoding.EncodeToString(raw)
	idp.mu.Lock()
	defer idp.mu.Unlock()
	idp.codes[code] = stubCodeGrant{challenge: challenge, nonce: nonce, claims: claims}
	return code
}

func (idp *stubIdP) handleToken(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	if r.Form.Get("client_id") != idp.clientID || r.Form.Get("client_secret") != idp.clientSecret {
		http.Error(w, "invalid_client", http.StatusUnauthorized)
		return
	}
	idp.mu.Lock()
	grant, ok := idp.codes[r.Form.Get("code")]
	delete(idp.codes, r.Form.Get("code"))
	idp.mu.Unlock()
	if !ok {
		http.Error(w, "invalid_grant", http.StatusBadRequest)
		return
	}
	// PKCE: S256(verifier) must match the challenge bound to the code.
	sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
	if base64.RawURLEncoding.EncodeToString(sum[:]) != grant.challenge {
		http.Error(w, "pkce verification failed", http.StatusBadRequest)
		return
	}

	nonce := grant.nonce
	if idp.breakNonce {
		nonce = "not-the-nonce-the-flow-started-with"
	}
	idt := idp.signIDToken(map[string]any{
		"iss":                idp.ts.URL,
		"sub":                grant.claims.sub,
		"aud":                idp.clientID,
		"exp":                time.Now().Add(5 * time.Minute).Unix(),
		"iat":                time.Now().Unix(),
		"nonce":              nonce,
		"email":              grant.claims.email,
		"email_verified":     grant.claims.emailVerified,
		"preferred_username": grant.claims.username,
		"name":               grant.claims.username,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": "stub-access-token",
		"token_type":   "Bearer",
		"id_token":     idt,
	})
}

// signIDToken produces a compact RS256 JWT. When breakSigner is set, the
// token is signed by a stranger's key: verification must refuse it.
func (idp *stubIdP) signIDToken(claims map[string]any) string {
	key := idp.key
	if idp.breakSigner {
		stranger, _ := rsa.GenerateKey(rand.Reader, 2048)
		key = stranger
	}
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT", "kid": idp.kid})
	payload, _ := json.Marshal(claims)
	signingInput := base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		panic(err)
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// --- test server wiring ---

// browserClient stops at the first redirect (a real browser would hop to the
// provider, which the test plays by hand) and keeps cookies, so the state
// cookie reaches the callback and the session cookie reaches /auth/me.
func browserClient() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{
		Jar: jar,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func newOIDCTestServer(t *testing.T, tweak func(*auth.OIDCSettings)) (*Server, *httptest.Server, *stubIdP) {
	t.Helper()
	idp := newStubIdP(t)
	srv, ts, _ := newTestServerWithDB(t)
	settings := auth.OIDCSettings{
		IssuerURL:     idp.ts.URL,
		ClientID:      idp.clientID,
		ClientSecret:  idp.clientSecret,
		Scopes:        []string{"openid", "profile", "email"},
		AutoProvision: true,
	}
	if tweak != nil {
		tweak(&settings)
	}
	svc, err := auth.NewOIDCService(context.Background(), srv.Auth, settings)
	if err != nil {
		t.Fatalf("oidc service: %v", err)
	}
	srv.OIDC = svc
	return srv, ts, idp
}

// doJSONWithClient is doJSON through a specific client, so cookie-session
// flows (the jar) can drive endpoints the way a browser would.
func doJSONWithClient(t *testing.T, client *http.Client, method, url string, headers map[string]string, body any) (int, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, url, &buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	if resp.StatusCode == http.StatusNoContent || resp.Header.Get("Content-Length") == "0" {
		return resp.StatusCode, out
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("%s %s: non-JSON body %q", method, url, raw)
	}
	return resp.StatusCode, out
}

// ssoStart drives GET /auth/oidc/start and returns the authorize URL the
// server redirected to.
func ssoStart(t *testing.T, client *http.Client, tsURL, returnTo string) string {
	t.Helper()
	start := tsURL + "/api/v1/auth/oidc/start"
	if returnTo != "" {
		start += "?return_to=" + url.QueryEscape(returnTo)
	}
	resp, err := client.Get(start)
	if err != nil {
		t.Fatalf("oidc start: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("oidc start = %d, want 302", resp.StatusCode)
	}
	loc := resp.Header.Get("Location")
	if !strings.HasPrefix(loc, "http") {
		t.Fatalf("oidc start Location = %q", loc)
	}
	return loc
}

// ssoComplete plays the provider's authorize step and drives the callback.
// The profile passed here is what the stub bakes into the ID token.
func ssoComplete(t *testing.T, client *http.Client, tsURL string, idp *stubIdP, authorizeURL string, sub, username, email string, emailVerified bool) *http.Response {
	t.Helper()
	u, err := url.Parse(authorizeURL)
	if err != nil {
		t.Fatalf("parse authorize url: %v", err)
	}
	q := u.Query()
	code := idp.issueCode(q.Get("code_challenge"), q.Get("nonce"), stubClaims{
		sub: sub, username: username, email: email, emailVerified: emailVerified,
	})

	callback := tsURL + "/api/v1/auth/oidc/callback?code=" + url.QueryEscape(code) +
		"&state=" + url.QueryEscape(q.Get("state"))
	cbResp, err := client.Get(callback)
	if err != nil {
		t.Fatalf("oidc callback: %v", err)
	}
	t.Cleanup(func() { cbResp.Body.Close() })
	return cbResp
}

func redirectQuery(t *testing.T, resp *http.Response) url.Values {
	t.Helper()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("callback = %d, want 302", resp.StatusCode)
	}
	u, err := url.Parse(resp.Header.Get("Location"))
	if err != nil {
		t.Fatalf("parse redirect: %v", err)
	}
	return u.Query()
}

// --- tests ---

func TestOIDCLoginAutoProvisionsUser(t *testing.T) {
	_, ts, idp := newOIDCTestServer(t, nil)
	setupAdmin(t, ts)
	client := browserClient()

	authorizeURL := ssoStart(t, client, ts.URL, "")
	resp := ssoComplete(t, client, ts.URL, idp, authorizeURL, "sub-ray", "ray", "ray@example.com", true)
	if loc := resp.Header.Get("Location"); loc != "/" {
		t.Fatalf("landing = %q, want /", loc)
	}

	code, body := doJSONWithClient(t, client, "GET", ts.URL+"/api/v1/auth/me", nil, nil)
	if code != http.StatusOK {
		t.Fatalf("me after sso = %d %v", code, body)
	}
	if body["username"] != "ray" || body["role"] != "user" {
		t.Fatalf("provisioned user = %v/%v, want ray/user", body["username"], body["role"])
	}

	// The account doc 09 §4 promises: a fresh account opens with a workspace.
	code, body = doJSONWithClient(t, client, "GET", ts.URL+"/api/v1/spaces", nil, nil)
	if code != http.StatusOK {
		t.Fatalf("spaces = %d %v", code, body)
	}
	if spaces, _ := body["spaces"].([]any); len(spaces) == 0 {
		t.Fatalf("provisioned user has no spaces: %v", body)
	}
}

func TestOIDCLinksByEmailThenRemembersSubject(t *testing.T) {
	_, ts, idp := newOIDCTestServer(t, nil)
	adminToken := setupAdmin(t, ts)
	code, body := doJSON(t, "POST", ts.URL+"/api/v1/admin/users",
		map[string]string{"Authorization": "Bearer " + adminToken},
		map[string]string{"username": "carol", "password": "password123", "email": "carol@example.com"})
	if code != http.StatusCreated {
		t.Fatalf("admin create carol = %d %v", code, body)
	}

	client := browserClient()
	// The IdP username differs from the local one: only the verified email
	// can explain the link.
	authorizeURL := ssoStart(t, client, ts.URL, "")
	resp := ssoComplete(t, client, ts.URL, idp, authorizeURL, "sub-carol", "carol.idp", "carol@example.com", true)
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != "/" {
		t.Fatalf("linking login = %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	code, body = doJSONWithClient(t, client, "GET", ts.URL+"/api/v1/auth/me", nil, nil)
	if code != http.StatusOK || body["username"] != "carol" {
		t.Fatalf("linked user = %d %v, want carol", code, body)
	}

	// From now on the immutable subject decides: the email changing at the
	// provider must not re-point the identity.
	authorizeURL = ssoStart(t, client, ts.URL, "")
	resp = ssoComplete(t, client, ts.URL, idp, authorizeURL, "sub-carol", "carol.idp", "carol.moved@example.com", true)
	if resp.Header.Get("Location") != "/" {
		t.Fatalf("second login = %s", resp.Header.Get("Location"))
	}
	code, body = doJSONWithClient(t, client, "GET", ts.URL+"/api/v1/auth/me", nil, nil)
	if code != http.StatusOK || body["username"] != "carol" {
		t.Fatalf("subject-resolved user = %d %v, want carol", code, body)
	}
}

func TestOIDCUnverifiedEmailDoesNotLink(t *testing.T) {
	_, ts, idp := newOIDCTestServer(t, nil)
	adminToken := setupAdmin(t, ts)
	code, body := doJSON(t, "POST", ts.URL+"/api/v1/admin/users",
		map[string]string{"Authorization": "Bearer " + adminToken},
		map[string]string{"username": "bob", "password": "password123", "email": "bob@example.com"})
	if code != http.StatusCreated {
		t.Fatalf("admin create bob = %d %v", code, body)
	}

	client := browserClient()
	authorizeURL := ssoStart(t, client, ts.URL, "")
	resp := ssoComplete(t, client, ts.URL, idp, authorizeURL, "sub-imposter", "bob", "bob@example.com", false)
	if resp.Header.Get("Location") != "/" {
		t.Fatalf("unverified email login = %s", resp.Header.Get("Location"))
	}
	code, body = doJSONWithClient(t, client, "GET", ts.URL+"/api/v1/auth/me", nil, nil)
	if code != http.StatusOK {
		t.Fatalf("me = %d %v", code, body)
	}
	if body["username"] == "bob" {
		t.Fatal("an unverified email claim linked someone else's account")
	}
	if body["role"] != "user" {
		t.Fatalf("provisioned role = %v, want user", body["role"])
	}
}

func TestOIDCAutoProvisionOffRejectsUnknownIdentity(t *testing.T) {
	_, ts, idp := newOIDCTestServer(t, func(s *auth.OIDCSettings) { s.AutoProvision = false })
	setupAdmin(t, ts)
	client := browserClient()

	authorizeURL := ssoStart(t, client, ts.URL, "")
	resp := ssoComplete(t, client, ts.URL, idp, authorizeURL, "sub-nobody", "nobody", "nobody@example.com", true)
	q := redirectQuery(t, resp)
	if q.Get("error") != "OIDC_ACCOUNT_NOT_LINKED" {
		t.Fatalf("error = %v, want OIDC_ACCOUNT_NOT_LINKED", q)
	}
	code, body := doJSONWithClient(t, client, "GET", ts.URL+"/api/v1/auth/me", nil, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("me = %d, want 401 (body %v)", code, body)
	}
}

func TestOIDCStateReplayFails(t *testing.T) {
	_, ts, idp := newOIDCTestServer(t, nil)
	setupAdmin(t, ts)
	client := browserClient()

	authorizeURL := ssoStart(t, client, ts.URL, "")
	resp := ssoComplete(t, client, ts.URL, idp, authorizeURL, "sub-once", "once", "once@example.com", true)
	if resp.Header.Get("Location") != "/" {
		t.Fatalf("first login = %s", resp.Header.Get("Location"))
	}

	// Replay the exact callback: the state was consumed by the first pass.
	u, _ := url.Parse(authorizeURL)
	q := u.Query()
	replay := ts.URL + "/api/v1/auth/oidc/callback?code=anything&state=" + url.QueryEscape(q.Get("state"))
	resp2, err := client.Get(replay)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	defer resp2.Body.Close()
	if eq := redirectQuery(t, resp2).Get("error"); eq != "OIDC_STATE_INVALID" {
		t.Fatalf("replay error = %v, want OIDC_STATE_INVALID", eq)
	}
}

func TestOIDCBrokenTokenFails(t *testing.T) {
	cases := []struct {
		name  string
		tamper func(*stubIdP)
	}{
		{"nonce", func(idp *stubIdP) { idp.breakNonce = true }},
		{"signature", func(idp *stubIdP) { idp.breakSigner = true }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, ts, idp := newOIDCTestServer(t, nil)
			setupAdmin(t, ts)
			client := browserClient()

			authorizeURL := ssoStart(t, client, ts.URL, "")
			tc.tamper(idp)
			resp := ssoComplete(t, client, ts.URL, idp, authorizeURL, "sub-x", "x", "x@example.com", true)
			if eq := redirectQuery(t, resp).Get("error"); eq != "OIDC_TOKEN_INVALID" {
				t.Fatalf("error = %v, want OIDC_TOKEN_INVALID", eq)
			}
			code, _ := doJSONWithClient(t, client, "GET", ts.URL+"/api/v1/auth/me", nil, nil)
			if code != http.StatusUnauthorized {
				t.Fatalf("me = %d, want 401", code)
			}
		})
	}
}

func TestOIDCReturnTo(t *testing.T) {
	_, ts, idp := newOIDCTestServer(t, nil)
	setupAdmin(t, ts)

	t.Run("in-app path", func(t *testing.T) {
		client := browserClient()
		authorizeURL := ssoStart(t, client, ts.URL, "/spaces")
		resp := ssoComplete(t, client, ts.URL, idp, authorizeURL, "sub-rt", "rt", "rt@example.com", true)
		if loc := resp.Header.Get("Location"); loc != "/spaces" {
			t.Fatalf("landing = %q, want /spaces", loc)
		}
	})
	t.Run("foreign url collapses to root", func(t *testing.T) {
		client := browserClient()
		authorizeURL := ssoStart(t, client, ts.URL, "https://evil.example/phish")
		resp := ssoComplete(t, client, ts.URL, idp, authorizeURL, "sub-rt2", "rt2", "rt2@example.com", true)
		if loc := resp.Header.Get("Location"); loc != "/" {
			t.Fatalf("landing = %q, want /", loc)
		}
	})
}

func TestOIDCDisabledByDefault(t *testing.T) {
	srv, ts := newTestServer(t)
	_ = srv

	body := getSystemStatus(t, ts)
	if statusBool(t, body, "oidc_enabled") {
		t.Fatal("oidc_enabled true without configuration")
	}
	if !statusBool(t, body, "password_login_enabled") {
		t.Fatal("password login must stay enabled without oidc")
	}
	client := browserClient()
	resp, err := client.Get(ts.URL + "/api/v1/auth/oidc/start")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound || !strings.Contains(resp.Header.Get("Location"), "OIDC_UNAVAILABLE") {
		t.Fatalf("start without provider = %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
}

func TestOIDCPasswordLoginDisabled(t *testing.T) {
	_, ts, _ := newOIDCTestServer(t, func(s *auth.OIDCSettings) { s.DisablePasswordLogin = true })

	body := getSystemStatus(t, ts)
	if !statusBool(t, body, "oidc_enabled") {
		t.Fatal("oidc_enabled false with provider configured")
	}
	if statusBool(t, body, "password_login_enabled") {
		t.Fatal("password_login_enabled true under disable_password_login")
	}

	code, body := doJSON(t, "POST", ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "alice", "password": "password123"})
	if code != http.StatusForbidden {
		t.Fatalf("login = %d %v, want 403", code, body)
	}
	if body["error"].(map[string]any)["code"] != "PASSWORD_LOGIN_DISABLED" {
		t.Fatalf("login error = %v", body)
	}
	code, _ = doJSON(t, "POST", ts.URL+"/api/v1/auth/register", nil,
		map[string]string{"username": "eve", "password": "password123"})
	if code != http.StatusForbidden {
		t.Fatalf("register = %d, want 403", code)
	}
	code, _ = doJSON(t, "POST", ts.URL+"/api/v1/auth/reset", nil,
		map[string]string{"token": "x", "new_password": "password123"})
	if code != http.StatusForbidden {
		t.Fatalf("reset = %d, want 403", code)
	}
}

func TestOIDCSetupStillWorksWhenPasswordLoginDisabled(t *testing.T) {
	// Bootstrap is the one credential path that must survive the gate: an
	// operator who locks a fresh instance to SSO still needs the first admin.
	_, ts, _ := newOIDCTestServer(t, func(s *auth.OIDCSettings) { s.DisablePasswordLogin = true })
	code, body := doJSON(t, "POST", ts.URL+"/api/v1/auth/setup", nil,
		map[string]string{"username": "root", "password": "password123"})
	if code != http.StatusCreated {
		t.Fatalf("setup = %d %v, want 201", code, body)
	}
}

// --- pairing codes ---

func TestPairingCodeLifecycle(t *testing.T) {
	_, ts, db := newTestServerWithDB(t)
	adminToken := setupAdmin(t, ts)

	// Mint.
	code, body := doJSON(t, "POST", ts.URL+"/api/v1/devices/pairing-codes",
		map[string]string{"Authorization": "Bearer " + adminToken}, nil)
	if code != http.StatusCreated {
		t.Fatalf("pairing code = %d %v", code, body)
	}
	pairingCode, _ := body["code"].(string)
	if len(pairingCode) != 9 || pairingCode[4] != '-' {
		t.Fatalf("pairing code %q is not XXXX-XXXX", pairingCode)
	}

	// Redeem.
	code, body = doJSON(t, "POST", ts.URL+"/api/v1/devices/pair", nil,
		map[string]string{"code": pairingCode, "name": "Work laptop", "client_type": "extension"})
	if code != http.StatusCreated {
		t.Fatalf("pair = %d %v", code, body)
	}
	deviceToken, _ := body["token"].(string)
	if deviceToken == "" {
		t.Fatalf("pair returned no token: %v", body)
	}

	// The credential is a real device credential.
	code, _ = doJSON(t, "GET", ts.URL+"/api/v1/device/spaces",
		map[string]string{"Authorization": "Bearer " + deviceToken}, nil)
	if code != http.StatusOK {
		t.Fatalf("device spaces with paired credential = %d", code)
	}

	// Single use.
	code, _ = doJSON(t, "POST", ts.URL+"/api/v1/devices/pair", nil,
		map[string]string{"code": pairingCode, "name": "Again"})
	if code != http.StatusForbidden {
		t.Fatalf("code reuse = %d, want 403", code)
	}

	// Lowercase and dashless input normalizes to the same burned code.
	code, _ = doJSON(t, "POST", ts.URL+"/api/v1/devices/pair", nil,
		map[string]string{"code": strings.ToLower(strings.ReplaceAll(pairingCode, "-", "")), "name": "Again"})
	if code != http.StatusForbidden {
		t.Fatalf("normalized reuse = %d, want 403", code)
	}

	// Unknown code.
	code, _ = doJSON(t, "POST", ts.URL+"/api/v1/devices/pair", nil,
		map[string]string{"code": "AAAA-BBBB", "name": "Nope"})
	if code != http.StatusForbidden {
		t.Fatalf("unknown code = %d, want 403", code)
	}

	// Malformed code.
	code, _ = doJSON(t, "POST", ts.URL+"/api/v1/devices/pair", nil,
		map[string]string{"code": "!!", "name": "Nope"})
	if code != http.StatusForbidden {
		t.Fatalf("malformed code = %d, want 403", code)
	}

	// Empty device name.
	code, _ = doJSON(t, "POST", ts.URL+"/api/v1/devices/pair", nil,
		map[string]string{"code": "AAAA-BBBB"})
	if code != http.StatusBadRequest {
		t.Fatalf("missing name = %d, want 400", code)
	}

	// Expiry. The DB handle is shared with the server under test, so the
	// test can age the row the server wrote.
	code, body = doJSON(t, "POST", ts.URL+"/api/v1/devices/pairing-codes",
		map[string]string{"Authorization": "Bearer " + adminToken}, nil)
	if code != http.StatusCreated {
		t.Fatalf("second pairing code = %d %v", code, body)
	}
	fresh, _ := body["code"].(string)
	if _, err := db.Exec(`UPDATE device_pairing_codes SET expires_at = '2000-01-01T00:00:00Z'`); err != nil {
		t.Fatalf("expire code: %v", err)
	}
	code, _ = doJSON(t, "POST", ts.URL+"/api/v1/devices/pair", nil,
		map[string]string{"code": fresh, "name": "Late"})
	if code != http.StatusForbidden {
		t.Fatalf("expired code = %d, want 403", code)
	}
}
