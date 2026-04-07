#!/usr/bin/env python3
"""Claude API Proxy - aiohttp + curl_cffi implementation.

Transparent proxy for Claude API. Supports API Key and OAuth token modes.
Uses curl_cffi to bypass Cloudflare TLS fingerprinting for claude.ai OAuth.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import aiohttp
from aiohttp import web
from curl_cffi import requests as cffi_requests

# ---------------------------------------------------------------------------
# .env loader
# ---------------------------------------------------------------------------

def load_dotenv():
    env_path = Path(__file__).parent / '.env'
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        idx = line.find('=')
        if idx == -1:
            continue
        key = line[:idx].strip()
        value = line[idx + 1:].strip()
        if key not in os.environ:
            os.environ[key] = value

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
OAUTH_AUTH_URL = 'https://claude.ai/oauth/authorize'
OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
OAUTH_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'
OAUTH_SCOPE = (
    'user:profile user:inference user:sessions:claude_code '
    'user:mcp_servers user:file_upload'
)
ANTHROPIC_BETA_HEADER = (
    'claude-code-20250219,oauth-2025-04-20,'
    'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,'
    'context-1m-2025-08-07,fast-mode-2026-02-01'
)
OAUTH_REQUIRED_BETAS = ['claude-code-20250219', 'oauth-2025-04-20']

BROWSER_HEADERS = {
    'accept': 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'content-type': 'application/json',
    'origin': 'https://claude.ai',
    'referer': 'https://claude.ai/',
    'sec-ch-ua': '"Chromium";v="146", "Google Chrome";v="146", "Not?A_Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
}

CHROME_IMPERSONATE = 'chrome131'

PORT = int(os.environ.get('PORT', '3456'))
TARGET_URL = os.environ.get('TARGET_URL', 'https://api.anthropic.com')
TOKEN_FILE = Path(__file__).parent / '.oauth-token.json'
DASHBOARD_FILE = Path(__file__).parent / 'dashboard.html'

RATELIMIT_PREFIXES = ('anthropic-ratelimit-', 'retry-after')
# Headers to strip when proxying the upstream response back to the client
PROXY_RESP_SKIP_HEADERS = frozenset(
    {'transfer-encoding', 'connection', 'keep-alive'}
)
# Headers to strip from the incoming client request before forwarding
PROXY_REQ_SKIP_HEADERS = frozenset(
    {'host', 'x-api-key', 'authorization', 'transfer-encoding'}
)

# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _now_ms():
    return int(time.time() * 1000)


def resolve_home_path(p: str) -> Path:
    if p.startswith('~/') or p.startswith('~\\'):
        return Path.home() / p[2:]
    if p == '~':
        return Path.home()
    return Path(p).resolve()


def mask_token(token: str | None) -> str:
    if not token:
        return '****'
    if len(token) > 8:
        return token[:4] + '...' + token[-4:]
    return '****'

# ---------------------------------------------------------------------------
# PKCE helpers
# ---------------------------------------------------------------------------

def generate_code_verifier() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b'=').decode()


def generate_code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b'=').decode()


def generate_state() -> str:
    return secrets.token_hex(16)

# ---------------------------------------------------------------------------
# Auth state
# ---------------------------------------------------------------------------

class AuthState:
    def __init__(self):
        self.mode: str | None = None          # 'apikey' | 'oauth' | 'none'
        self.token: str | None = None
        self.refresh_token: str | None = None
        self.expires_at: int | None = None    # ms timestamp
        self.source: str | None = None
        self.header_name: str | None = None
        self.header_value: str | None = None
        self.file_path: str | None = None
        self.last_read_at: str | None = None
        self.last_error: str | None = None
        self._refresh_lock = asyncio.Lock()


auth = AuthState()


class OAuthSession:
    def __init__(self):
        self.state: str | None = None
        self.code_verifier: str | None = None
        self.created_at: int | None = None


oauth_session = OAuthSession()

# Rate limits cache
rate_limits: dict = {'updatedAt': None, 'headers': {}}

# ---------------------------------------------------------------------------
# Token persistence
# ---------------------------------------------------------------------------

def load_oauth_token() -> bool:
    try:
        data = json.loads(TOKEN_FILE.read_text(encoding='utf-8'))
        if data.get('access_token'):
            auth.mode = 'oauth'
            auth.token = data['access_token']
            auth.refresh_token = data.get('refresh_token')
            auth.expires_at = data.get('expires_at')
            auth.source = 'oauth'
            auth.header_name = 'authorization'
            auth.header_value = f'Bearer {data["access_token"]}'
            auth.last_read_at = _now_iso()
            auth.last_error = None
            print(f'[auth] OAuth token loaded from {TOKEN_FILE}')
            return True
    except Exception:
        pass
    return False


def save_oauth_token(data: dict):
    try:
        TOKEN_FILE.write_text(json.dumps(data, indent=2), encoding='utf-8')
        print(f'[auth] OAuth token saved to {TOKEN_FILE}')
    except Exception as e:
        print(f'[auth] Failed to save token: {e}', file=sys.stderr)

# ---------------------------------------------------------------------------
# Token from settings file
# ---------------------------------------------------------------------------

def read_token_from_file(file_path) -> tuple[str | None, str | None]:
    try:
        content = Path(file_path).read_text(encoding='utf-8')
        settings = json.loads(content)
        token = settings.get('env', {}).get('ANTHROPIC_AUTH_TOKEN')
        if not token:
            return None, f'ANTHROPIC_AUTH_TOKEN not found in {file_path}'
        return token, None
    except Exception as e:
        return None, f'Failed to read {file_path}: {e}'


def refresh_auth_from_file() -> bool:
    if not auth.file_path:
        return False
    token, error = read_token_from_file(auth.file_path)
    if error:
        auth.last_error = error
        return False
    auth.token = token
    if auth.header_name == 'x-api-key':
        auth.header_value = token
    else:
        auth.header_value = f'Bearer {token}'
    auth.last_read_at = _now_iso()
    auth.last_error = None
    return True

# ---------------------------------------------------------------------------
# curl_cffi helpers (claude.ai requests, bypass Cloudflare TLS)
# ---------------------------------------------------------------------------

def _sync_claude_ai_request(method, url_path, session_key, body=None):
    url = f'https://claude.ai{url_path}'
    data = body.encode('utf-8') if isinstance(body, str) else body
    resp = cffi_requests.request(
        method, url,
        headers=BROWSER_HEADERS,
        cookies={'sessionKey': session_key},
        data=data,
        impersonate=CHROME_IMPERSONATE,
        timeout=30,
    )
    return resp.status_code, resp.text


async def claude_ai_request(method, url_path, session_key, body=None):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None, _sync_claude_ai_request, method, url_path, session_key, body,
    )

# ---------------------------------------------------------------------------
# OAuth functions
# ---------------------------------------------------------------------------

async def get_organization_uuid(session_key: str) -> str:
    print('[oauth] Step 1: Getting organization UUID...')
    status, text = await claude_ai_request('GET', '/api/organizations', session_key)
    if status != 200:
        raise Exception(f'Get organizations failed: HTTP {status} - {text[:200]}')
    orgs = json.loads(text)
    if not isinstance(orgs, list) or len(orgs) == 0:
        raise Exception('No organizations found')
    org = next((o for o in orgs if o.get('raven_type') == 'team'), orgs[0])
    print(f'[oauth] Step 1 OK: org={org.get("name")} uuid={org["uuid"]}')
    return org['uuid']


async def get_authorization_code(session_key: str, org_uuid: str) -> str:
    verifier = generate_code_verifier()
    challenge = generate_code_challenge(verifier)
    state = generate_state()

    oauth_session.state = state
    oauth_session.code_verifier = verifier
    oauth_session.created_at = _now_ms()

    post_body = json.dumps({
        'response_type': 'code',
        'client_id': OAUTH_CLIENT_ID,
        'organization_uuid': org_uuid,
        'redirect_uri': OAUTH_REDIRECT_URI,
        'scope': OAUTH_SCOPE,
        'state': state,
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
    })

    print('[oauth] Step 2: Getting authorization code...')
    status, text = await claude_ai_request(
        'POST', f'/v1/oauth/{org_uuid}/authorize', session_key, post_body,
    )
    if status != 200:
        raise Exception(f'Get auth code failed: HTTP {status} - {text[:200]}')
    result = json.loads(text)
    redirect_uri = result.get('redirect_uri')
    if not redirect_uri:
        raise Exception(f'No redirect_uri in response: {json.dumps(result)[:200]}')
    parsed = urlparse(redirect_uri)
    code = parse_qs(parsed.query).get('code', [None])[0]
    if not code:
        raise Exception('No code in redirect_uri')
    print('[oauth] Step 2 OK: got authorization code')
    return code


async def exchange_code_for_token(code: str, client_session: aiohttp.ClientSession) -> dict:
    post_data = {
        'grant_type': 'authorization_code',
        'code': code,
        'client_id': OAUTH_CLIENT_ID,
        'redirect_uri': OAUTH_REDIRECT_URI,
        'code_verifier': oauth_session.code_verifier,
    }
    async with client_session.post(OAUTH_TOKEN_URL, json=post_data) as resp:
        body = await resp.json()
        if resp.status == 200 and body.get('access_token'):
            auth.mode = 'oauth'
            auth.token = body['access_token']
            auth.refresh_token = body.get('refresh_token')
            if body.get('expires_at'):
                auth.expires_at = body['expires_at'] * 1000
            else:
                auth.expires_at = _now_ms() + body.get('expires_in', 3600) * 1000
            auth.source = 'oauth'
            auth.header_name = 'authorization'
            auth.header_value = f'Bearer {body["access_token"]}'
            auth.last_read_at = _now_iso()
            auth.last_error = None
            save_oauth_token({
                'access_token': body['access_token'],
                'refresh_token': body.get('refresh_token'),
                'expires_at': auth.expires_at,
            })
            oauth_session.state = None
            oauth_session.code_verifier = None
            print(f'[oauth] Login successful! Token: {mask_token(auth.token)}')
            return {
                'ok': True,
                'token': mask_token(auth.token),
                'expiresAt': (
                    datetime.fromtimestamp(auth.expires_at / 1000, timezone.utc).isoformat()
                    if auth.expires_at else None
                ),
            }
        print(f'[oauth] Token exchange failed: {json.dumps(body)}', file=sys.stderr)
        return {
            'ok': False,
            'error': body.get('error_description') or body.get('error') or 'Token exchange failed',
            'detail': body,
        }


async def refresh_oauth_token(client_session: aiohttp.ClientSession) -> bool:
    if not auth.refresh_token:
        return False
    async with auth._refresh_lock:
        print('[auth] Refreshing OAuth token...')
        post_data = {
            'grant_type': 'refresh_token',
            'refresh_token': auth.refresh_token,
            'client_id': OAUTH_CLIENT_ID,
        }
        try:
            async with client_session.post(OAUTH_TOKEN_URL, json=post_data) as resp:
                body = await resp.json()
                if resp.status == 200 and body.get('access_token'):
                    auth.token = body['access_token']
                    auth.refresh_token = body.get('refresh_token', auth.refresh_token)
                    if body.get('expires_at'):
                        auth.expires_at = body['expires_at'] * 1000
                    else:
                        auth.expires_at = _now_ms() + body.get('expires_in', 3600) * 1000
                    auth.header_value = f'Bearer {body["access_token"]}'
                    auth.last_read_at = _now_iso()
                    auth.last_error = None
                    save_oauth_token({
                        'access_token': auth.token,
                        'refresh_token': auth.refresh_token,
                        'expires_at': auth.expires_at,
                    })
                    print(f'[auth] OAuth token refreshed: {mask_token(auth.token)}')
                    return True
                print(f'[auth] Token refresh failed: {json.dumps(body)}', file=sys.stderr)
                return False
        except Exception as e:
            print(f'[auth] Token refresh error: {e}', file=sys.stderr)
            return False


async def try_refresh_token(client_session: aiohttp.ClientSession) -> bool:
    if auth.refresh_token:
        return await refresh_oauth_token(client_session)
    if auth.file_path:
        return refresh_auth_from_file()
    return False

# ---------------------------------------------------------------------------
# Rate limits
# ---------------------------------------------------------------------------

def extract_rate_limits(headers):
    extracted = {}
    for key, value in headers.items():
        k = key.lower()
        if any(k.startswith(p) for p in RATELIMIT_PREFIXES):
            extracted[k] = value
    if extracted:
        rate_limits['headers'] = extracted
        rate_limits['updatedAt'] = _now_iso()

# ---------------------------------------------------------------------------
# Auth initialization
# ---------------------------------------------------------------------------

def init_auth():
    env_api_key = os.environ.get('ANTHROPIC_API_KEY')
    env_auth_token = os.environ.get('ANTHROPIC_AUTH_TOKEN')
    env_cred_file = os.environ.get('CLAUDE_CREDENTIALS_FILE')
    env_header_name = os.environ.get('AUTH_HEADER_NAME')

    if env_api_key:
        auth.mode = 'apikey'
        auth.token = env_api_key
        auth.source = 'env:ANTHROPIC_API_KEY'
        auth.header_name = (env_header_name or 'x-api-key').lower()
        auth.header_value = env_api_key
    elif env_auth_token:
        auth.mode = 'oauth'
        auth.token = env_auth_token
        auth.source = 'env:ANTHROPIC_AUTH_TOKEN'
        auth.header_name = (env_header_name or 'authorization').lower()
        if auth.header_name == 'x-api-key':
            auth.header_value = env_auth_token
        else:
            auth.header_value = f'Bearer {env_auth_token}'
    elif load_oauth_token():
        pass
    else:
        cred_path = resolve_home_path(env_cred_file or '~/.claude/settings.json')
        token, error = read_token_from_file(cred_path)
        if not error:
            auth.mode = 'oauth'
            auth.token = token
            auth.source = f'file:{cred_path}'
            auth.file_path = str(cred_path)
            auth.header_name = (env_header_name or 'authorization').lower()
            if auth.header_name == 'x-api-key':
                auth.header_value = token
            else:
                auth.header_value = f'Bearer {token}'
            auth.last_read_at = _now_iso()
        else:
            print('Warning: No auth credentials found. Use Dashboard to login.')
            auth.mode = 'none'
            auth.source = 'none'
            auth.header_name = 'authorization'
            auth.last_error = error

# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------

async def handle_dashboard(request: web.Request) -> web.Response:
    html = DASHBOARD_FILE.read_text(encoding='utf-8')
    return web.Response(text=html, content_type='text/html', charset='utf-8')


async def handle_rate_limits(request: web.Request) -> web.Response:
    return web.json_response(rate_limits)


async def handle_auth_status(request: web.Request) -> web.Response:
    return web.json_response({
        'mode': auth.mode,
        'source': auth.source,
        'headerName': auth.header_name,
        'tokenMasked': mask_token(auth.token),
        'hasRefreshToken': bool(auth.refresh_token),
        'expiresAt': (
            datetime.fromtimestamp(auth.expires_at / 1000, timezone.utc).isoformat()
            if auth.expires_at else None
        ),
        'lastReadAt': auth.last_read_at,
        'lastError': auth.last_error,
    })


async def handle_oauth_start(request: web.Request) -> web.Response:
    verifier = generate_code_verifier()
    challenge = generate_code_challenge(verifier)
    state = generate_state()

    oauth_session.state = state
    oauth_session.code_verifier = verifier
    oauth_session.created_at = _now_ms()

    params = urlencode({
        'response_type': 'code',
        'client_id': OAUTH_CLIENT_ID,
        'redirect_uri': OAUTH_REDIRECT_URI,
        'scope': OAUTH_SCOPE,
        'state': state,
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
    })
    auth_url = f'{OAUTH_AUTH_URL}?{params}'
    print(f'[oauth] Auth URL generated, state={state}')
    return web.json_response({'ok': True, 'authUrl': auth_url})


async def handle_oauth_callback(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({'ok': False, 'error': 'Invalid request body'}, status=400)
    code = body.get('code')
    if not code:
        return web.json_response({'ok': False, 'error': 'Missing code parameter'}, status=400)
    if not oauth_session.code_verifier:
        return web.json_response({'ok': False, 'error': 'No OAuth session. Click Login first.'}, status=400)
    try:
        result = await exchange_code_for_token(code, request.app['client_session'])
        return web.json_response(result, status=200 if result['ok'] else 400)
    except Exception as e:
        return web.json_response({'ok': False, 'error': str(e)}, status=500)


async def handle_auth_refresh(request: web.Request) -> web.Response:
    ok = await try_refresh_token(request.app['client_session'])
    return web.json_response({
        'ok': ok, 'token': mask_token(auth.token), 'error': auth.last_error,
    })


async def handle_session_login(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({'ok': False, 'error': 'Invalid request body'}, status=400)
    session_key = body.get('sessionKey')
    if not session_key:
        return web.json_response({'ok': False, 'error': 'Missing sessionKey'}, status=400)
    try:
        print('[oauth] SessionKey login started...')
        org_uuid = await get_organization_uuid(session_key)
        code = await get_authorization_code(session_key, org_uuid)
        print('[oauth] Step 3: Exchanging code for token...')
        result = await exchange_code_for_token(code, request.app['client_session'])
        return web.json_response(result, status=200 if result['ok'] else 400)
    except Exception as e:
        print(f'[oauth] SessionKey login failed: {e}', file=sys.stderr)
        return web.json_response({'ok': False, 'error': str(e)}, status=500)

# ---------------------------------------------------------------------------
# Proxy handler
# ---------------------------------------------------------------------------

async def handle_proxy(request: web.Request) -> web.StreamResponse:
    if auth.mode == 'none':
        return web.json_response(
            {'error': 'Service Unavailable', 'message': 'No auth credentials. Use Dashboard to login.'},
            status=503,
        )

    body = await request.read()
    client_session: aiohttp.ClientSession = request.app['client_session']

    # Pre-refresh if token is about to expire (within 3 min)
    if auth.refresh_token and auth.expires_at and (_now_ms() > auth.expires_at - 180_000):
        await refresh_oauth_token(client_session)

    async def _forward(is_retry: bool = False) -> web.StreamResponse:
        # Build forwarding headers
        fwd_headers: dict[str, str] = {}
        for key, value in request.headers.items():
            if key.lower() not in PROXY_REQ_SKIP_HEADERS:
                fwd_headers[key] = value

        fwd_headers[auth.header_name] = auth.header_value
        fwd_headers['host'] = urlparse(TARGET_URL).netloc

        # Inject / merge anthropic-beta for OAuth mode
        if auth.mode == 'oauth':
            existing_beta = fwd_headers.get('anthropic-beta', '')
            if not existing_beta:
                fwd_headers['anthropic-beta'] = ANTHROPIC_BETA_HEADER
            else:
                parts = [s.strip() for s in existing_beta.split(',')]
                for b in OAUTH_REQUIRED_BETAS:
                    if b not in parts:
                        parts.append(b)
                fwd_headers['anthropic-beta'] = ','.join(parts)

        if body:
            fwd_headers['content-length'] = str(len(body))

        target_url = f'{TARGET_URL}{request.path_qs}'

        try:
            upstream = await client_session.request(
                request.method, target_url,
                headers=fwd_headers,
                data=body if body else None,
                allow_redirects=False,
            )
        except Exception as e:
            print(f'Upstream error: {e}', file=sys.stderr)
            return web.json_response(
                {'error': 'Bad Gateway', 'message': str(e)}, status=502,
            )

        extract_rate_limits(upstream.headers)

        # 401 retry
        if upstream.status == 401 and not is_retry:
            await upstream.read()
            upstream.close()
            print('[auth] Got 401, attempting token refresh...')
            ok = await try_refresh_token(client_session)
            if ok:
                return await _forward(is_retry=True)
            return web.json_response(
                {'error': 'Unauthorized', 'message': 'Token refresh failed. Use Dashboard to re-login.'},
                status=401,
            )

        # Stream upstream response back to client
        resp = web.StreamResponse(status=upstream.status)
        for k, v in upstream.headers.items():
            if k.lower() not in PROXY_RESP_SKIP_HEADERS:
                resp.headers[k] = v
        await resp.prepare(request)

        async for chunk in upstream.content.iter_any():
            await resp.write(chunk)
        await resp.write_eof()
        upstream.close()
        return resp

    return await _forward()

# ---------------------------------------------------------------------------
# Periodic token refresh background task
# ---------------------------------------------------------------------------

async def periodic_refresh(app: web.Application):
    interval = int(os.environ.get('TOKEN_REFRESH_INTERVAL', '0'))
    if interval <= 0:
        return
    while True:
        await asyncio.sleep(interval)
        try:
            if auth.refresh_token:
                await refresh_oauth_token(app['client_session'])
            elif auth.file_path:
                refresh_auth_from_file()
        except Exception as e:
            print(f'[auth] Periodic refresh error: {e}', file=sys.stderr)

# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------

async def on_startup(app: web.Application):
    timeout = aiohttp.ClientTimeout(total=300)
    app['client_session'] = aiohttp.ClientSession(
        timeout=timeout,
        auto_decompress=False,  # transparent proxy: pass raw bytes
    )
    app['refresh_task'] = asyncio.create_task(periodic_refresh(app))


async def on_cleanup(app: web.Application):
    app['refresh_task'].cancel()
    try:
        await app['refresh_task']
    except asyncio.CancelledError:
        pass
    await app['client_session'].close()

# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

def create_app() -> web.Application:
    init_auth()

    app = web.Application()
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    # Specific routes first (take priority over catch-all)
    app.router.add_get('/', handle_dashboard)
    app.router.add_get('/dashboard', handle_dashboard)
    app.router.add_get('/rate-limits', handle_rate_limits)
    app.router.add_get('/auth-status', handle_auth_status)
    app.router.add_post('/auth-oauth-start', handle_oauth_start)
    app.router.add_post('/auth-oauth-callback', handle_oauth_callback)
    app.router.add_post('/auth-refresh', handle_auth_refresh)
    app.router.add_post('/auth-session-login', handle_session_login)

    # Catch-all: proxy everything else to upstream
    app.router.add_route('*', '/{path:.*}', handle_proxy)

    return app

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    app = create_app()
    print(f'Claude API proxy listening on http://0.0.0.0:{PORT}')
    print(f'Forwarding to {TARGET_URL}')
    print(f'Auth: {auth.mode} ({auth.source}) token={mask_token(auth.token)}')
    print(f'Dashboard: http://localhost:{PORT}/')
    print(f'Rate limits: GET http://localhost:{PORT}/rate-limits')
    print(f'Auth status: GET http://localhost:{PORT}/auth-status')
    web.run_app(app, host='0.0.0.0', port=PORT, print=None)
