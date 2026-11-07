-- 000026_oidc_sso: single sign-on identities, in-flight OIDC flow state and
-- device pairing codes.
--
-- oidc_identities: (issuer, subject) is the primary link between an IdP
-- account and a local user. Linking by email is only the bootstrap for the
-- first login; after that the immutable subject decides, so an email change
-- at the provider can never silently re-point an identity at another account.

CREATE TABLE oidc_identities (
    issuer        TEXT NOT NULL,
    subject       TEXT NOT NULL,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL,
    last_login_at TEXT NOT NULL,
    PRIMARY KEY (issuer, subject)
);

CREATE INDEX idx_oidc_identities_user ON oidc_identities(user_id);

-- oidc_auth_states: one row per authorization-code flow in progress. The
-- browser only ever holds the random state token; its hash is the lookup
-- key, the row is consumed exactly once and expires in minutes — the same
-- lifecycle password_reset_tokens already follow.

CREATE TABLE oidc_auth_states (
    state_hash   TEXT PRIMARY KEY,
    verifier     TEXT NOT NULL,
    nonce        TEXT NOT NULL,
    return_to    TEXT NOT NULL DEFAULT '',
    redirect_url TEXT NOT NULL DEFAULT '',
    expires_at   TEXT NOT NULL,
    created_at   TEXT NOT NULL
);

-- device_pairing_codes: single-use, short-lived codes that hand a device
-- token to a client that cannot hold a web session (the extension pairs
-- from a code generated in the web console instead of typing a password).
-- Stored hashed, like every other one-time secret here.

CREATE TABLE device_pairing_codes (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_pairing_codes_user ON device_pairing_codes(user_id);
