package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"

	"pontis/internal/canonical"
)

// User is a registered account. PasswordHash is only populated by the
// store when loading a user for credential verification.
type User struct {
	ID                string
	Username          string
	UsernameNorm      string
	DisplayName       string
	Email             string
	EmailNorm         string
	EmailVerifiedAt   *time.Time
	PasswordHash      string
	Role              Role
	Status            Status
	Locale            string
	DefaultSpaceID    canonical.SpaceID
	PasswordChangedAt time.Time
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// Role is the V1 product role.
type Role string

const (
	RoleAdmin Role = "admin"
	RoleUser  Role = "user"
)

// Status is the account lifecycle state. Disabled users keep their data;
// all credentials are refused while disabled.
type Status string

const (
	StatusActive   Status = "active"
	StatusDisabled Status = "disabled"
)

// Session is a web session. The raw token never leaves the client; only
// its hash is stored.
type Session struct {
	ID        string
	UserID    string
	TokenHash string
	CreatedAt time.Time
	LastSeen  time.Time
	ExpiresAt time.Time
	UserAgent string
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NormalizeUsername maps a username to its case-insensitive unique form.
func NormalizeUsername(username string) string {
	return foldASCII(username)
}

// foldASCII lowercases ASCII letters only. Usernames are restricted to a
// conservative charset, so this is sufficient for the uniqueness key.
func foldASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

// ValidateUsername enforces the conservative username charset: 3-32 chars
// of letters, digits, underscore, hyphen or dot.
func ValidateUsername(username string) bool {
	if len(username) < 3 || len(username) > 32 {
		return false
	}
	for _, c := range username {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '_' || c == '-' || c == '.':
		default:
			return false
		}
	}
	return true
}

// ValidatePassword enforces the minimum password policy.
func ValidatePassword(password string) bool {
	return len(password) >= 8 && len(password) <= 256
}

// NormalizeEmail folds an email address for uniqueness checks.
func NormalizeEmail(email string) string {
	return foldASCII(strings.TrimSpace(email))
}

// ValidateEmail accepts an empty email (optional) or a syntactically plausible
// address without whitespace/control characters.
func ValidateEmail(email string) bool {
	if email == "" {
		return true
	}
	if len(email) > 254 {
		return false
	}
	for _, r := range email {
		if r <= 0x20 || r == 0x7f {
			return false
		}
	}
	at := strings.IndexByte(email, '@')
	if at <= 0 || at > 64 || at != strings.LastIndexByte(email, '@') {
		return false
	}
	domain := email[at+1:]
	if len(domain) < 3 || strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") || strings.Contains(domain, "..") {
		return false
	}
	return strings.ContainsRune(domain, '.')
}
