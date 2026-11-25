package auth

// OIDC single sign-on. The server is a plain OIDC relying party: discovery at
// boot, authorization-code flow with PKCE, ID token verified server-side. No
// OIDC token ever reaches the browser — the flow's only output is an ordinary
// web session, the same artifact a password login produces.
//
// Account resolution order for a verified (issuer, subject):
//  1. a stored identity row decides — the immutable link;
//  2. otherwise a verified email claim links the existing local account;
//  3. otherwise auto-provisioning creates a role=user account, or the login
//     is refused. The first account of an instance is never an SSO product.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"golang.org/x/oauth2"
)

// OIDCSettings is the deployment's provider configuration, already validated
// by the config package.
type OIDCSettings struct {
	IssuerURL     string
	ClientID      string
	ClientSecret  string
	Scopes        []string
	AutoProvision bool
	// DisablePasswordLogin turns the credential endpoints into rejections
	// for a pure-SSO deployment (config validates that OIDC is enabled).
	DisablePasswordLogin bool
}

// oidcStateTTL is how long a sign-in flow may sit between the redirect to
// the provider and the callback. Long enough for a login page in another
// tab, short enough that a stale tab retries instead of resuming.
const oidcStateTTL = 10 * time.Minute

// OIDCState is one in-flight authorization-code flow. The browser only ever
// holds the random state token; the server keeps the sensitive halves (PKCE
// verifier, nonce) keyed by the token's hash, exactly like a reset token.
type OIDCState struct {
	StateHash   string
	Verifier    string
	Nonce       string
	ReturnTo    string
	RedirectURL string
	ExpiresAt   time.Time
	CreatedAt   time.Time
}

// OIDCStore is the persistence contract for identities and flow state,
// implemented by the sqlite auth store and asserted from s.store the way
// ResetStore is.
type OIDCStore interface {
	// GetOIDCIdentityUser resolves (issuer, subject) to its linked account.
	GetOIDCIdentityUser(ctx context.Context, issuer, subject string) (User, error)
	// UpsertOIDCIdentity links an identity to an account, or refreshes
	// last_login_at when it is already linked. It never re-points an
	// existing link at another account.
	UpsertOIDCIdentity(ctx context.Context, issuer, subject, userID string, at time.Time) error
	// GetUserByEmailNormalized loads an account by its email key.
	GetUserByEmailNormalized(ctx context.Context, emailNorm string) (User, error)
	// HasOIDCIdentityForUser reports whether userID is already linked to a
	// subject for issuer.
	HasOIDCIdentityForUser(ctx context.Context, issuer, userID string) (bool, error)
	// InsertOIDCState stores a flow. Implementations may prune expired rows.
	InsertOIDCState(ctx context.Context, st OIDCState) error
	// ConsumeOIDCState atomically reads and deletes a flow: two callbacks
	// racing one state token must yield exactly one winner.
	ConsumeOIDCState(ctx context.Context, stateHash string) (OIDCState, error)
}

// OIDCService implements the relying party. A nil *OIDCService means the
// deployment has no provider configured.
type OIDCService struct {
	auth *Service

	settings OIDCSettings

	// issuer and verifier come from discovery at construction; a provider
	// whose metadata cannot be fetched fails the boot, not the first login.
	issuer   *oidc.Provider
	verifier *oidc.IDTokenVerifier
	oauth    oauth2.Config
}

// NewOIDCService performs discovery and returns the service. The error is a
// startup error: misconfigured issuer, unreachable provider, broken metadata.
func NewOIDCService(ctx context.Context, authSvc *Service, settings OIDCSettings) (*OIDCService, error) {
	issuer, err := oidc.NewProvider(ctx, settings.IssuerURL)
	if err != nil {
		return nil, fmt.Errorf("auth: oidc discovery of %s: %w", settings.IssuerURL, err)
	}
	return &OIDCService{
		auth:     authSvc,
		settings: settings,
		issuer:   issuer,
		verifier: issuer.Verifier(&oidc.Config{ClientID: settings.ClientID}),
		oauth: oauth2.Config{
			ClientID:     settings.ClientID,
			ClientSecret: settings.ClientSecret,
			Scopes:       settings.Scopes,
			Endpoint:     issuer.Endpoint(),
		},
	}, nil
}

// PasswordLoginDisabled reports whether this deployment switched the
// credential endpoints off in favor of SSO.
func (s *OIDCService) PasswordLoginDisabled() bool { return s.settings.DisablePasswordLogin }

// Start opens an authorization-code flow. redirectURL is this instance's
// callback (it depends on the deployment's public_url or the request's Host,
// so the caller derives it per request); returnTo is the already-validated
// in-app path to land on afterwards.
//
// It returns the authorize URL to redirect to and the state token to carry in
// the browser as both the ?state= parameter and the state cookie.
func (s *OIDCService) Start(ctx context.Context, redirectURL, returnTo string) (authorizeURL, stateToken string, err error) {
	store, err := s.oidcStore()
	if err != nil {
		return "", "", err
	}

	stateToken, err = randomToken()
	if err != nil {
		return "", "", err
	}
	verifier, err := randomToken()
	if err != nil {
		return "", "", err
	}
	nonce, err := randomToken()
	if err != nil {
		return "", "", err
	}

	now := time.Now().UTC()
	if err := store.InsertOIDCState(ctx, OIDCState{
		StateHash:   hashToken(stateToken),
		Verifier:    verifier,
		Nonce:       nonce,
		ReturnTo:    returnTo,
		RedirectURL: redirectURL,
		ExpiresAt:   now.Add(oidcStateTTL),
		CreatedAt:   now,
	}); err != nil {
		return "", "", err
	}

	cfg := s.oauth
	cfg.RedirectURL = redirectURL
	authorizeURL = cfg.AuthCodeURL(stateToken,
		oauth2.SetAuthURLParam("code_challenge", pkceChallenge(verifier)),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
		oauth2.SetAuthURLParam("nonce", nonce),
	)
	return authorizeURL, stateToken, nil
}

// CompleteCallback closes a flow: consume the state, exchange the code with
// the stored PKCE verifier, verify the ID token (signature, issuer, audience,
// expiry and the stored nonce), resolve the account and open a web session.
// The returned returnTo is the one stored with the flow, not client input.
func (s *OIDCService) CompleteCallback(ctx context.Context, stateToken, code, userAgent string, logger *slog.Logger) (token string, user User, returnTo string, err error) {
	store, err := s.oidcStore()
	if err != nil {
		return "", User{}, "", err
	}

	if stateToken == "" || code == "" {
		return "", User{}, "", ErrOIDCStateInvalid
	}
	st, err := store.ConsumeOIDCState(ctx, hashToken(stateToken))
	if err != nil {
		return "", User{}, "", ErrOIDCStateInvalid
	}
	if time.Now().UTC().After(st.ExpiresAt) {
		return "", User{}, "", ErrOIDCStateInvalid
	}

	cfg := s.oauth
	cfg.RedirectURL = st.RedirectURL
	tok, err := cfg.Exchange(ctx, code, oauth2.SetAuthURLParam("code_verifier", st.Verifier))
	if err != nil {
		if logger != nil {
			logger.Warn("oidc code exchange rejected", "error", err.Error())
		}
		return "", User{}, "", ErrOIDCTokenExchange
	}

	rawIDToken, ok := tok.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return "", User{}, "", ErrOIDCTokenInvalid
	}
	idToken, err := s.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		if logger != nil {
			logger.Warn("oidc id token verification failed", "error", err.Error())
		}
		return "", User{}, "", ErrOIDCTokenInvalid
	}
	// go-oidc checks iss/aud/exp/azp; the nonce is ours to bind, and it ties
	// this ID token to this browser's flow, not to a replayed one.
	if subtle.ConstantTimeCompare([]byte(idToken.Nonce), []byte(st.Nonce)) != 1 {
		return "", User{}, "", ErrOIDCTokenInvalid
	}

	var claims struct {
		Subject           string `json:"sub"`
		PreferredUsername string `json:"preferred_username"`
		Name              string `json:"name"`
		Email             string `json:"email"`
		EmailVerified     bool   `json:"email_verified"`
	}
	if err := idToken.Claims(&claims); err != nil || claims.Subject == "" {
		return "", User{}, "", ErrOIDCTokenInvalid
	}

	user, err = s.resolveUser(ctx, store, claims.Subject, claims.PreferredUsername, claims.Name, claims.Email, claims.EmailVerified)
	if err != nil {
		return "", User{}, "", err
	}
	if user.Status == StatusDisabled {
		return "", User{}, "", ErrUserDisabled
	}

	token, _, err = s.auth.startSession(ctx, user, userAgent)
	if err != nil {
		return "", User{}, "", err
	}
	if err := store.UpsertOIDCIdentity(ctx, s.settings.IssuerURL, claims.Subject, user.ID, time.Now().UTC()); err != nil {
		// The session exists and works; a failed bookkeeping write must not
		// log the person out. But say it: a user whose identity row keeps
		// failing to upsert will re-run email linking on every login.
		if logger != nil {
			logger.Error("oidc identity upsert failed", "user_id", user.ID, "error", err.Error())
		}
	}
	return token, user, st.ReturnTo, nil
}

// resolveUser maps a verified IdP identity onto a local account, following
// the order in the package comment.
func (s *OIDCService) resolveUser(ctx context.Context, store OIDCStore, subject, preferredUsername, displayName, email string, emailVerified bool) (User, error) {
	issuer := s.settings.IssuerURL

	// 1. The immutable link.
	user, err := store.GetOIDCIdentityUser(ctx, issuer, subject)
	if err == nil {
		return user, nil
	}
	if !errors.Is(err, ErrUserNotFound) {
		return User{}, err
	}

	// 2. Email linking, bootstrap only. Both halves must be verified: an
	// unverified IdP claim is attacker-controlled text at a permissive
	// provider, and a local account whose email was self-entered (via open
	// registration or PATCH /auth/me without verification) is not a trusted
	// ownership anchor either. Only accounts with email_verified_at set (e.g.
	// admin-created or SSO-provisioned) and not already bound to a different
	// subject under this issuer may auto-link.
	if email != "" && emailVerified {
		user, err := store.GetUserByEmailNormalized(ctx, NormalizeEmail(email))
		switch {
		case err == nil:
			if user.EmailVerifiedAt != nil {
				alreadyLinked, linkErr := store.HasOIDCIdentityForUser(ctx, issuer, user.ID)
				if linkErr != nil {
					return User{}, linkErr
				}
				if !alreadyLinked {
					if err := store.UpsertOIDCIdentity(ctx, issuer, subject, user.ID, time.Now().UTC()); err != nil {
						return User{}, err
					}
					return user, nil
				}
			}
			// Local email is unverified or already bound to another subject:
			// do not auto-link; fall through to provisioning / refusal.
		case errors.Is(err, ErrUserNotFound):
			// fall through to provisioning
		default:
			return User{}, err
		}
	}

	// 3. Auto-provisioning.
	if !s.settings.AutoProvision {
		return User{}, ErrOIDCAccountNotLinked
	}
	if needs, err := s.auth.NeedsSetup(ctx); err != nil {
		return User{}, err
	} else if needs {
		// CreateUser makes its first account the admin; bootstrap belongs to
		// /auth/setup alone, so SSO refuses to be a path to that role.
		return User{}, ErrOIDCNotInitialized
	}
	return s.provisionUser(ctx, store, issuer, subject, preferredUsername, displayName, email, emailVerified)
}

// provisionUser creates a role=user account for a first-time SSO identity.
// It mirrors the public register path: no admin role, a passwordless
// credential (every password login fails against the empty hash), the
// default locale. The Personal space follows through the same HTTP-level
// provisioning hook as /auth/register.
func (s *OIDCService) provisionUser(ctx context.Context, store OIDCStore, issuer, subject, preferredUsername, displayName, email string, emailVerified bool) (User, error) {
	orig := deriveUsername(preferredUsername, email)
	// An unverified email claim never lands in the account row. Storing it
	// would poison the email slot: an attacker could pre-provision a local
	// account under someone else's address, and a later verified login with
	// that address would link to the attacker's account. No email, no link.
	if !emailVerified || !ValidateEmail(strings.TrimSpace(email)) {
		email = ""
		emailVerified = false
	}
	var user User
	var err error
	for attempt := 0; ; attempt++ {
		candidate := orig
		if attempt > 0 {
			// "alice" taken → "alice-2", "alice-3"... deriveUsername keeps
			// the base short enough for the suffix to fit the charset cap.
			candidate = truncateRunes(fmt.Sprintf("%s-%d", orig, attempt+1), 32)
		}
		user, err = s.auth.CreateOIDCUser(ctx, candidate, displayName, email, emailVerified)
		if err == nil {
			break
		}
		if errors.Is(err, ErrEmailTaken) && email != "" {
			// The email slot is already occupied. Only link if that account's
			// email is verified and it is not already bound to another subject
			// (e.g. a concurrent login race). If an unverified local account
			// is squatting on this email, provision the SSO user without
			// claiming the contested email so the victim is neither hijacked
			// nor locked out.
			if emailVerified {
				if linked, lookupErr := store.GetUserByEmailNormalized(ctx, NormalizeEmail(email)); lookupErr == nil && linked.EmailVerifiedAt != nil {
					alreadyLinked, linkErr := store.HasOIDCIdentityForUser(ctx, issuer, linked.ID)
					if linkErr == nil && !alreadyLinked {
						if err := store.UpsertOIDCIdentity(ctx, issuer, subject, linked.ID, time.Now().UTC()); err != nil {
							return User{}, err
						}
						return linked, nil
					}
				}
			}
			email = ""
			emailVerified = false
			attempt--
			continue
		}
		if attempt >= 7 || !errors.Is(err, ErrUserExists) {
			return User{}, ErrOIDCProvisionFailed
		}
	}
	if err := store.UpsertOIDCIdentity(ctx, issuer, subject, user.ID, time.Now().UTC()); err != nil {
		return User{}, err
	}
	return user, nil
}

// CreateOIDCUser creates a passwordless account for an SSO-provisioned
// identity: always role=user on an instance that already has an admin.
func (s *Service) CreateOIDCUser(ctx context.Context, username, displayName, email string, emailVerified bool) (User, error) {
	if !ValidateUsername(username) {
		return User{}, ErrInvalidUsername
	}
	email = strings.TrimSpace(email)
	if !ValidateEmail(email) {
		email = ""
		emailVerified = false
	}

	userID, err := uuid.NewV7()
	if err != nil {
		return User{}, err
	}
	if displayName == "" {
		displayName = username
	}
	now := time.Now().UTC()
	var emailVerifiedAt *time.Time
	if emailVerified && email != "" {
		t := now
		emailVerifiedAt = &t
	}
	u := User{
		ID:                userID.String(),
		Username:          username,
		UsernameNorm:      NormalizeUsername(username),
		DisplayName:       displayName,
		EmailNorm:         NormalizeEmail(email),
		Email:             email,
		EmailVerifiedAt:   emailVerifiedAt,
		Role:              RoleUser,
		Status:            StatusActive,
		Locale:            "zh-CN",
		PasswordChangedAt: now,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if atomic, ok := s.store.(AtomicUserStore); ok {
		if err := atomic.CreateMemberUser(ctx, u, ""); err != nil {
			if errors.Is(err, ErrNotInitialized) {
				return User{}, ErrOIDCNotInitialized
			}
			return User{}, err
		}
		return u, nil
	}
	if n, err := s.store.CountUsers(ctx); err != nil {
		return User{}, err
	} else if n == 0 {
		return User{}, ErrOIDCNotInitialized
	}
	if err := s.store.CreateUser(ctx, u, ""); err != nil {
		return User{}, err
	}
	return u, nil
}

// oidcStore fetches the OIDC persistence contract from the auth store.
func (s *OIDCService) oidcStore() (OIDCStore, error) {
	store, ok := s.auth.store.(OIDCStore)
	if !ok {
		return nil, ErrOIDCUnavailable
	}
	return store, nil
}

// randomToken returns 32 bytes of CSPRNG as base64url — the minimum length
// RFC 7636 asks of a PKCE verifier.
func randomToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("auth: read oidc entropy: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// pkceChallenge is the S256 code challenge for a verifier.
func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// deriveUsername turns IdP profile claims into a local username candidate:
// the conservative charset of ValidateUsername, nothing else. Anything that
// survives as unusable falls back through the email local part to a fixed
// prefix; the caller uniquifies with numeric suffixes.
func deriveUsername(preferred, email string) string {
	candidate := sanitizeUsername(preferred)
	if len(candidate) < 3 {
		if at := strings.IndexByte(email, '@'); at > 0 {
			candidate = sanitizeUsername(email[:at])
		}
	}
	if len(candidate) < 3 {
		candidate = "sso"
	}
	// Room for "-99" suffixes within the 32-char limit.
	return truncateRunes(candidate, 28)
}

// sanitizeUsername strips everything outside the username charset. Empty
// result means the input had nothing usable.
func sanitizeUsername(s string) string {
	var b strings.Builder
	for _, c := range s {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
			b.WriteRune(c)
		case c == '_' || c == '-' || c == '.':
			b.WriteRune(c)
		}
	}
	return b.String()
}

// truncateRunes cuts s to at most n runes without splitting one.
func truncateRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}
