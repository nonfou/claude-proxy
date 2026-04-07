const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Load .env file (zero-dependency, no need for dotenv package)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || '3456', 10);
const TARGET_URL = process.env.TARGET_URL || 'https://api.anthropic.com';
const target = new URL(TARGET_URL);

// Cache for rate limit info extracted from upstream response headers
const rateLimits = { updatedAt: null, headers: {} };

const RATELIMIT_PREFIXES = ['anthropic-ratelimit-', 'retry-after'];

function extractRateLimits(headers) {
  const extracted = {};
  for (const [key, value] of Object.entries(headers)) {
    if (RATELIMIT_PREFIXES.some(p => key.startsWith(p))) {
      extracted[key] = value;
    }
  }
  if (Object.keys(extracted).length > 0) {
    rateLimits.headers = extracted;
    rateLimits.updatedAt = new Date().toISOString();
  }
}

const server = http.createServer((clientReq, clientRes) => {
  // Dashboard page
  if (clientReq.method === 'GET' && (clientReq.url === '/' || clientReq.url === '/dashboard')) {
    const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf-8');
    clientRes.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    clientRes.end(html);
    return;
  }

  // Local rate-limits query endpoint
  if (clientReq.method === 'GET' && clientReq.url === '/rate-limits') {
    clientRes.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify(rateLimits, null, 2));
    return;
  }

  // Collect request body
  const bodyChunks = [];
  clientReq.on('data', chunk => bodyChunks.push(chunk));
  clientReq.on('end', () => {
    const body = Buffer.concat(bodyChunks);

    // Build forwarded headers: keep original, inject API key, fix host
    const fwdHeaders = { ...clientReq.headers };
    delete fwdHeaders['host'];
    delete fwdHeaders['x-api-key'];
    fwdHeaders['x-api-key'] = API_KEY;
    fwdHeaders['host'] = target.host;

    // Recalculate content-length for the actual body
    if (body.length > 0) {
      fwdHeaders['content-length'] = String(body.length);
    } else {
      delete fwdHeaders['content-length'];
    }
    // Remove transfer-encoding to avoid conflicts
    delete fwdHeaders['transfer-encoding'];

    const options = {
      hostname: target.hostname,
      port: target.port || 443,
      path: clientReq.url,
      method: clientReq.method,
      headers: fwdHeaders,
    };

    const proxyReq = https.request(options, (proxyRes) => {
      // Extract rate limit headers
      extractRateLimits(proxyRes.headers);

      // Forward status code and headers to client
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      // Stream the response body (supports SSE natively via pipe)
      proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', (err) => {
      console.error('Upstream error:', err.message);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
      }
    });

    // Send body to upstream
    if (body.length > 0) {
      proxyReq.write(body);
    }
    proxyReq.end();
  });

  clientReq.on('error', (err) => {
    console.error('Client request error:', err.message);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude API proxy listening on http://0.0.0.0:${PORT}`);
  console.log(`Forwarding to ${TARGET_URL}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`Rate limits: GET http://localhost:${PORT}/rate-limits`);
});
