// A minimal local OIDC provider for the web-console e2e: discovery, JWKS,
// an /authorize that approves instantly (there is no person at this IdP), and
// a /token that enforces the client credentials and the PKCE verifier before
// minting a real RS256 ID token. The server under test runs its full flow
// against it — discovery at boot, code exchange, signature verification —
// so only the human at the login page is simulated.
//
// Deliberately in-memory and single-tenant. Not a reference IdP.

import { createServer } from 'node:http';
import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export class StubOIDC {
  /**
   * @param {{ clientId: string, clientSecret: string,
   *           claims: { sub: string, preferred_username: string, email: string, email_verified: boolean } }} opts
   */
  constructor({ clientId, clientSecret, claims }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.claims = claims;
    this.issuer = '';
    this.server = createServer((req, res) => this.route(req, res));
    // One key for the whole run; the JWKS publishes exactly it.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.jwk = { kty: jwk.kty, n: jwk.n, e: jwk.e, kid: 'e2e-key', alg: 'RS256', use: 'sig' };
    /** code -> { challenge, nonce, redirectUri } */
    this.grants = new Map();
  }

  async start() {
    await new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.issuer = `http://127.0.0.1:${this.server.address().port}`;
        resolve();
      });
    });
    return this.issuer;
  }

  stop() {
    this.server.close();
  }

  json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  route(req, res) {
    const url = new URL(req.url, this.issuer);
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return this.json(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (req.method === 'GET' && url.pathname === '/jwks') {
      return this.json(res, 200, { keys: [this.jwk] });
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      // The person "signs in" instantly and consents to everything: mint a
      // code bound to this challenge+nonce and bounce straight back.
      const code = crypto.randomBytes(16).toString('base64url');
      this.grants.set(code, {
        challenge: url.searchParams.get('code_challenge'),
        nonce: url.searchParams.get('nonce'),
        redirectUri: url.searchParams.get('redirect_uri') ?? '',
      });
      const back = new URL(this.grants.get(code).redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        const form = new URLSearchParams(body);
        if (form.get('client_id') !== this.clientId || form.get('client_secret') !== this.clientSecret) {
          return this.json(res, 401, { error: 'invalid_client' });
        }
        const grant = this.grants.get(form.get('code') ?? '');
        if (!grant || grant.redirectUri !== form.get('redirect_uri')) {
          return this.json(res, 400, { error: 'invalid_grant' });
        }
        this.grants.delete(form.get('code'));
        const verifier = form.get('code_verifier') ?? '';
        const digest = crypto.createHash('sha256').update(verifier).digest('base64url');
        if (digest !== grant.challenge) {
          return this.json(res, 400, { error: 'invalid_grant', error_description: 'pkce mismatch' });
        }
        const now = Math.floor(Date.now() / 1000);
        const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: this.jwk.kid }));
        const payload = b64url(JSON.stringify({
          iss: this.issuer,
          aud: this.clientId,
          exp: now + 300,
          iat: now,
          nonce: grant.nonce,
          ...this.claims,
        }));
        const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), this.privateKey);
        this.json(res, 200, {
          access_token: 'e2e-access-token',
          token_type: 'Bearer',
          id_token: `${header}.${payload}.${b64url(signature)}`,
        });
      });
    }
    this.json(res, 404, { error: 'not_found' });
  }
}
