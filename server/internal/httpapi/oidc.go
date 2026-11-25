package httpapi

// OIDC single sign-on endpoints. Both are plain browser navigations, not API
// calls: the start hands out a redirect to the provider, the callback comes
// back with ?code/?state and leaves with a session cookie. Failures redirect
// to /login?error=<CODE> so the person sees the login page with a readable
// message, never a JSON envelope.

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"net/url"

	"pontis/internal/auth"
)

// OIDCStateCookie carries the in-flight sign-in flow's state token. Its path
// covers only the two OIDC endpoints: no other request ever needs it.
const OIDCStateCookie = "pontis_oidc"

// oidcCallbackPath is appended to the instance's external origin. It is what
// the operator registers with the provider.
const oidcCallbackPath = "/api/v1/auth/oidc/callback"

// handleOIDCStart begins the flow. `/login` links straight here; a logged-in
// visitor landing on it just ends up at the provider and back — harmless.
func (s *Server) handleOIDCStart(w http.ResponseWriter, r *http.Request) {
	if s.OIDC == nil {
		s.redirectOIDCError(w, r, "OIDC_UNAVAILABLE")
		return
	}
	returnTo := sanitizeReturnTo(r.URL.Query().Get("return_to"))
	authorizeURL, stateToken, err := s.OIDC.Start(r.Context(), s.externalOrigin(r)+oidcCallbackPath, returnTo)
	if err != nil {
		// Discovery succeeded at boot, so this is store trouble: log it, but
		// the browser still gets a login page, not a 500 page.
		s.Logger.Error("oidc start failed", "error", err.Error())
		s.redirectOIDCError(w, r, "OIDC_INTERNAL")
		return
	}
	http.SetCookie(w, s.oidcStateCookie(r, stateToken))
	http.Redirect(w, r, authorizeURL, http.StatusFound)
}

// handleOIDCCallback closes the flow: verify, resolve the account, open the
// session, and land the browser in the app.
func (s *Server) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	if s.OIDC == nil {
		s.redirectOIDCError(w, r, "OIDC_UNAVAILABLE")
		return
	}
	// The provider's own refusal (user denied, provider down) arrives as
	// error/error_description instead of a code. Details go to the log; the
	// person gets one stable message.
	if e := r.URL.Query().Get("error"); e != "" {
		s.Logger.Warn("oidc provider returned an error", "error", e,
			"description", r.URL.Query().Get("error_description"))
		s.redirectOIDCError(w, r, "OIDC_PROVIDER_DENIED")
		return
	}

	// Bind the callback to the browser that started the flow (doc 25 §3).
	// Check the cookie before consuming the server-side state row so a forged
	// callback cannot burn an in-flight login belonging to another browser.
	state := r.URL.Query().Get("state")
	cookie, err := r.Cookie(OIDCStateCookie)
	if err != nil || cookie.Value == "" || state == "" ||
		subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(state)) != 1 {
		s.redirectOIDCError(w, r, "OIDC_STATE_INVALID")
		return
	}

	token, user, returnTo, err := s.OIDC.CompleteCallback(r.Context(),
		state, r.URL.Query().Get("code"), r.UserAgent(), s.Logger)
	if err != nil {
		if !isExpectedOIDCError(err) {
			s.Logger.Error("oidc callback failed", "error", err.Error())
		}
		s.redirectOIDCError(w, r, oidcErrorCode(err))
		return
	}

	// A brand-new account still needs the Space every account is promised;
	// same degraded-first-run policy as /auth/register.
	if err := s.provisionDefaultSpace(r.Context(), user.ID); err != nil {
		s.Logger.Warn("oidc provisioning: default space failed",
			"user_id", user.ID, "error", err.Error())
	}

	http.SetCookie(w, s.sessionCookie(r, token))
	// The flow state is consumed server-side; drop the browser's copy.
	http.SetCookie(w, &http.Cookie{
		Name: OIDCStateCookie, Value: "", Path: "/api/v1/auth/oidc", MaxAge: -1,
		HttpOnly: true, Secure: s.Deploy.IsHTTPS(r), SameSite: http.SameSiteLaxMode,
	})
	target := "/"
	if rt := sanitizeReturnTo(returnTo); rt != "" {
		target = rt
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// oidcErrorCode maps flow failures onto the stable codes the login page
// knows. The default is logged upstream and stays generic.
func oidcErrorCode(err error) string {
	switch {
	case errors.Is(err, auth.ErrOIDCUnavailable):
		return "OIDC_UNAVAILABLE"
	case errors.Is(err, auth.ErrOIDCStateInvalid):
		return "OIDC_STATE_INVALID"
	case errors.Is(err, auth.ErrOIDCTokenExchange):
		return "OIDC_TOKEN_EXCHANGE"
	case errors.Is(err, auth.ErrOIDCTokenInvalid):
		return "OIDC_TOKEN_INVALID"
	case errors.Is(err, auth.ErrOIDCAccountNotLinked):
		return "OIDC_ACCOUNT_NOT_LINKED"
	case errors.Is(err, auth.ErrOIDCNotInitialized):
		return "OIDC_NOT_INITIALIZED"
	case errors.Is(err, auth.ErrOIDCProvisionFailed):
		return "OIDC_PROVISION_FAILED"
	case errors.Is(err, auth.ErrUserDisabled):
		return "OIDC_ACCOUNT_DISABLED"
	default:
		return "OIDC_INTERNAL"
	}
}

// isExpectedOIDCError separates user-visible outcomes (wrong token, expired
// flow) from the ones worth an error log. All of them end in the same
// redirect; the split only decides how loud they are.
func isExpectedOIDCError(err error) bool {
	switch {
	case errors.Is(err, auth.ErrOIDCStateInvalid),
		errors.Is(err, auth.ErrOIDCTokenExchange),
		errors.Is(err, auth.ErrOIDCTokenInvalid),
		errors.Is(err, auth.ErrOIDCAccountNotLinked),
		errors.Is(err, auth.ErrOIDCNotInitialized),
		errors.Is(err, auth.ErrOIDCProvisionFailed),
		errors.Is(err, auth.ErrUserDisabled):
		return true
	default:
		return false
	}
}

func (s *Server) redirectOIDCError(w http.ResponseWriter, r *http.Request, code string) {
	http.Redirect(w, r, "/login?error="+url.QueryEscape(code), http.StatusFound)
}

// externalOrigin is the base the provider is sent back to. Behind a proxy
// r.Host is the internal name, so public_url wins when it is set — the same
// rule the reset links already follow.
func (s *Server) externalOrigin(r *http.Request) string {
	if origin := s.Deploy.Origin(); origin != "" {
		return origin
	}
	scheme := "http"
	if s.Deploy.IsHTTPS(r) {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// sanitizeReturnTo accepts only an in-app path: it must start with a single
// slash, must not start with // or /\ (protocol-relative tricks), and carries
// no scheme. Everything else becomes "", which callers replace with "/".
func sanitizeReturnTo(raw string) string {
	if raw == "" || len(raw) > 512 {
		return ""
	}
	if raw[0] != '/' || raw == "//" {
		return ""
	}
	if len(raw) >= 2 && (raw[1] == '/' || raw[1] == '\\') {
		return ""
	}
	if u, err := url.Parse(raw); err != nil || u.Scheme != "" || u.Host != "" {
		return ""
	}
	return raw
}

// oidcStateCookie carries the state token to the callback. SameSite=Lax
// because the callback is a top-level GET navigation from the provider.
func (s *Server) oidcStateCookie(r *http.Request, value string) *http.Cookie {
	return &http.Cookie{
		Name:     OIDCStateCookie,
		Value:    value,
		Path:     "/api/v1/auth/oidc",
		MaxAge:   600,
		HttpOnly: true,
		Secure:   s.Deploy.IsHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	}
}

// passwordLoginBlocked is the pure-SSO gate shared by the credential
// endpoints. Setup is deliberately not gated: an uninitialized instance must
// always be able to mint its first admin.
func (s *Server) passwordLoginBlocked(w http.ResponseWriter, r *http.Request) bool {
	if s.OIDC != nil && s.OIDC.PasswordLoginDisabled() {
		s.writeError(w, r, http.StatusForbidden, "PASSWORD_LOGIN_DISABLED",
			"this instance accepts single sign-on only")
		return true
	}
	return false
}
