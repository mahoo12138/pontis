package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters. Correctness-first defaults for a self-hosted,
// single-server deployment.
const (
	argonTime    = 1
	argonMemory  = 64 * 1024 // 64 MiB
	argonThreads = 4
	argonKeyLen  = 32
	argonSaltLen = 16
)

// argonSem bounds concurrent Argon2id derivations so a flood of anonymous
// login/register requests cannot exhaust memory on a small host (64 MiB × 4 = 256 MiB).
var argonSem = make(chan struct{}, 4)

// dummyPasswordHash is verified on unknown or passwordless accounts to keep
// login latency comparable across account states.
const dummyPasswordHash = "$argon2id$v=19$m=65536,t=1,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func acquireArgon(ctx context.Context) error {
	select {
	case argonSem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// HashPassword derives an Argon2id hash encoded in PHC string format.
func HashPassword(password string) (string, error) {
	return HashPasswordContext(context.Background(), password)
}

// HashPasswordContext derives an Argon2id hash while respecting concurrency
// limits and context cancellation.
func HashPasswordContext(ctx context.Context, password string) (string, error) {
	if err := acquireArgon(ctx); err != nil {
		return "", err
	}
	defer func() { <-argonSem }()

	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: read salt: %w", err)
	}
	hash := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash)), nil
}

// VerifyPassword checks a password against a PHC-format Argon2id hash in
// constant time.
func VerifyPassword(password, encoded string) (bool, error) {
	return VerifyPasswordContext(context.Background(), password, encoded)
}

// VerifyPasswordContext checks a password against a PHC-format Argon2id hash
// while bounding concurrent memory usage and honouring context cancellation.
func VerifyPasswordContext(ctx context.Context, password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	// "", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, fmt.Errorf("auth: malformed password hash")
	}

	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return false, fmt.Errorf("auth: malformed hash version: %w", err)
	}

	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false, fmt.Errorf("auth: malformed hash params: %w", err)
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, fmt.Errorf("auth: malformed salt: %w", err)
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, fmt.Errorf("auth: malformed hash: %w", err)
	}

	if err := acquireArgon(ctx); err != nil {
		return false, err
	}
	defer func() { <-argonSem }()

	got := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// newSessionToken returns a fresh opaque session token together with its
// SHA-256 hash for storage.
func newSessionToken() (token string, tokenHash string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", fmt.Errorf("auth: read token entropy: %w", err)
	}
	token = base64.RawURLEncoding.EncodeToString(raw)
	return token, hashToken(token), nil
}
