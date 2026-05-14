'use strict';

function registerNetworkDiagnosticsRoutes({ app, requireSecret }) {
  app.post('/traffic-v2/net/test', requireSecret, async (req, res) => {
    const url = String(req.body?.url || '').trim();

    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({
        ok: false,
        error: 'Missing valid url'
      });
    }

    const started = Date.now();

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'SkyEchoCabin-TrafficV2/1.0',
          'Accept': 'application/json'
        }
      });

      const text = await response.text();

      res.json({
        ok: true,
        url,
        status: response.status,
        statusText: response.statusText,
        elapsedMs: Date.now() - started,
        headers: {
          contentType: response.headers.get('content-type'),
          rateRemaining: response.headers.get('x-rate-limit-remaining'),
          retryAfter: response.headers.get('x-rate-limit-retry-after-seconds')
        },
        bodyPreview: text.slice(0, 500)
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        url,
        elapsedMs: Date.now() - started,
        error: err && err.message ? err.message : String(err),
        name: err && err.name ? err.name : null,
        cause: err && err.cause ? String(err.cause) : null
      });
    }
  });
}

module.exports = {
  registerNetworkDiagnosticsRoutes
};
