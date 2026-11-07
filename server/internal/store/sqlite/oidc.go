package sqlite

// OIDC identity and flow-state persistence. Rows live in the tables of
// migration 000026; the contract they implement is auth.OIDCStore.

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"pontis/internal/auth"
)

// userColumnsForUsers is userColumns qualified for a query where users is
// joined against another table that shares column names (created_at).
const userColumnsQualified = `
	SELECT u.id, u.username, u.username_normalized, u.display_name,
	       COALESCE(u.email, ''), COALESCE(u.email_normalized, ''), u.password_hash,
	       u.role, u.status, u.locale, COALESCE(u.default_space_id, ''),
	       u.password_changed_at, u.created_at, u.updated_at`

// GetOIDCIdentityUser resolves an (issuer, subject) identity to its linked
// account.
func (s *AuthStore) GetOIDCIdentityUser(ctx context.Context, issuer, subject string) (auth.User, error) {
	u, err := scanUser(s.db.QueryRowContext(ctx, userColumnsQualified+`
		FROM oidc_identities i JOIN users u ON u.id = i.user_id
		WHERE i.issuer = ? AND i.subject = ?`, issuer, subject))
	if errors.Is(err, auth.ErrInvalidCredentials) {
		return auth.User{}, auth.ErrUserNotFound
	}
	return u, err
}

// UpsertOIDCIdentity links an identity to an account. An existing link is
// never re-pointed: the ON CONFLICT clause touches the login timestamp only,
// because a link that exists is the one that decided the last login.
func (s *AuthStore) UpsertOIDCIdentity(ctx context.Context, issuer, subject, userID string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO oidc_identities (issuer, subject, user_id, created_at, last_login_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(issuer, subject) DO UPDATE SET last_login_at = excluded.last_login_at`,
		issuer, subject, userID, formatTime(at), formatTime(at))
	return err
}

// GetUserByEmailNormalized loads an account by its email uniqueness key.
func (s *AuthStore) GetUserByEmailNormalized(ctx context.Context, emailNorm string) (auth.User, error) {
	u, err := scanUser(s.db.QueryRowContext(ctx,
		userColumns+` FROM users WHERE email_normalized = ?`, emailNorm))
	if errors.Is(err, auth.ErrInvalidCredentials) {
		return auth.User{}, auth.ErrUserNotFound
	}
	return u, err
}

// InsertOIDCState stores one in-flight sign-in flow and prunes the expired
// ones. Nothing else reads this table by age; sweeping here keeps it from
// growing across a deployment that never finishes a flow.
func (s *AuthStore) InsertOIDCState(ctx context.Context, st auth.OIDCState) error {
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM oidc_auth_states WHERE expires_at <= ?`, formatTime(st.CreatedAt)); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO oidc_auth_states (state_hash, verifier, nonce, return_to, redirect_url, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		st.StateHash, st.Verifier, st.Nonce, st.ReturnTo, st.RedirectURL,
		formatTime(st.ExpiresAt), formatTime(st.CreatedAt))
	return err
}

// ConsumeOIDCState reads and deletes a flow in one transaction. Split into
// "look up" and "delete", two callbacks racing one state token could both
// pass the check; the guarded delete decides the single winner, and the
// loser's delete reports zero rows affected.
func (s *AuthStore) ConsumeOIDCState(ctx context.Context, stateHash string) (auth.OIDCState, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return auth.OIDCState{}, err
	}
	defer tx.Rollback() //nolint:errcheck // after Commit it is a no-op

	var st auth.OIDCState
	var expiresAt, createdAt string
	err = tx.QueryRowContext(ctx, `
		SELECT state_hash, verifier, nonce, return_to, redirect_url, expires_at, created_at
		FROM oidc_auth_states WHERE state_hash = ?`, stateHash).
		Scan(&st.StateHash, &st.Verifier, &st.Nonce, &st.ReturnTo, &st.RedirectURL, &expiresAt, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return auth.OIDCState{}, auth.ErrOIDCStateInvalid
	}
	if err != nil {
		return auth.OIDCState{}, err
	}

	res, err := tx.ExecContext(ctx,
		`DELETE FROM oidc_auth_states WHERE state_hash = ?`, stateHash)
	if err != nil {
		return auth.OIDCState{}, err
	}
	if won, err := res.RowsAffected(); err != nil {
		return auth.OIDCState{}, err
	} else if won == 0 {
		return auth.OIDCState{}, auth.ErrOIDCStateInvalid
	}
	if err := tx.Commit(); err != nil {
		return auth.OIDCState{}, err
	}

	st.ExpiresAt, _ = time.Parse(time.RFC3339Nano, expiresAt)
	st.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	return st, nil
}
