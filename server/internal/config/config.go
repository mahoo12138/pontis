// Package config loads server deployment configuration from a TOML file
// with environment variable overrides (prefix PONTIS_).
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// Config holds deployment settings. Product settings editable from the Web UI
// live in SQLite (system_settings), not here.
type Config struct {
	Listen  string `toml:"listen"`
	DataDir string `toml:"data_dir"`
	// PublicURL is the externally visible base URL. It decides the Origin a
	// cookie request must carry, whether the session cookie is Secure, and the
	// host baked into a generated password-reset link. Empty means "use the
	// Host header of each request", which is right for a same-origin install.
	//
	// TrustedProxies lists the peers allowed to report the client's scheme via
	// X-Forwarded-Proto. X-Forwarded-For is not consumed anywhere yet: nothing
	// logs or rate-limits by client address.
	PublicURL       string        `toml:"public_url"`
	TrustedProxies  []string      `toml:"trusted_proxies"`
	LogLevel        string        `toml:"log_level"`
	ShutdownTimeout time.Duration `toml:"shutdown_timeout"`

	// LinkCheckAllow lists CIDR ranges the server may reach when checking a
	// user's link. Empty means only publicly routable addresses, which is
	// the safe default: a link check runs with the server's own network
	// identity.
	LinkCheckAllow []string `toml:"link_check_allow_cidrs"`

	// OIDC configures the optional single sign-on provider. It lives here
	// rather than in system_settings because it is deployment-level fact
	// (the redirect URI is derived from public_url) and carries a client
	// secret that has no business in the database.
	OIDC OIDC `toml:"oidc"`

	// DatabasePath is derived from DataDir and not configurable via TOML.
	DatabasePath string `toml:"-"`
}

// OIDC is the single sign-on provider configuration. All fields are inert
// unless Enabled is true.
type OIDC struct {
	// Enabled turns the /auth/oidc/* endpoints and the login page entry on.
	Enabled bool `toml:"enabled"`
	// IssuerURL is the provider's issuer identifier, e.g. https://sso.example.
	// Discovery (/.well-known/openid-configuration) is fetched at boot: a
	// wrong value must fail the start, not the first login.
	IssuerURL string `toml:"issuer_url"`
	ClientID  string `toml:"client_id"`
	// ClientSecret is the RP secret issued by the provider.
	ClientSecret string `toml:"client_secret"`
	// Scopes requested on top of the provider's defaults. Empty means
	// ["openid", "profile", "email"].
	Scopes []string `toml:"scopes"`
	// AutoProvision creates a role=user account (with a Personal space, like
	// /auth/register) when an SSO identity matches no local user. Off means
	// an operator must create the account — with the matching email — first.
	AutoProvision bool `toml:"auto_provision"`
	// DisablePasswordLogin rejects /auth/login, /auth/register and
	// /auth/reset for a pure-SSO deployment. If the provider becomes
	// unreachable the unlock path is editing this file and restarting.
	DisablePasswordLogin bool `toml:"disable_password_login"`
}

// Default returns the built-in defaults.
func Default() Config {
	return Config{
		Listen:          ":8080",
		DataDir:         "data",
		LogLevel:        "info",
		ShutdownTimeout: 10 * time.Second,
		OIDC: OIDC{
			AutoProvision: true,
		},
	}
}

// Load reads the TOML file at path (skipped if it does not exist), applies
// environment overrides, then validates the result.
func Load(path string) (Config, error) {
	cfg := Default()

	if path != "" {
		if _, err := os.Stat(path); err == nil {
			if _, err := toml.DecodeFile(path, &cfg); err != nil {
				return Config{}, fmt.Errorf("decode %s: %w", path, err)
			}
		} else if !os.IsNotExist(err) {
			return Config{}, fmt.Errorf("stat %s: %w", path, err)
		}
	}

	applyEnv(&cfg)

	cfg.DatabasePath = filepath.Join(cfg.DataDir, "pontis.db")

	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func applyEnv(cfg *Config) {
	if v, ok := os.LookupEnv("PONTIS_LISTEN"); ok {
		cfg.Listen = v
	}
	if v, ok := os.LookupEnv("PONTIS_DATA_DIR"); ok {
		cfg.DataDir = v
	}
	if v, ok := os.LookupEnv("PONTIS_PUBLIC_URL"); ok {
		cfg.PublicURL = v
	}
	if v, ok := os.LookupEnv("PONTIS_LOG_LEVEL"); ok {
		cfg.LogLevel = v
	}
	if v, ok := os.LookupEnv("PONTIS_TRUSTED_PROXIES"); ok {
		cfg.TrustedProxies = splitList(v)
	}
	if v, ok := os.LookupEnv("PONTIS_LINK_CHECK_ALLOW_CIDRS"); ok {
		cfg.LinkCheckAllow = splitList(v)
	}
	if v, ok := os.LookupEnv("PONTIS_SHUTDOWN_TIMEOUT"); ok {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.ShutdownTimeout = d
		}
	}
	if v, ok := os.LookupEnv("PONTIS_OIDC_ENABLED"); ok {
		if b, err := strconv.ParseBool(v); err == nil {
			cfg.OIDC.Enabled = b
		}
	}
	if v, ok := os.LookupEnv("PONTIS_OIDC_ISSUER_URL"); ok {
		cfg.OIDC.IssuerURL = v
	}
	if v, ok := os.LookupEnv("PONTIS_OIDC_CLIENT_ID"); ok {
		cfg.OIDC.ClientID = v
	}
	if v, ok := os.LookupEnv("PONTIS_OIDC_CLIENT_SECRET"); ok {
		cfg.OIDC.ClientSecret = v
	}
	if v, ok := os.LookupEnv("PONTIS_OIDC_SCOPES"); ok {
		if scopes := splitList(v); len(scopes) > 0 {
			cfg.OIDC.Scopes = scopes
		}
	}
	if v, ok := os.LookupEnv("PONTIS_OIDC_AUTO_PROVISION"); ok {
		if b, err := strconv.ParseBool(v); err == nil {
			cfg.OIDC.AutoProvision = b
		}
	}
	if v, ok := os.LookupEnv("PONTIS_OIDC_DISABLE_PASSWORD_LOGIN"); ok {
		if b, err := strconv.ParseBool(v); err == nil {
			cfg.OIDC.DisablePasswordLogin = b
		}
	}
}

func splitList(v string) []string {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func (c Config) validate() error {
	if strings.TrimSpace(c.Listen) == "" {
		return fmt.Errorf("config: listen must not be empty")
	}
	if strings.TrimSpace(c.DataDir) == "" {
		return fmt.Errorf("config: data_dir must not be empty")
	}
	if c.ShutdownTimeout <= 0 {
		return fmt.Errorf("config: shutdown_timeout must be positive")
	}
	return c.OIDC.validate()
}

func (o OIDC) validate() error {
	if !o.Enabled {
		// Disabling password login with nothing to log in through would lock
		// every account out of the instance.
		if o.DisablePasswordLogin {
			return fmt.Errorf("config: oidc.disable_password_login requires oidc.enabled")
		}
		return nil
	}
	if strings.TrimSpace(o.IssuerURL) == "" {
		return fmt.Errorf("config: oidc.issuer_url must not be empty when oidc is enabled")
	}
	if strings.TrimSpace(o.ClientID) == "" {
		return fmt.Errorf("config: oidc.client_id must not be empty when oidc is enabled")
	}
	if strings.TrimSpace(o.ClientSecret) == "" {
		return fmt.Errorf("config: oidc.client_secret must not be empty when oidc is enabled")
	}
	return nil
}

// ScopeList returns the requested scopes with the OpenID baseline filled in
// when the operator left them empty.
func (o OIDC) ScopeList() []string {
	if len(o.Scopes) == 0 {
		return []string{"openid", "profile", "email"}
	}
	return o.Scopes
}
