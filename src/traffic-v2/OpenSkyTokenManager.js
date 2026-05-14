'use strict';

class OpenSkyTokenManager {
  constructor({ fetchImpl, env = process.env, log = console.log } = {}) {
    this.fetch = fetchImpl || global.fetch;
    this.env = env;
    this.log = log;
    this.token = null;
    this.expiresAtMs = 0;
    this.refreshMarginMs = 60000;

    this.tokenUrl =
      env.OPENSKY_TOKEN_URL ||
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
  }

  configured() {
    return !!(
      this.env.OPENSKY_CLIENT_ID &&
      this.env.OPENSKY_CLIENT_SECRET
    );
  }

  async getToken() {
    if (!this.configured()) {
      return null;
    }

    if (
      this.token &&
      Date.now() < this.expiresAtMs - this.refreshMarginMs
    ) {
      return this.token;
    }

    if (!this.fetch) {
      throw new Error('global fetch unavailable; use Node 18+');
    }

    const clientId = String(this.env.OPENSKY_CLIENT_ID || '').trim();
    const clientSecret = String(this.env.OPENSKY_CLIENT_SECRET || '').trim();

    if (!clientId || !clientSecret) {
      throw new Error('OpenSky client ID or client secret is empty after trimming');
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);

    let res;

    try {
      res = await this.fetch(this.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
      });
    } catch (err) {
      throw new Error(
        `OpenSky token fetch failed at ${this.tokenUrl}: ` +
        `${err && err.message ? err.message : String(err)}`
      );
    }

    let text = '';

    try {
      text = await res.text();
    } catch (err) {
      throw new Error(
        `OpenSky token response could not be read: ` +
        `${err && err.message ? err.message : String(err)}`
      );
    }

    if (!res.ok) {
      throw new Error(
        `OpenSky token HTTP ${res.status}: ${text.slice(0, 500)}`
      );
    }

    let json;

    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `OpenSky token response was not valid JSON: ${text.slice(0, 500)}`
      );
    }

    if (!json.access_token) {
      throw new Error(
        `OpenSky token response missing access_token: ${text.slice(0, 500)}`
      );
    }

    this.token = json.access_token;
    this.expiresAtMs =
      Date.now() + Number(json.expires_in || 1800) * 1000;

    return this.token;
  }

  async headers() {
    const token = await this.getToken();

    return token
      ? {
          Authorization: `Bearer ${token}`
        }
      : {};
  }

  snapshot() {
    return {
      configured: this.configured(),
      hasToken: !!this.token,
      expiresInSec: this.expiresAtMs
        ? Math.max(
            0,
            Math.round((this.expiresAtMs - Date.now()) / 1000)
          )
        : null,
      tokenUrl: this.tokenUrl,
      clientIdPresent: !!this.env.OPENSKY_CLIENT_ID,
      clientSecretPresent: !!this.env.OPENSKY_CLIENT_SECRET
    };
  }
}

module.exports = {
  OpenSkyTokenManager
};
