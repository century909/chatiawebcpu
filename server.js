/**
 * Simple CORS proxy for Hugging Face (or any HTTPS endpoint).
 * Purpose: Work around CORS blocks when fetching model artifacts from the browser.
 *
 * Usage:
 *   1) Run: node server.js
 *   2) In the web app, enable "Usar URL base personalizada" and set:
 *        http://localhost:5174/proxy/https://huggingface.co
 *      Example final URL formed by the app:
 *        http://localhost:5174/proxy/https://huggingface.co/Xenova/gpt2/resolve/main/config.json
 *
 * Notes:
 * - Only GET/HEAD/OPTIONS are allowed.
 * - Streams large files (e.g., .onnx) without loading them fully into memory.
 * - Adds Access-Control-Allow-Origin: * so the browser can consume responses.
 *
 * Security:
 * - This is a local development helper. Do NOT expose publicly without restrictions.
 */

const http = require('node:http');
const { Readable } = require('node:stream');
const PORT = process.env.PORT ? Number(process.env.PORT) : 5174;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

function sendError(res, code, message) {
  setCors(res);
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message + '\n');
}

const server = http.createServer(async (req, res) => {
  try {
    // Preflight handling
    if (req.method === 'OPTIONS') {
      setCors(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(res, 405, 'Method Not Allowed');
    }

    // Expect path: /proxy/{encoded_full_url}
    const prefix = '/proxy/';
    if (!req.url || !req.url.startsWith(prefix)) {
      return sendError(res, 404, 'Use path: /proxy/https://huggingface.co/...');
    }

    // Extract full target URL
    const encoded = req.url.slice(prefix.length);
    // Do not decodeURIComponent blindly; allow raw "https://..." after /proxy/
    // Browsers will send it already decoded if you typed it as plain text.
    const targetUrl = encoded;

    if (!/^https?:\/\//i.test(targetUrl)) {
      return sendError(res, 400, 'Proxy target must start with http(s)://');
    }

    // Forward a minimal subset of headers (range requests, etags, etc.)
    const fwdHeaders = {};
    const forwardList = [
      'range',
      'if-range',
      'if-none-match',
      'if-modified-since',
      'accept',
      'accept-encoding',
      'accept-language',
      'user-agent',
      'referer',
      'origin',
      'content-type',
    ];
    for (const h of forwardList) {
      const v = req.headers[h];
      if (v !== undefined) fwdHeaders[h] = v;
    }

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: fwdHeaders,
      redirect: 'follow',
      cache: 'no-store',
    });

    // Copy status and headers
    res.statusCode = upstream.status;
    for (const [k, v] of upstream.headers) {
      // Drop security headers that may block embedding/consumption
      const lk = k.toLowerCase();
      if (['content-security-policy'].includes(lk)) continue;
      res.setHeader(k, v);
    }
    // Ensure CORS on the proxied response
    setCors(res);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    // Stream body
    const body = upstream.body;
    if (!body) {
      res.end();
      return;
    }

    // Convert Web Stream to Node stream and pipe
    const nodeStream = Readable.fromWeb(body);
    nodeStream.on('error', (e) => {
      // Network error mid-stream
      if (!res.headersSent) {
        res.statusCode = 502;
        setCors(res);
      }
      res.end(`Upstream stream error: ${e.message || e}\n`);
    });
    nodeStream.pipe(res);
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    sendError(res, 502, `Proxy error: ${msg}`);
  }
});

server.listen(PORT, () => {
  console.log(`[proxy] Listening on http://localhost:${PORT}`);
  console.log('[proxy] Example base URL for the app: http://localhost:' + PORT + '/proxy/https://huggingface.co');
});