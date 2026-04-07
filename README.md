# Claude API Proxy

Claude API 透明转发代理，支持 API Key 和 OAuth Token 双模式认证。使用 aiohttp 异步框架 + curl_cffi（Chrome TLS 指纹伪装），支持 SSE 流式响应和速率限制查询。

## 环境要求

- Python >= 3.10
- pip（用于安装依赖）

## 依赖

```
aiohttp>=3.9       # 异步 HTTP 服务器 + 客户端
curl_cffi>=0.7     # Chrome TLS 指纹伪装（绕过 Cloudflare）
```

## 认证模式

支持三种认证方式（优先级从高到低）：

| 模式 | 环境变量 | 说明 |
|------|----------|------|
| API Key | `ANTHROPIC_API_KEY` | 标准 Anthropic API 密钥，注入 `x-api-key` 头 |
| OAuth Token（环境变量） | `ANTHROPIC_AUTH_TOKEN` | OAuth token 直接设置，注入 `Authorization: Bearer` 头 |
| OAuth Token（文件） | `CLAUDE_CREDENTIALS_FILE` | 从 `claude login` 生成的配置文件读取 token |
| SessionKey 登录 | Dashboard 页面 | 通过 claude.ai sessionKey cookie 自动获取 OAuth token |

### API Key 模式

传统方式，使用 Anthropic API 密钥：

```env
ANTHROPIC_API_KEY=sk-ant-xxx
```

### OAuth Token 模式

适用于 Claude 订阅用户（Pro/Max），在服务器上登录后代理出来：

**方式 A：直接设置 token**
```env
ANTHROPIC_AUTH_TOKEN=xxxx.yyyy
```

**方式 B：从文件自动读取**

在服务器上执行 `claude login` 后，代理自动读取 `~/.claude/settings.json` 中的 token：

```env
# 默认路径，无需显式设置
# CLAUDE_CREDENTIALS_FILE=~/.claude/settings.json
```

**方式 C：SessionKey 登录（推荐）**

1. 在任意浏览器中打开 [claude.ai](https://claude.ai) 并登录
2. F12 → Application → Cookies → `claude.ai` → 复制 `sessionKey` 值
3. 打开 Dashboard（`http://server:3456/`）→ 点击 Login → 粘贴 sessionKey
4. 代理自动完成 OAuth PKCE 流程获取 token

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `ANTHROPIC_API_KEY` | 三选一 | - | Claude API 密钥 |
| `ANTHROPIC_AUTH_TOKEN` | 三选一 | - | OAuth token（直接设置） |
| `CLAUDE_CREDENTIALS_FILE` | 三选一 | `~/.claude/settings.json` | OAuth token 文件路径 |
| `AUTH_HEADER_NAME` | 否 | 自动 | 认证头名称覆盖（`x-api-key` 或 `authorization`） |
| `TOKEN_REFRESH_INTERVAL` | 否 | `0` | Token 定时刷新间隔（秒），0 = 仅 401 时刷新 |
| `PORT` | 否 | `3456` | 监听端口 |
| `TARGET_URL` | 否 | `https://api.anthropic.com` | 上游 API 地址 |

## 快速启动

```bash
# 安装依赖
pip install -r requirements.txt

# 启动代理
python3 proxy.py
```

### API Key 模式

```bash
ANTHROPIC_API_KEY=sk-ant-xxx python3 proxy.py
```

### OAuth Token 模式（推荐用于订阅用户）

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. 启动代理
python3 proxy.py

# 3. 打开 Dashboard 使用 SessionKey 登录
# http://your-server:3456/

# 4. 本地使用
# export ANTHROPIC_BASE_URL=http://your-server:3456
# export ANTHROPIC_API_KEY=unused
# claude
```

使用脚本管理：

```bash
bash start.sh    # 后台启动
bash stop.sh     # 停止服务
```

启动成功输出：

```
Claude API proxy listening on http://0.0.0.0:3456
Forwarding to https://api.anthropic.com
Auth: oauth (oauth) token=3585...527303
Dashboard: http://localhost:3456/
Rate limits: GET http://localhost:3456/rate-limits
Auth status: GET http://localhost:3456/auth-status
```

## 接口说明

### 1. API 转发（所有路径）

所有请求原样转发到 Claude API，代理自动注入认证头。

**非流式请求：**
```bash
curl http://localhost:3456/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

**流式请求（SSE）：**
```bash
curl http://localhost:3456/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### 2. 查询可用模型

```bash
curl http://localhost:3456/v1/models \
  -H "anthropic-version: 2023-06-01"
```

### 3. 速率限制查询

```bash
curl http://localhost:3456/rate-limits
```

> 限制信息在首次成功转发请求后才有数据。

### 4. 认证状态查询

```bash
curl http://localhost:3456/auth-status
```

返回示例：
```json
{
  "mode": "oauth",
  "source": "oauth",
  "headerName": "authorization",
  "tokenMasked": "3585...7303",
  "hasRefreshToken": true,
  "expiresAt": "2026-04-07T11:30:00+00:00",
  "lastReadAt": "2026-04-07T10:30:00+00:00",
  "lastError": null
}
```

## Token 自动刷新

OAuth Token 模式支持自动刷新：

- **401 触发刷新**：收到上游 401 响应时，自动刷新 token 并重试请求（默认行为）
- **Token 过期预刷新**：请求时检测到 token 即将过期（3 分钟内），自动提前刷新
- **定时刷新**：设置 `TOKEN_REFRESH_INTERVAL=300` 每 5 分钟刷新
- **手动刷新**：Dashboard 或 POST `/auth-refresh`
- **并发安全**：使用 asyncio.Lock 避免多个请求同时触发刷新

## 客户端配置

### Claude Code CLI

```bash
export ANTHROPIC_BASE_URL=http://your-server:3456
export ANTHROPIC_API_KEY=unused
claude
```

### Python（anthropic SDK）

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://your-server:3456",
    api_key="unused",
)
```

### Node.js（@anthropic-ai/sdk）

```javascript
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
    baseURL: 'http://your-server:3456',
    apiKey: 'unused',
});
```

## 生产部署

### systemd 服务（Linux）

创建 `/etc/systemd/system/claude-proxy.service`：

```ini
[Unit]
Description=Claude API Proxy
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/claude-proxy
ExecStart=/usr/bin/python3 proxy.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable claude-proxy
sudo systemctl start claude-proxy
```

### PM2 进程管理

```bash
pm2 start proxy.py --interpreter python3 --name claude-proxy
pm2 save
pm2 startup
```

### Docker

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY proxy.py dashboard.html .env ./
EXPOSE 3456
CMD ["python3", "proxy.py"]
```

```bash
docker build -t claude-proxy .
docker run -d \
  --name claude-proxy \
  -p 3456:3456 \
  --restart always \
  claude-proxy
```

## 错误处理

| HTTP 状态码 | 含义 |
|-------------|------|
| 401 | Token 无效或过期，代理已尝试刷新但失败 |
| 502 | 无法连接上游 Claude API（网络问题） |
| 503 | 未配置认证，需通过 Dashboard 登录 |
| 其他 | 上游 API 原样返回的状态码 |
