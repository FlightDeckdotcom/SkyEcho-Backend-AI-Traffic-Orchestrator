'use strict';

class OpenSkyTokenManager {
  constructor({ fetchImpl, env = process.env, log = console.log } = {}) {
    this.fetch = fetchImpl || global.fetch;
    this.env = env;
    this.log = log;
    this.token = null;
    this.expiresAtMs = 0;
    this.refreshMarginMs = 60000;
    this.tokenUrl = env.OPENSKY_TOKEN_URL || 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
  }

  configured() {
    return !!(this.env.OPENSKY_CLIENT_ID && this.env.OPENSKY_CLIENT_SECRET);
  }

  async getToken() {
    if (!this.configured()) return null;
    if (this.token && Date.now() < this.expiresAtMs - this.refreshMarginMs) return this.token;
    if (!this.fetch) throw new Error('global fetch unavailable; use Node 18+');

    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', this.env.OPENSKY_CLIENT_ID);
    body.set('client_secret', this.env.OPENSKY_CLIENT_SECRET);

    const res = await this.fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenSky token HTTP ${res.status}: ${text.slice(0, 300)}`);

    const json = JSON.parse(text);
    if (!json.access_token) throw new Error('OpenSky token response missing access_token');

    this.token = json.access_token;
    this.expiresAtMs = Date.now() + Number(json.expires_in || 1800) * 1000;
    return this.token;
  }

  async headers() {
    const token = await this.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  snapshot() {
    return {
      configured: this.configured(),
      hasToken: !!this.token,
      expiresInSec: this.expiresAtMs ? Math.max(0, Math.round((this.expiresAtMs - Date.now()) / 1000)) : null
    };
  }
}

module.exports = { OpenSkyTokenManager };
