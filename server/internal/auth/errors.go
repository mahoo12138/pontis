// Package auth implements users, Argon2id password hashing and
// server-side opaque web sessions.
package auth

import "errors"

// Errors. Domain-level only; the HTTP layer maps them to status codes.
var (
	// ErrInvalidUsername is returned for usernames failing validation.
	ErrInvalidUsername = errors.New("auth: invalid username")

	// ErrInvalidPassword is returned for passwords failing validation.
	ErrInvalidPassword = errors.New("auth: invalid password")

	// ErrUserExists is returned when username or email is already taken.
	ErrUserExists = errors.New("auth: user already exists")

	// ErrInvalidCredentials is returned on unknown user or wrong password.
	ErrInvalidCredentials = errors.New("auth: invalid credentials")

	// ErrUserDisabled is returned when the account is disabled.
	ErrUserDisabled = errors.New("auth: user disabled")

	// ErrSessionInvalid is returned for unknown, expired or revoked sessions.
	ErrSessionInvalid = errors.New("auth: session invalid")

	// ErrResetTokenInvalid is returned for unknown, expired or used reset tokens.
	ErrResetTokenInvalid = errors.New("auth: reset token invalid")

	// ErrEmailTaken is returned when the email is already in use.
	ErrEmailTaken = errors.New("auth: email already in use")

	// ErrInvalidEmail is returned when a non-empty email fails format checks.
	ErrInvalidEmail = errors.New("auth: invalid email")

	// ErrAlreadyInitialized is returned when /auth/setup is called after the
	// first admin already exists.
	ErrAlreadyInitialized = errors.New("auth: instance already initialized")

	// ErrNotInitialized is returned when user creation requires an existing admin.
	ErrNotInitialized = errors.New("auth: instance has no admin yet")

	// ErrLastAdmin is returned when mutating a user would leave zero active admins.
	ErrLastAdmin = errors.New("auth: cannot remove or disable the last active admin")

	// ErrUserNotFound is returned by account lookups that find no row. The
	// credential paths keep answering ErrInvalidCredentials so they cannot
	// disclose which half was wrong; administrative and SSO lookups have no
	// such audience and can say "not found" plainly.
	ErrUserNotFound = errors.New("auth: user not found")

	// ErrOIDCStateInvalid is returned when the state token of a sign-in flow
	// is unknown, already consumed or expired: the browser retry the login.
	ErrOIDCStateInvalid = errors.New("auth: oidc flow state invalid or expired")

	// ErrOIDCTokenExchange is returned when the provider rejects the
	// authorization code.
	ErrOIDCTokenExchange = errors.New("auth: oidc code exchange failed")

	// ErrOIDCTokenInvalid is returned when the ID token fails verification
	// (signature, issuer, audience, expiry or nonce).
	ErrOIDCTokenInvalid = errors.New("auth: oidc token invalid")

	// ErrOIDCAccountNotLinked is returned when a verified identity matches no
	// local account and auto-provisioning is switched off.
	ErrOIDCAccountNotLinked = errors.New("auth: oidc identity matches no local account")

	// ErrOIDCNotInitialized is returned when SSO reaches an instance with no
	// admin yet. Bootstrap is /auth/setup; SSO must never mint that role.
	ErrOIDCNotInitialized = errors.New("auth: instance has no admin yet")

	// ErrOIDCUnavailable is returned when the endpoints are hit without a
	// configured provider.
	ErrOIDCUnavailable = errors.New("auth: oidc is not configured")

	// ErrOIDCProvisionFailed is returned when automatic account creation
	// could not complete after its bounded retries.
	ErrOIDCProvisionFailed = errors.New("auth: oidc provisioning failed")
)
