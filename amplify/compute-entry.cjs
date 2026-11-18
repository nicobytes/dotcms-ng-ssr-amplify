/**
 * Amplify Hosting compute entry point.
 *
 * Amplify requires the compute entry to start an HTTP server on port 3000
 * (deployment spec). Angular's `server.mjs` only calls `listen()` when it is the
 * main module, so this wrapper imports the Express app and serves it itself.
 *
 * It also:
 *  1. Loads a `.env` file bundled next to this file (Amplify does not inject the
 *     console's environment variables into the compute runtime for non-Next.js
 *     apps — spike assumption, verify; see README).
 *  2. Promotes `x-forwarded-host` to `host` and strips `x-forwarded-*`, the same
 *     normalization the Vercel version did, so Angular's SSRF host allowlist sees
 *     a single clean host behind CloudFront.
 *  3. When SPIKE_DEBUG=true, exposes /__spike/headers to inspect what CloudFront
 *     actually forwards to the compute (answers the "which host reaches Angular?"
 *     question of the spike). REMOVE before any real use.
 */
const http = require('node:http');
const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // No .env bundled: rely on the process environment.
}

// Amplify does not set NODE_ENV for the compute; default to production so the
// dotCMS client does not log verbosely (see getClient in src/server.ts).
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const PORT = Number(process.env.PORT) || 3000;
const appPromise = import(path.join(__dirname, 'server', 'server.mjs'));

const server = http.createServer(async (req, res) => {
  if (process.env.SPIKE_DEBUG === 'true' && req.url === '/__spike/headers') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: req.url, headers: req.headers }, null, 2));
    return;
  }

  const forwardedHost = req.headers['x-forwarded-host'];
  if (forwardedHost) {
    req.headers.host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
  }
  for (const name of Object.keys(req.headers)) {
    if (name.startsWith('x-forwarded-')) {
      delete req.headers[name];
    }
  }

  try {
    const { default: app } = await appPromise;
    app(req, res);
  } catch (error) {
    console.error('SSR bootstrap failed', error);
    res.statusCode = 500;
    res.end('Internal Server Error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Angular SSR listening on port ${PORT}`);
});
