const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
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

// --- OAuth Constants (from Anthropic/Claude Code) ---
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_AUTH_URL = 'https://claude.ai/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const OAUTH_SCOPE = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const ANTHROPIC_BETA_HEADER = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,context-1m-2025-08-07,fast-mode-2026-02-01';
// Required beta flags for OAuth mode (must always be present)
const OAUTH_REQUIRED_BETAS = ['claude-code-20250219', 'oauth-2025-04-20'];

// --- Auth State ---
const auth = {
  mode: null,          // 'apikey' | 'oauth' | 'none'
  token: null,         // Current access token
  refreshToken: null,  // OAuth refresh token
  expiresAt: null,     // Token expiry timestamp (ms)
  source: null,        // 'env:ANTHROPIC_API_KEY' | 'env:ANTHROPIC_AUTH_TOKEN' | 'file:<path>' | 'oauth'
  headerName: null,    // 'x-api-key' | 'authorization'
  headerValue: null,   // The full header value
  filePath: null,      // If reading from file
  lastReadAt: null,
  lastError: null,
};

// --- OAuth Session (for PKCE flow) ---
const oauthSession = {
  state: null,
  codeVerifier: null,
  createdAt: null,
};

// --- Token persistence path ---
const TOKEN_FILE = path.join(__dirname, '.oauth-token.json');

function resolveHomePath(p) {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

function readTokenFromFile(filePath) {
  try {
    var content = fs.readFileSync(filePath, 'utf-8');
    var settings = JSON.parse(content);
    var token = settings && settings.env && settings.env.ANTHROPIC_AUTH_TOKEN;
    if (!token) return { token: null, error: 'ANTHROPIC_AUTH_TOKEN not found in ' + filePath };
    return { token, error: null };
  } catch (err) {
    return { token: null, error: 'Failed to read ' + filePath + ': ' + err.message };
  }
}

function loadOAuthToken() {
  try {
    var content = fs.readFileSync(TOKEN_FILE, 'utf-8');
    var data = JSON.parse(content);
    if (data.access_token) {
      auth.mode = 'oauth';
      auth.token = data.access_token;
      auth.refreshToken = data.refresh_token || null;
      auth.expiresAt = data.expires_at || null;
      auth.source = 'oauth';
      auth.headerName = 'authorization';
      auth.headerValue = 'Bearer ' + data.access_token;
      auth.lastReadAt = new Date().toISOString();
      auth.lastError = null;
      console.log('[auth] OAuth token loaded from ' + TOKEN_FILE);
      return true;
    }
  } catch (e) { /* file doesn't exist */ }
  return false;
}

function saveOAuthToken(data) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), 'utf-8');
    console.log('[auth] OAuth token saved to ' + TOKEN_FILE);
  } catch (e) {
    console.error('[auth] Failed to save token: ' + e.message);
  }
}

function refreshAuth() {
  if (auth.filePath) {
    var result = readTokenFromFile(auth.filePath);
    if (!result.error) {
      auth.token = result.token;
      auth.headerValue = auth.headerName === 'x-api-key' ? result.token : 'Bearer ' + result.token;
      auth.lastReadAt = new Date().toISOString();
      auth.lastError = null;
      return true;
    }
    auth.lastError = result.error;
    return false;
  }
  return false;
}

function maskToken(token) {
  if (!token) return '****';
  if (token.length > 8) return token.slice(0, 4) + '...' + token.slice(-4);
  return '****';
}

// --- PKCE helpers ---
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// --- HTTPS request helper (zero-dependency) ---
function httpsRequest(urlStr, options, postData) {
  return new Promise(function(resolve, reject) {
    var url = new URL(urlStr);
    var opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || 'POST',
      headers: options.headers || {},
    };
    var req = https.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var body = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: body });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// --- OAuth Flow Reverse Proxy (proxies claude.ai login pages through server) ---
function oauthFlowProxy(clientReq, clientRes) {
  var targetPath = clientReq.url.slice('/oauth-flow'.length) || '/';

  var bodyChunks = [];
  clientReq.on('data', function(c) { bodyChunks.push(c); });
  clientReq.on('end', function() {
    var body = Buffer.concat(bodyChunks);

    // Build headers for upstream claude.ai
    var headers = {};
    for (var key in clientReq.headers) {
      if (key === 'host' || key === 'accept-encoding') continue;
      headers[key] = clientReq.headers[key];
    }
    headers['host'] = 'claude.ai';
    headers['accept-encoding'] = 'identity'; // Disable compression for URL rewriting

    // Rewrite referer/origin to look like claude.ai
    if (headers['referer']) {
      headers['referer'] = headers['referer'].replace(/http:\/\/[^\/]+\/oauth-flow/g, 'https://claude.ai');
    }
    if (headers['origin']) {
      headers['origin'] = 'https://claude.ai';
    }

    if (body.length > 0) {
      headers['content-length'] = String(body.length);
    }

    var opts = {
      hostname: 'claude.ai',
      port: 443,
      path: targetPath,
      method: clientReq.method,
      headers: headers,
    };

    var proxyReq = https.request(opts, function(proxyRes) {
      var resHeaders = {};
      for (var key in proxyRes.headers) {
        resHeaders[key] = proxyRes.headers[key];
      }

      // Rewrite Location headers (redirects)
      if (resHeaders['location']) {
        var loc = resHeaders['location'];
        if (loc.startsWith(OAUTH_REDIRECT_URI)) {
          // OAuth callback! Auto-intercept and exchange code
          var cbUrl = new URL(loc);
          var code = cbUrl.searchParams.get('code') || '';
          var state = cbUrl.searchParams.get('state') || '';
          resHeaders['location'] = '/auth-oauth-auto-callback?code=' + encodeURIComponent(code) + '&state=' + encodeURIComponent(state);
        } else if (loc.startsWith('https://claude.ai/')) {
          resHeaders['location'] = '/oauth-flow/' + loc.slice('https://claude.ai/'.length);
        } else if (loc.startsWith('https://claude.ai')) {
          resHeaders['location'] = '/oauth-flow' + loc.slice('https://claude.ai'.length);
        } else if (loc.startsWith('/')) {
          resHeaders['location'] = '/oauth-flow' + loc;
        }
        // External redirects (Google SSO etc.) pass through as-is
      }

      // Rewrite Set-Cookie: remove domain restriction, Secure flag, adjust SameSite
      if (resHeaders['set-cookie']) {
        var cookies = Array.isArray(resHeaders['set-cookie']) ? resHeaders['set-cookie'] : [resHeaders['set-cookie']];
        resHeaders['set-cookie'] = cookies.map(function(c) {
          return c
            .replace(/;\s*[Dd]omain=[^;]*/g, '')
            .replace(/;\s*[Ss]ecure/g, '')
            .replace(/;\s*[Ss]ame[Ss]ite=[^;]*/g, '; SameSite=Lax');
        });
      }

      // Strip security headers that block proxied content
      delete resHeaders['content-security-policy'];
      delete resHeaders['content-security-policy-report-only'];
      delete resHeaders['strict-transport-security'];
      delete resHeaders['x-frame-options'];

      // For text content, rewrite absolute claude.ai URLs
      var ct = (resHeaders['content-type'] || '').toLowerCase();
      if (ct.includes('text/html') || ct.includes('javascript') || ct.includes('application/json')) {
        delete resHeaders['content-length'];
        var chunks = [];
        proxyRes.on('data', function(c) { chunks.push(c); });
        proxyRes.on('end', function() {
          var text = Buffer.concat(chunks).toString('utf-8');
          text = text.replace(/https:\/\/claude\.ai\//g, '/oauth-flow/');
          text = text.replace(/https:\/\/claude\.ai(?=["'\s<\)])/g, '/oauth-flow');
          clientRes.writeHead(proxyRes.statusCode, resHeaders);
          clientRes.end(text);
        });
      } else {
        // Binary/other: pass through
        clientRes.writeHead(proxyRes.statusCode, resHeaders);
        proxyRes.pipe(clientRes);
      }
    });

    proxyReq.on('error', function(err) {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'OAuth proxy error', message: err.message }));
      }
    });

    if (body.length > 0) proxyReq.write(body);
    proxyReq.end();
  });
}

// Shared function: exchange authorization code for token and save
function exchangeCodeForToken(code) {
  var postData = JSON.stringify({
    grant_type: 'authorization_code',
    code: code,
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    code_verifier: oauthSession.codeVerifier,
  });
  return httpsRequest(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(postData)),
    },
  }, postData).then(function(res) {
    if (res.status === 200 && res.body.access_token) {
      var data = res.body;
      auth.mode = 'oauth';
      auth.token = data.access_token;
      auth.refreshToken = data.refresh_token || null;
      auth.expiresAt = data.expires_at ? data.expires_at * 1000 : (Date.now() + (data.expires_in || 3600) * 1000);
      auth.source = 'oauth';
      auth.headerName = 'authorization';
      auth.headerValue = 'Bearer ' + data.access_token;
      auth.lastReadAt = new Date().toISOString();
      auth.lastError = null;
      saveOAuthToken({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: auth.expiresAt,
      });
      oauthSession.state = null;
      oauthSession.codeVerifier = null;
      console.log('[oauth] Login successful! Token: ' + maskToken(auth.token));
      return { ok: true, token: maskToken(auth.token), expiresAt: new Date(auth.expiresAt).toISOString() };
    }
    console.error('[oauth] Token exchange failed:', JSON.stringify(res.body));
    return {
      ok: false,
      error: (res.body && res.body.error_description) || (res.body && res.body.error) || 'Token exchange failed',
      detail: res.body,
    };
  });
}

// --- OAuth Token Refresh ---
function refreshOAuthToken() {
  if (!auth.refreshToken) return Promise.resolve(false);
  console.log('[auth] Refreshing OAuth token...');
  var postData = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  return httpsRequest(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(postData) },
  }, postData).then(function(res) {
    if (res.status === 200 && res.body.access_token) {
      var data = res.body;
      auth.token = data.access_token;
      auth.refreshToken = data.refresh_token || auth.refreshToken;
      auth.expiresAt = data.expires_at ? data.expires_at * 1000 : (Date.now() + (data.expires_in || 3600) * 1000);
      auth.headerValue = 'Bearer ' + data.access_token;
      auth.lastReadAt = new Date().toISOString();
      auth.lastError = null;
      saveOAuthToken({
        access_token: auth.token,
        refresh_token: auth.refreshToken,
        expires_at: auth.expiresAt,
      });
      console.log('[auth] OAuth token refreshed: ' + maskToken(auth.token));
      return true;
    }
    console.error('[auth] Token refresh failed: ' + JSON.stringify(res.body));
    return false;
  }).catch(function(err) {
    console.error('[auth] Token refresh error: ' + err.message);
    return false;
  });
}

// --- Auth Initialization ---
var envApiKey = process.env.ANTHROPIC_API_KEY;
var envAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
var envCredFile = process.env.CLAUDE_CREDENTIALS_FILE;
var envHeaderName = process.env.AUTH_HEADER_NAME;
var refreshInterval = parseInt(process.env.TOKEN_REFRESH_INTERVAL || '0', 10);

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
} else if (loadOAuthToken()) {
  // Loaded from .oauth-token.json
} else {
  var credPath = resolveHomePath(envCredFile || '~/.claude/settings.json');
  var credResult = readTokenFromFile(credPath);
  if (!credResult.error) {
    auth.mode = 'oauth';
    auth.token = credResult.token;
    auth.source = 'file:' + credPath;
    auth.filePath = credPath;
    auth.headerName = (envHeaderName || 'authorization').toLowerCase();
    auth.headerValue = auth.headerName === 'x-api-key' ? credResult.token : 'Bearer ' + credResult.token;
    auth.lastReadAt = new Date().toISOString();
  } else {
    console.warn('Warning: No auth credentials found. Use Dashboard to login.');
    auth.mode = 'none';
    auth.source = 'none';
    auth.headerName = 'authorization';
    auth.lastError = credResult.error;
  }
}

// Periodic token refresh
if (refreshInterval > 0) {
  setInterval(function() {
    if (auth.refreshToken) refreshOAuthToken();
    else if (auth.filePath) refreshAuth();
  }, refreshInterval * 1000);
}

var PORT = parseInt(process.env.PORT || '3456', 10);
var TARGET_URL = process.env.TARGET_URL || 'https://api.anthropic.com';
var target = new URL(TARGET_URL);

// Cache for rate limit info
var rateLimits = { updatedAt: null, headers: {} };
var RATELIMIT_PREFIXES = ['anthropic-ratelimit-', 'retry-after'];

function extractRateLimits(headers) {
  var extracted = {};
  for (var key in headers) {
    if (RATELIMIT_PREFIXES.some(function(p) { return key.startsWith(p); })) {
      extracted[key] = headers[key];
    }
  }
  if (Object.keys(extracted).length > 0) {
    rateLimits.headers = extracted;
    rateLimits.updatedAt = new Date().toISOString();
  }
}

// Proxy request with 401 retry
function makeProxyRequest(options, body, clientRes, isRetry) {
  var proxyReq = https.request(options, function(proxyRes) {
    extractRateLimits(proxyRes.headers);

    if (proxyRes.statusCode === 401 && !isRetry) {
      proxyRes.resume();
      console.log('[auth] Got 401, attempting token refresh...');
      var refreshPromise = auth.refreshToken ? refreshOAuthToken() :
        (auth.filePath ? Promise.resolve(refreshAuth()) : Promise.resolve(false));
      refreshPromise.then(function(ok) {
        if (ok) {
          options.headers[auth.headerName] = auth.headerValue;
          makeProxyRequest(options, body, clientRes, true);
        } else {
          if (!clientRes.headersSent) {
            clientRes.writeHead(401, { 'content-type': 'application/json' });
            clientRes.end(JSON.stringify({
              error: 'Unauthorized',
              message: 'Token refresh failed. Use Dashboard to re-login.',
            }));
          }
        }
      });
      return;
    }

    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on('error', function(err) {
    console.error('Upstream error:', err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
    }
  });

  if (body.length > 0) proxyReq.write(body);
  proxyReq.end();
}

// --- HTTP Server ---
var server = http.createServer(function(clientReq, clientRes) {
  // Dashboard
  if (clientReq.method === 'GET' && (clientReq.url === '/' || clientReq.url === '/dashboard')) {
    var html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf-8');
    clientRes.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    clientRes.end(html);
    return;
  }

  // Rate limits
  if (clientReq.method === 'GET' && clientReq.url === '/rate-limits') {
    clientRes.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify(rateLimits, null, 2));
    return;
  }

  // Auth status
  if (clientReq.method === 'GET' && clientReq.url === '/auth-status') {
    clientRes.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify({
      mode: auth.mode,
      source: auth.source,
      headerName: auth.headerName,
      tokenMasked: maskToken(auth.token),
      hasRefreshToken: !!auth.refreshToken,
      expiresAt: auth.expiresAt ? new Date(auth.expiresAt).toISOString() : null,
      lastReadAt: auth.lastReadAt,
      lastError: auth.lastError,
    }, null, 2));
    return;
  }

  // OAuth Step 1: Generate authorization URL
  if (clientReq.method === 'POST' && clientReq.url === '/auth-oauth-start') {
    var codeVerifier = generateCodeVerifier();
    var codeChallenge = generateCodeChallenge(codeVerifier);
    var state = generateState();

    oauthSession.state = state;
    oauthSession.codeVerifier = codeVerifier;
    oauthSession.createdAt = Date.now();

    var params = new URLSearchParams({
      response_type: 'code',
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPE,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    var authUrl = OAUTH_AUTH_URL + '?' + params.toString();

    console.log('[oauth] Auth URL generated, state=' + state);
    clientRes.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify({ ok: true, authUrl: authUrl }));
    return;
  }

  // OAuth Step 2: Exchange authorization code for token (manual paste fallback)
  if (clientReq.method === 'POST' && clientReq.url === '/auth-oauth-callback') {
    var chunks = [];
    clientReq.on('data', function(c) { chunks.push(c); });
    clientReq.on('end', function() {
      try {
        var body = JSON.parse(Buffer.concat(chunks).toString());
        var code = body.code;
        if (!code) {
          clientRes.writeHead(400, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({ ok: false, error: 'Missing code parameter' }));
          return;
        }
        if (!oauthSession.codeVerifier) {
          clientRes.writeHead(400, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({ ok: false, error: 'No OAuth session. Click Login first.' }));
          return;
        }
        exchangeCodeForToken(code).then(function(result) {
          clientRes.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify(result));
        }).catch(function(err) {
          clientRes.writeHead(500, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({ ok: false, error: err.message }));
        });
      } catch (e) {
        clientRes.writeHead(400, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({ ok: false, error: 'Invalid request body' }));
      }
    });
    return;
  }

  // Refresh token manually
  if (clientReq.method === 'POST' && clientReq.url === '/auth-refresh') {
    var p = auth.refreshToken ? refreshOAuthToken() :
      (auth.filePath ? Promise.resolve(refreshAuth()) : Promise.resolve(false));
    p.then(function(ok) {
      clientRes.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      clientRes.end(JSON.stringify({ ok: ok, token: maskToken(auth.token), error: auth.lastError }));
    });
    return;
  }

  // OAuth login entry: generate PKCE and redirect to proxied claude.ai auth page
  if (clientReq.method === 'GET' && clientReq.url === '/oauth-login') {
    var cv = generateCodeVerifier();
    var cc = generateCodeChallenge(cv);
    var st = generateState();
    oauthSession.state = st;
    oauthSession.codeVerifier = cv;
    oauthSession.createdAt = Date.now();

    var params = new URLSearchParams({
      response_type: 'code',
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPE,
      state: st,
      code_challenge: cc,
      code_challenge_method: 'S256',
    });

    console.log('[oauth] Starting proxied OAuth flow, state=' + st);
    clientRes.writeHead(302, { 'location': '/oauth-flow/oauth/authorize?' + params.toString() });
    clientRes.end();
    return;
  }

  // OAuth flow reverse proxy (proxy claude.ai login pages through server)
  if (clientReq.url.startsWith('/oauth-flow/') || clientReq.url === '/oauth-flow') {
    oauthFlowProxy(clientReq, clientRes);
    return;
  }

  // Auto-callback: intercept OAuth redirect, exchange code, redirect to dashboard
  if (clientReq.method === 'GET' && clientReq.url.startsWith('/auth-oauth-auto-callback')) {
    var cbParams = new URL('http://localhost' + clientReq.url);
    var autoCode = cbParams.searchParams.get('code');
    if (!autoCode || !oauthSession.codeVerifier) {
      clientRes.writeHead(302, { 'location': '/?login=error&msg=missing_code_or_session' });
      clientRes.end();
      return;
    }
    console.log('[oauth] Auto-exchanging code for token...');
    exchangeCodeForToken(autoCode).then(function(result) {
      if (result.ok) {
        clientRes.writeHead(302, { 'location': '/?login=success' });
      } else {
        clientRes.writeHead(302, { 'location': '/?login=error&msg=' + encodeURIComponent(result.error) });
      }
      clientRes.end();
    }).catch(function(err) {
      clientRes.writeHead(302, { 'location': '/?login=error&msg=' + encodeURIComponent(err.message) });
      clientRes.end();
    });
    return;
  }

  // Block if not authenticated
  if (auth.mode === 'none') {
    clientRes.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify({
      error: 'Service Unavailable',
      message: 'No auth credentials. Use Dashboard to login.',
    }));
    return;
  }

  // --- API Proxy ---
  var bodyChunks = [];
  clientReq.on('data', function(chunk) { bodyChunks.push(chunk); });
  clientReq.on('end', function() {
    var body = Buffer.concat(bodyChunks);

    // Check if token needs refresh before forwarding
    var needsRefresh = auth.refreshToken && auth.expiresAt && (Date.now() > auth.expiresAt - 180000);
    var preRefresh = needsRefresh ? refreshOAuthToken() : Promise.resolve(true);

    preRefresh.then(function() {
      var fwdHeaders = {};
      // Copy original headers
      for (var key in clientReq.headers) {
        if (key !== 'host' && key !== 'x-api-key' && key !== 'authorization') {
          fwdHeaders[key] = clientReq.headers[key];
        }
      }
      // Inject auth
      fwdHeaders[auth.headerName] = auth.headerValue;
      fwdHeaders['host'] = target.host;
      // Inject/merge anthropic-beta header for OAuth mode
      if (auth.mode === 'oauth') {
        if (!fwdHeaders['anthropic-beta']) {
          fwdHeaders['anthropic-beta'] = ANTHROPIC_BETA_HEADER;
        } else {
          // Client sent its own beta header; ensure OAuth-required betas are present
          var existing = fwdHeaders['anthropic-beta'].split(',').map(function(s){return s.trim();});
          OAUTH_REQUIRED_BETAS.forEach(function(b) {
            if (existing.indexOf(b) === -1) existing.push(b);
          });
          fwdHeaders['anthropic-beta'] = existing.join(',');
        }
      }

      if (body.length > 0) {
        fwdHeaders['content-length'] = String(body.length);
      } else {
        delete fwdHeaders['content-length'];
      }
      delete fwdHeaders['transfer-encoding'];

      var options = {
        hostname: target.hostname,
        port: target.port || 443,
        path: clientReq.url,
        method: clientReq.method,
        headers: fwdHeaders,
      };

      makeProxyRequest(options, body, clientRes, false);
    });
  });

  clientReq.on('error', function(err) {
    console.error('Client request error:', err.message);
  });
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('Claude API proxy listening on http://0.0.0.0:' + PORT);
  console.log('Forwarding to ' + TARGET_URL);
  console.log('Auth: ' + auth.mode + ' (' + auth.source + ') token=' + maskToken(auth.token));
  console.log('Dashboard: http://localhost:' + PORT + '/');
});
