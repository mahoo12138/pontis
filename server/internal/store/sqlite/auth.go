package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"pontis/internal/auth"
)

// AuthStore implements auth.Store.
type AuthStore struct {
	db *sql.DB
}

// NewAuthStore wraps an opened database as an auth store.
func NewAuthStore(db *sql.DB) *AuthStore { return &AuthStore{db: db} }

// CountUsers returns the number of registered users.
func (s *AuthStore) CountUsers(ctx context.Context) (int64, error) {
	var n int64
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

func mapUserUniqueErr(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if strings.Contains(msg, "UNIQUE constraint failed") {
		if strings.Contains(msg, "username_normalized") {
			return auth.ErrUserExists
		}
		if strings.Contains(msg, "email_normalized") {
			return auth.ErrEmailTaken
		}
	}
	return err
}

func insertUserTx(ctx context.Context, tx *sql.Tx, u auth.User, passwordHash string) error {
	var email, emailNorm, emailVerifiedAt any
	if u.Email != "" {
		email, emailNorm = u.Email, u.EmailNorm
	}
	if u.EmailVerifiedAt != nil {
		emailVerifiedAt = formatTime(*u.EmailVerifiedAt)
	}
	var defaultSpace any
	if u.DefaultSpaceID != "" {
		defaultSpace = string(u.DefaultSpaceID)
	}

	var usernameTaken, emailTaken bool
	if err := tx.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM users WHERE username_normalized = ?)`, u.UsernameNorm).
		Scan(&usernameTaken); err != nil {
		return err
	}
	if usernameTaken {
		return auth.ErrUserExists
	}
	if u.EmailNorm != "" {
		if err := tx.QueryRowContext(ctx,
			`SELECT EXISTS(SELECT 1 FROM users WHERE email_normalized = ?)`, u.EmailNorm).
			Scan(&emailTaken); err != nil {
			return err
		}
		if emailTaken {
			return auth.ErrEmailTaken
		}
	}

	_, err := tx.ExecContext(ctx, `
		INSERT INTO users (id, username, username_normalized, display_name, email, email_normalized,
			email_verified_at, password_hash, role, status, locale, default_space_id, password_changed_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, u.Username, u.UsernameNorm, u.DisplayName, email, emailNorm,
		emailVerifiedAt, passwordHash, string(u.Role), string(u.Status), u.Locale, defaultSpace,
		formatTime(u.PasswordChangedAt), formatTime(u.CreatedAt), formatTime(u.UpdatedAt))
	return mapUserUniqueErr(err)
}

// CreateUser inserts a user atomically, translating uniqueness violations into
// domain errors.
func (s *AuthStore) CreateUser(ctx context.Context, u auth.User, passwordHash string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := insertUserTx(ctx, tx, u, passwordHash); err != nil {
		return err
	}
	return tx.Commit()
}

// CreateFirstAdmin atomically inserts the sole initial admin account if and
// only if no users exist yet.
func (s *AuthStore) CreateFirstAdmin(ctx context.Context, u auth.User, passwordHash string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var n int64
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return auth.ErrAlreadyInitialized
	}
	u.Role = auth.RoleAdmin
	if err := insertUserTx(ctx, tx, u, passwordHash); err != nil {
		return err
	}
	return tx.Commit()
}

// CreateMemberUser atomically inserts a regular user if an admin already exists.
func (s *AuthStore) CreateMemberUser(ctx context.Context, u auth.User, passwordHash string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var n int64
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return auth.ErrNotInitialized
	}
	u.Role = auth.RoleUser
	if err := insertUserTx(ctx, tx, u, passwordHash); err != nil {
		return err
	}
	return tx.Commit()
}

// CreateUserAutoRole atomically assigns admin to the first user and user to
// subsequent users inside one write transaction.
func (s *AuthStore) CreateUserAutoRole(ctx context.Context, u auth.User, passwordHash string) (auth.Role, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var n int64
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return "", err
	}
	role := auth.RoleUser
	if n == 0 {
		role = auth.RoleAdmin
	}
	u.Role = role
	if err := insertUserTx(ctx, tx, u, passwordHash); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return role, nil
}

const userColumns = `
	SELECT id, username, username_normalized, display_name,
	       COALESCE(email, ''), COALESCE(email_normalized, ''), COALESCE(email_verified_at, ''), password_hash,
	       role, status, locale, COALESCE(default_space_id, ''), password_changed_at, created_at, updated_at`

func scanUser(row interface{ Scan(dest ...any) error }) (auth.User, error) {
	var u auth.User
	var emailVerifiedAt, role, status, passwordChangedAt, createdAt, updatedAt string
	err := row.Scan(&u.ID, &u.Username, &u.UsernameNorm, &u.DisplayName,
		&u.Email, &u.EmailNorm, &emailVerifiedAt, &u.PasswordHash,
		&role, &status, &u.Locale, &u.DefaultSpaceID, &passwordChangedAt, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return auth.User{}, auth.ErrInvalidCredentials
	}
	if err != nil {
		return auth.User{}, err
	}
	if emailVerifiedAt != "" {
		if t, parseErr := time.Parse(time.RFC3339Nano, emailVerifiedAt); parseErr == nil {
			u.EmailVerifiedAt = &t
		}
	}
	u.Role = auth.Role(role)
	u.Status = auth.Status(status)
	u.PasswordChangedAt, _ = time.Parse(time.RFC3339Nano, passwordChangedAt)
	u.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	u.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updatedAt)
	return u, nil
}

// GetUserByUsernameNormalized loads a user by normalized username.
func (s *AuthStore) GetUserByUsernameNormalized(ctx context.Context, usernameNorm string) (auth.User, error) {
	return scanUser(s.db.QueryRowContext(ctx,
		userColumns+` FROM users WHERE username_normalized = ?`, usernameNorm))
}

// GetUser loads a user by id.
func (s *AuthStore) GetUser(ctx context.Context, id string) (auth.User, error) {
	return scanUser(s.db.QueryRowContext(ctx,
		userColumns+` FROM users WHERE id = ?`, id))
}

// InsertSession stores a new session.
func (s *AuthStore) InsertSession(ctx context.Context, sess auth.Session) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, user_agent)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		sess.ID, sess.UserID, sess.TokenHash,
		formatTime(sess.CreatedAt), formatTime(sess.LastSeen), formatTime(sess.ExpiresAt), sess.UserAgent)
	return err
}

// GetSessionByTokenHash loads a session joined with its user, rejecting
// expired sessions.
func (s *AuthStore) GetSessionByTokenHash(ctx context.Context, tokenHash string) (auth.Session, auth.User, error) {
	var sess auth.Session
	var user auth.User
	var createdAt, lastSeen, expiresAt string
	var emailVerifiedAt, role, status, passwordChangedAt, userCreatedAt, userUpdatedAt string

	err := s.db.QueryRowContext(ctx, `
		SELECT s.id, s.user_id, s.token_hash, s.created_at, s.last_seen_at, s.expires_at, s.user_agent,
		       u.id, u.username, u.username_normalized, u.display_name,
		       COALESCE(u.email, ''), COALESCE(u.email_normalized, ''), COALESCE(u.email_verified_at, ''), u.password_hash,
		       u.role, u.status, u.locale, COALESCE(u.default_space_id, ''),
		       u.password_changed_at, u.created_at, u.updated_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = ?`, tokenHash).
		Scan(&sess.ID, &sess.UserID, &sess.TokenHash, &createdAt, &lastSeen, &expiresAt, &sess.UserAgent,
			&user.ID, &user.Username, &user.UsernameNorm, &user.DisplayName,
			&user.Email, &user.EmailNorm, &emailVerifiedAt, &user.PasswordHash,
			&role, &status, &user.Locale, &user.DefaultSpaceID,
			&passwordChangedAt, &userCreatedAt, &userUpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return auth.Session{}, auth.User{}, auth.ErrSessionInvalid
	}
	if err != nil {
		return auth.Session{}, auth.User{}, err
	}

	sess.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	sess.LastSeen, _ = time.Parse(time.RFC3339Nano, lastSeen)
	sess.ExpiresAt, _ = time.Parse(time.RFC3339Nano, expiresAt)
	if emailVerifiedAt != "" {
		if t, parseErr := time.Parse(time.RFC3339Nano, emailVerifiedAt); parseErr == nil {
			user.EmailVerifiedAt = &t
		}
	}
	user.Role = auth.Role(role)
	user.Status = auth.Status(status)
	user.PasswordChangedAt, _ = time.Parse(time.RFC3339Nano, passwordChangedAt)
	user.CreatedAt, _ = time.Parse(time.RFC3339Nano, userCreatedAt)
	user.UpdatedAt, _ = time.Parse(time.RFC3339Nano, userUpdatedAt)

	if time.Now().UTC().After(sess.ExpiresAt) {
		return auth.Session{}, auth.User{}, auth.ErrSessionInvalid
	}
	return sess, user, nil
}

// TouchSession updates last_seen_at.
func (s *AuthStore) TouchSession(ctx context.Context, sessionID string, at time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET last_seen_at = ? WHERE id = ?`, formatTime(at), sessionID)
	return err
}

// DeleteSession removes one session.
func (s *AuthStore) DeleteSession(ctx context.Context, sessionID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, sessionID)
	return err
}

// DeleteUserSessions removes all sessions of a user.
func (s *AuthStore) DeleteUserSessions(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, userID)
	return err
}
