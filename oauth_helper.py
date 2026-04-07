#!/usr/bin/env python3
"""OAuth helper - uses curl_cffi to bypass Cloudflare TLS fingerprinting."""
import sys, json, subprocess

def ensure_deps():
    try:
        import curl_cffi
    except ImportError:
        print('[oauth_helper] Installing curl_cffi...', file=sys.stderr)
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'curl_cffi', '-q'])

ensure_deps()
from curl_cffi import requests as cffi_requests

def main():
    req = json.loads(sys.stdin.read())
    method = req.get('method', 'GET')
    url = req['url']
    headers = req.get('headers', {})
    cookies = req.get('cookies', {})
    data = req.get('data')

    try:
        resp = cffi_requests.request(
            method, url,
            headers=headers,
            cookies=cookies,
            data=data.encode('utf-8') if isinstance(data, str) else data,
            impersonate='chrome',
            timeout=30,
        )
        print(json.dumps({'status': resp.status_code, 'body': resp.text}))
    except Exception as e:
        print(json.dumps({'status': 0, 'error': str(e)}))

if __name__ == '__main__':
    main()
