const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { spawn } = require('child_process');

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

// --- Auth State ---
const auth = {
  mode: null,          // 'apikey' | 'oauth'
  token: null,         // The current token value
  source: null,        // 'env:ANTHROPIC_API_KEY' | 'env:ANTHROPIC_AUTH_TOKEN' | 'file:<path>'
  headerName: null,    // 'x-api-key' | 'authorization'
  headerValue: null,   // The full header value
  filePath: null,      // If reading from file, the resolved absolute path
  lastReadAt: null,    // ISO timestamp of last file read
  lastError: null,     // Last error message (if any)
};

function resolveHomePath(p) {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

function readTokenFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const settings = JSON.parse(content);
    const token = settings && settings.env && settings.env.ANTHROPIC_AUTH_TOKEN;
    if (!token) return { token: null, error: 'ANTHROPIC_AUTH_TOKEN not found in ' + filePath };
    return { token, error: null };
  } catch (err) {
    return { token: null, error: 'Failed to read ' + filePath + ': ' + err.message };
  }
}

function refreshAuth() {
  if (!auth.filePath) return false;
  const { token, error } = readTokenFromFile(auth.filePath);
  if (error) {
    auth.lastError = error;
    console.error('[auth] ' + error);
    return false;
  }
  auth.token = token;
  auth.headerValue = auth.headerName === 'x-api-key' ? token : 'Bearer ' + token;
  auth.lastReadAt = new Date().toISOString();
  auth.lastError = null;
  console.log('[auth] Token refreshed from ' + auth.filePath);
  return true;
}

function maskToken(token) {
  if (!token) return '****';
  if (token.length > 8) return token.slice(0, 4) + '...' + token.slice(-4);
  return '****';
}

// --- Auth Initialization ---
const envApiKey = process.env.ANTHROPIC_API_KEY;
const envAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const envCredFile = process.env.CLAUDE_CREDENTIALS_FILE;
const envHeaderName = process.env.AUTH_HEADER_NAME;
const refreshInterval = parseInt(process.env.TOKEN_REFRESH_INTERVAL || '0', 10);

if (envApiKey) {
  auth.mode = 'apikey';
  auth.token = envApiKey;
  auth.source = 'env:ANTHROPIC_API_KEY';
  auth.headerName = (envHeaderName || 'x-api-key').toLowerCase();
  auth.headerValue = envApiKey;
} else if (envAuthToken) {
  auth.mode = 'oauth';
  auth.token = envAuthToken;
  auth.source = 'env:ANTHROPIC_AUTH_TOKEN';
  auth.headerName = (envHeaderName || 'authorization').toLowerCase();
  auth.headerValue = auth.headerName === 'x-api-key' ? envAuthToken : 'Bearer ' + envAuthToken;
} else {
  const credPath = resolveHomePath(envCredFile || '~/.claude/settings.json');
  const { token, error } = readTokenFromFile(credPath);
  if (error) {
    console.warn('Warning: No auth credentials found. Use Dashboard to login.');
    console.warn('  Detail: ' + error);
    // Start in unauthenticated mode - allow login from Dashboard
    auth.mode = 'none';
    auth.source = 'none';
    auth.filePath = credPath;
    auth.headerName = (envHeaderName || 'authorization').toLowerCase();
    auth.lastError = error;
  } else {
    auth.mode = 'oauth';
    auth.token = token;
    auth.source = 'file:' + credPath;
    auth.filePath = credPath;
    auth.headerName = (envHeaderName || 'authorization').toLowerCase();
    auth.headerValue = auth.headerName === 'x-api-key' ? token : 'Bearer ' + token;
    auth.lastReadAt = new Date().toISOString();
  }
}

// Periodic refresh (only for file-based tokens)
if (auth.filePath && refreshInterval > 0) {
  setInterval(() => refreshAuth(), refreshInterval * 1000);
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

// --- Login Process State ---
const loginState = {
  status: 'idle',    // 'idle' | 'running' | 'completed' | 'failed'
  authUrl: null,     // Authorization URL to show in dashboard
  output: '',        // Captured stdout/stderr
  error: null,       // Error message if failed
  startedAt: null,
  process: null,     // Child process reference
};

function findClaudeCommand() {
  // Check common locations
  const candidates = ['claude'];
  for (const cmd of candidates) {
    try {
      const { execSync } = require('child_process');
      execSync((process.platform === 'win32' ? 'where ' : 'which ') + cmd, { stdio: 'ignore' });
      return cmd;
    } catch (e) { /* not found */ }
  }
  // Fallback to npx
  return 'npx';
}

function startLogin() {
  if (loginState.status === 'running') {
    return { ok: false, error: 'Login already in progress' };
  }

  loginState.status = 'running';
  loginState.authUrl = null;
  loginState.output = '';
  loginState.error = null;
  loginState.startedAt = new Date().toISOString();

  const cmd = findClaudeCommand();
  const args = cmd === 'npx' ? ['--yes', '@anthropic-ai/claude-code', 'login'] : ['login'];

  console.log('[login] Starting: ' + cmd + ' ' + args.join(' '));

  const child = spawn(cmd, args, {
    env: { ...process.env, BROWSER: 'none', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  loginState.process = child;

  function handleOutput(data) {
    const text = data.toString();
    loginState.output += text;
    console.log('[login] ' + text.trim());

    // Look for authorization URL in output
    if (!loginState.authUrl) {
      const urlMatch = text.match(/https:\/\/[^\s]+auth[^\s]*/i) ||
                       text.match(/https:\/\/[^\s]+login[^\s]*/i) ||
                       text.match(/https:\/\/[^\s]+oauth[^\s]*/i) ||
                       text.match(/https:\/\/console\.anthropic\.com[^\s]*/i) ||
                       text.match(/https:\/\/claude\.ai[^\s]*/i) ||
                       text.match(/(https:\/\/[^\s]+)/);
      if (urlMatch) {
        loginState.authUrl = urlMatch[0].replace(/[)\]}>'"]+$/, ''); // trim trailing punctuation
        console.log('[login] Auth URL found: ' + loginState.authUrl);
      }
    }
  }

  child.stdout.on('data', handleOutput);
  child.stderr.on('data', handleOutput);

  child.on('close', (code) => {
    loginState.process = null;
    if (code === 0) {
      loginState.status = 'completed';
      console.log('[login] Login completed successfully');
      // Refresh auth from file
      if (auth.filePath) {
        const { token, error } = readTokenFromFile(auth.filePath);
        if (!error && token) {
          auth.mode = 'oauth';
          auth.token = token;
          auth.source = 'file:' + auth.filePath;
          auth.headerValue = auth.headerName === 'x-api-key' ? token : 'Bearer ' + token;
          auth.lastReadAt = new Date().toISOString();
          auth.lastError = null;
          console.log('[login] Auth token loaded: ' + maskToken(token));
        }
      }
    } else {
      loginState.status = 'failed';
      loginState.error = 'Process exited with code ' + code;
      console.error('[login] Failed: exit code ' + code);
    }
  });

  child.on('error', (err) => {
    loginState.process = null;
    loginState.status = 'failed';
    loginState.error = err.message;
    console.error('[login] Error: ' + err.message);
  });

  return { ok: true };
}

function cancelLogin() {
  if (loginState.process) {
    loginState.process.kill();
    loginState.process = null;
    loginState.status = 'idle';
    loginState.error = 'Cancelled by user';
    return { ok: true };
  }
  return { ok: false, error: 'No login process running' };
}

// Proxy request with 401 retry for file-based OAuth
function makeProxyRequest(options, body, clientRes, isRetry) {
  const proxyReq = https.request(options, (proxyRes) => {
    extractRateLimits(proxyRes.headers);

    // On 401 + file-based OAuth + first attempt: try refreshing token
    if (proxyRes.statusCode === 401 && auth.filePath && !isRetry) {
      proxyRes.resume(); // drain the 401 response
      console.log('[auth] Got 401, attempting token refresh...');
      const refreshed = refreshAuth();
      if (refreshed) {
        options.headers[auth.headerName] = auth.headerValue;
        makeProxyRequest(options, body, clientRes, true);
        return;
      }
      console.log('[auth] Token refresh failed, forwarding 401 to client');
      // Re-send the 401 - but we already drained the original response,
      // so forward a synthetic 401
      if (!clientRes.headersSent) {
        clientRes.writeHead(401, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({
          error: 'Unauthorized',
          message: 'Token refresh failed. Run "claude login" on server to re-authenticate.',
        }));
      }
      return;
    }

    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on('error', (err) => {
    console.error('Upstream error:', err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
    }
  });

  if (body.length > 0) {
    proxyReq.write(body);
  }
  proxyReq.end();
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

  // Auth status endpoint
  if (clientReq.method === 'GET' && clientReq.url === '/auth-status') {
    clientRes.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify({
      mode: auth.mode,
      source: auth.source,
      headerName: auth.headerName,
      tokenMasked: maskToken(auth.token),
      lastReadAt: auth.lastReadAt,
      lastError: auth.lastError,
      refreshInterval: auth.filePath ? refreshInterval : null,
    }, null, 2));
    return;
  }

  // Start login process
  if (clientReq.method === 'POST' && clientReq.url === '/auth-login') {
    const result = startLogin();
    const code = result.ok ? 200 : 409;
    clientRes.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify(result));
    return;
  }

  // Check login status
  if (clientReq.method === 'GET' && clientReq.url === '/auth-login-status') {
    clientRes.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify({
      status: loginState.status,
      authUrl: loginState.authUrl,
      error: loginState.error,
      startedAt: loginState.startedAt,
      output: loginState.output.slice(-2000), // last 2000 chars
    }, null, 2));
    return;
  }

  // Cancel login process
  if (clientReq.method === 'POST' && clientReq.url === '/auth-login-cancel') {
    const result = cancelLogin();
    clientRes.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify(result));
    return;
  }

  // Refresh auth token from file
  if (clientReq.method === 'POST' && clientReq.url === '/auth-refresh') {
    const ok = refreshAuth();
    clientRes.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify({ ok, token: maskToken(auth.token), error: auth.lastError }));
    return;
  }

  // Block API forwarding if not authenticated
  if (auth.mode === 'none') {
    clientRes.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify({
      error: 'Service Unavailable',
      message: 'No auth credentials configured. Use Dashboard to login.',
    }));
    return;
  }

  // Collect request body
  const bodyChunks = [];
  clientReq.on('data', chunk => bodyChunks.push(chunk));
  clientReq.on('end', () => {
    const body = Buffer.concat(bodyChunks);

    // Build forwarded headers: keep original, inject auth, fix host
    const fwdHeaders = { ...clientReq.headers };
    delete fwdHeaders['host'];
    delete fwdHeaders['x-api-key'];
    delete fwdHeaders['authorization'];
    fwdHeaders[auth.headerName] = auth.headerValue;
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

    makeProxyRequest(options, body, clientRes, false);
  });

  clientReq.on('error', (err) => {
    console.error('Client request error:', err.message);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Claude API proxy listening on http://0.0.0.0:' + PORT);
  console.log('Forwarding to ' + TARGET_URL);
  console.log('Auth: ' + auth.mode + ' (' + auth.source + ') token=' + maskToken(auth.token));
  if (auth.filePath && refreshInterval > 0) {
    console.log('Token auto-refresh every ' + refreshInterval + 's');
  }
  console.log('Dashboard: http://localhost:' + PORT + '/');
  console.log('Rate limits: GET http://localhost:' + PORT + '/rate-limits');
  console.log('Auth status: GET http://localhost:' + PORT + '/auth-status');
});
