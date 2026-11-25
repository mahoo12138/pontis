package auth

import (
	"context"
	crand "crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Store is the persistence contract required by the auth service.
type Store interface {
	// CountUsers returns the number of registered users.
	CountUsers(ctx context.Context) (int64, error)

	// CreateUser inserts a user. Username/email uniqueness violations must
	// return ErrUserExists / ErrEmailTaken.
	CreateUser(ctx context.Context, u User, passwordHash string) error

	// GetUserByUsernameNormalized loads a user by normalized username.
	GetUserByUsernameNormalized(ctx context.Context, usernameNorm string) (User, error)

	// GetUser loads a user by id.
	GetUser(ctx context.Context, id string) (User, error)

	// InsertSession stores a new session.
	InsertSession(ctx context.Context, s Session) error

	// GetSessionByTokenHash loads a session by token hash joined with the
	// user's status. Expired sessions return ErrSessionInvalid.
	GetSessionByTokenHash(ctx context.Context, tokenHash string) (Session, User, error)

	// TouchSession updates last_seen_at.
	TouchSession(ctx context.Context, sessionID string, at time.Time) error

	// DeleteSession removes one session (logout).
	DeleteSession(ctx context.Context, sessionID string) error

	// DeleteUserSessions removes all sessions of a user (password change,
	// disable).
	DeleteUserSessions(ctx context.Context, userID string) error
}

// Service implements user bootstrap, login and session management.
type Service struct {
	store Store
	// SessionTTL is how long a web session lives.
	SessionTTL time.Duration
}

// NewService returns an auth service with the given store and session TTL.
func NewService(store Store, sessionTTL time.Duration) *Service {
	return &Service{store: store, SessionTTL: sessionTTL}
}

// NeedsSetup reports whether the instance has no users yet and must run
// first-setup bootstrap.
func (s *Service) NeedsSetup(ctx context.Context) (bool, error) {
	n, err := s.store.CountUsers(ctx)
	if err != nil {
		return false, err
	}
	return n == 0, nil
}

// AtomicUserStore is the optional transactional user-creation contract that
// eliminates check-then-insert races in /auth/setup, /auth/register, and OIDC.
type AtomicUserStore interface {
	CreateFirstAdmin(ctx context.Context, u User, passwordHash string) error
	CreateMemberUser(ctx context.Context, u User, passwordHash string) error
	CreateUserAutoRole(ctx context.Context, u User, passwordHash string) (Role, error)
}

// CreateUserParams carries the input for user creation.
type CreateUserParams struct {
	Username      string
	Password      string
	DisplayName   string
	Email         string
	EmailVerified bool
}

func prepareNewUser(ctx context.Context, p CreateUserParams) (User, string, error) {
	if !ValidateUsername(p.Username) {
		return User{}, "", ErrInvalidUsername
	}
	if !ValidatePassword(p.Password) {
		return User{}, "", ErrInvalidPassword
	}
	email := strings.TrimSpace(p.Email)
	if !ValidateEmail(email) {
		return User{}, "", ErrInvalidEmail
	}

	hash, err := HashPasswordContext(ctx, p.Password)
	if err != nil {
		return User{}, "", err
	}

	userID, err := uuid.NewV7()
	if err != nil {
		return User{}, "", err
	}

	displayName := p.DisplayName
	if displayName == "" {
		displayName = p.Username
	}

	now := time.Now().UTC()
	var emailVerifiedAt *time.Time
	if p.EmailVerified && email != "" {
		t := now
		emailVerifiedAt = &t
	}
	u := User{
		ID:                userID.String(),
		Username:          p.Username,
		UsernameNorm:      NormalizeUsername(p.Username),
		DisplayName:       displayName,
		EmailNorm:         NormalizeEmail(email),
		Email:             email,
		EmailVerifiedAt:   emailVerifiedAt,
		PasswordHash:      hash,
		Role:              RoleUser,
		Status:            StatusActive,
		Locale:            "zh-CN",
		PasswordChangedAt: now,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	return u, hash, nil
}

// SetupAdmin atomically creates the instance's sole initial admin account.
// Concurrent setup calls race inside a single write transaction so at most one
// succeeds and the rest receive ErrAlreadyInitialized.
func (s *Service) SetupAdmin(ctx context.Context, p CreateUserParams) (User, error) {
	p.EmailVerified = true
	u, hash, err := prepareNewUser(ctx, p)
	if err != nil {
		return User{}, err
	}
	u.Role = RoleAdmin
	if atomic, ok := s.store.(AtomicUserStore); ok {
		if err := atomic.CreateFirstAdmin(ctx, u, hash); err != nil {
			return User{}, err
		}
		return u, nil
	}
	if n, err := s.store.CountUsers(ctx); err != nil {
		return User{}, err
	} else if n > 0 {
		return User{}, ErrAlreadyInitialized
	}
	if err := s.store.CreateUser(ctx, u, hash); err != nil {
		return User{}, err
	}
	return u, nil
}

// CreateMemberUser creates a non-admin user on an already-initialized instance.
func (s *Service) CreateMemberUser(ctx context.Context, p CreateUserParams) (User, error) {
	u, hash, err := prepareNewUser(ctx, p)
	if err != nil {
		return User{}, err
	}
	u.Role = RoleUser
	if atomic, ok := s.store.(AtomicUserStore); ok {
		if err := atomic.CreateMemberUser(ctx, u, hash); err != nil {
			return User{}, err
		}
		return u, nil
	}
	if n, err := s.store.CountUsers(ctx); err != nil {
		return User{}, err
	} else if n == 0 {
		return User{}, ErrNotInitialized
	}
	if err := s.store.CreateUser(ctx, u, hash); err != nil {
		return User{}, err
	}
	return u, nil
}

// CreateUser registers a user. The first user of an instance becomes the
// admin; later users are regular users.
func (s *Service) CreateUser(ctx context.Context, p CreateUserParams) (User, error) {
	u, hash, err := prepareNewUser(ctx, p)
	if err != nil {
		return User{}, err
	}
	if atomic, ok := s.store.(AtomicUserStore); ok {
		role, err := atomic.CreateUserAutoRole(ctx, u, hash)
		if err != nil {
			return User{}, err
		}
		u.Role = role
		return u, nil
	}
	role := RoleUser
	if n, err := s.store.CountUsers(ctx); err != nil {
		return User{}, err
	} else if n == 0 {
		role = RoleAdmin
	}
	u.Role = role
	if err := s.store.CreateUser(ctx, u, hash); err != nil {
		return User{}, err
	}
	return u, nil
}

// Login verifies credentials and creates a web session. It returns the
// raw token (handed to the client exactly once) and the session.
func (s *Service) Login(ctx context.Context, username, password, userAgent string) (token string, session Session, user User, err error) {
	u, err := s.store.GetUserByUsernameNormalized(ctx, NormalizeUsername(username))
	if err != nil {
		// Burn comparable time to avoid trivially timing user existence.
		_, _ = VerifyPasswordContext(ctx, password, dummyPasswordHash)
		return "", Session{}, User{}, ErrInvalidCredentials
	}
	if u.PasswordHash == "" {
		// Passwordless (SSO) account: still burn Argon2 time so timing cannot
		// distinguish SSO accounts from password accounts.
		_, _ = VerifyPasswordContext(ctx, password, dummyPasswordHash)
		return "", Session{}, User{}, ErrInvalidCredentials
	}

	ok, err := VerifyPasswordContext(ctx, password, u.PasswordHash)
	if err != nil || !ok {
		return "", Session{}, User{}, ErrInvalidCredentials
	}
	if u.Status == StatusDisabled {
		return "", Session{}, User{}, ErrUserDisabled
	}

	token, session, err = s.startSession(ctx, u, userAgent)
	if err != nil {
		return "", Session{}, User{}, err
	}
	return token, session, u, nil
}

// startSession mints an opaque web session for an already-authenticated
// user. Every login path — password and OIDC — converges here, so no path
// can grow its own token format or TTL.
func (s *Service) startSession(ctx context.Context, u User, userAgent string) (string, Session, error) {
	token, tokenHash, err := newSessionToken()
	if err != nil {
		return "", Session{}, err
	}

	sessionID, err := uuid.NewV7()
	if err != nil {
		return "", Session{}, err
	}

	now := time.Now().UTC()
	session := Session{
		ID:        sessionID.String(),
		UserID:    u.ID,
		TokenHash: tokenHash,
		CreatedAt: now,
		LastSeen:  now,
		ExpiresAt: now.Add(s.SessionTTL),
		UserAgent: userAgent,
	}
	if err := s.store.InsertSession(ctx, session); err != nil {
		return "", Session{}, err
	}
	return token, session, nil
}

// VerifySession resolves a raw session token to its session and user.
// Expired sessions and disabled users are rejected.
func (s *Service) VerifySession(ctx context.Context, token string) (Session, User, error) {
	session, user, err := s.store.GetSessionByTokenHash(ctx, hashToken(token))
	if err != nil {
		return Session{}, User{}, ErrSessionInvalid
	}
	if user.Status == StatusDisabled {
		return Session{}, User{}, ErrUserDisabled
	}
	_ = s.store.TouchSession(ctx, session.ID, time.Now().UTC())
	return session, user, nil
}

// Logout revokes a single session by raw token.
func (s *Service) Logout(ctx context.Context, token string) error {
	session, _, err := s.store.GetSessionByTokenHash(ctx, hashToken(token))
	if err != nil {
		return ErrSessionInvalid
	}
	return s.store.DeleteSession(ctx, session.ID)
}

// UserByID returns one account by id.
func (s *Service) UserByID(ctx context.Context, id string) (User, error) {
	return s.store.GetUser(ctx, id)
}

// resetTokenTTL is how long a password reset link stays valid.
const resetTokenTTL = 30 * time.Minute

// ResetStore is the extra contract for password reset flows; implemented
// by the sqlite account store.
type ResetStore interface {
	InsertResetToken(ctx context.Context, userID, hash string, expiresAt, at time.Time) error
}

// ResetCommitter consumes a reset token, sets the new password and drops the
// user's sessions as one unit. It is one method on purpose: split into
// "check the token", "mark it used", "change the password", the middle step can
// burn a single-use link without changing anything, and two requests can each
// clear the check before either writes.
type ResetCommitter interface {
	ResetPasswordTx(ctx context.Context, tokenHash, passwordHash string, at time.Time) (string, error)
}

// CreateResetLink mints a single-use reset token for the user and returns
// the raw secret for out-of-band delivery (doc 09 §15). The admin never
// learns the new password.
func (s *Service) CreateResetLink(ctx context.Context, userID string) (string, error) {
	if _, err := s.store.GetUser(ctx, userID); err != nil {
		return "", err
	}
	resetStore, ok := s.store.(ResetStore)
	if !ok {
		return "", errors.New("auth: reset flow unavailable")
	}
	raw := make([]byte, 32)
	if _, err := crand.Read(raw); err != nil {
		return "", err
	}
	token := "prs_" + base64.RawURLEncoding.EncodeToString(raw)
	now := time.Now().UTC()
	if err := resetStore.InsertResetToken(ctx, userID, hashToken(token), now.Add(resetTokenTTL), now); err != nil {
		return "", err
	}
	return token, nil
}

// ResetPassword consumes a raw reset token and sets a new password,
// invalidating all of the user's web sessions.
func (s *Service) ResetPassword(ctx context.Context, rawToken, newPassword string) error {
	if !ValidatePassword(newPassword) {
		return ErrInvalidPassword
	}
	committer, ok := s.store.(ResetCommitter)
	if !ok {
		return errors.New("auth: reset flow unavailable")
	}
	hash, err := HashPasswordContext(ctx, newPassword)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if _, err := committer.ResetPasswordTx(ctx, hashToken(rawToken), hash, now); err != nil {
		return err
	}
	return nil
}
