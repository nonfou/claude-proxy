# Claude API Proxy

Claude 官方 API 透明转发代理。零依赖，单文件，支持 SSE 流式响应和速率限制查询。

## 环境要求

- Node.js >= 14

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `ANTHROPIC_API_KEY` | 是 | - | Claude API 密钥，服务端统一注入 |
| `PORT` | 否 | `3456` | 监听端口 |
| `TARGET_URL` | 否 | `https://api.anthropic.com` | 上游 API 地址 |

## 配置

编辑 `.env` 文件，填入 API Key：

```env
ANTHROPIC_API_KEY=sk-ant-xxx
PORT=3456
TARGET_URL=https://api.anthropic.com
```

> 环境变量优先级高于 `.env` 配置。

## 快速启动

```bash
# 方式一：使用启动脚本（后台运行，日志写入 proxy.log）
bash start.sh

# 方式二：前台运行
node proxy.js
```

停止服务：
```bash
bash stop.sh
```

启动成功输出：
```
Claude API proxy listening on http://0.0.0.0:3456
Forwarding to https://api.anthropic.com
Rate limits: GET http://localhost:3456/rate-limits
```

## 接口说明

### 1. 查询可用模型

```bash
curl http://localhost:3456/v1/models \
  -H "anthropic-version: 2023-06-01"
```

返回当前 API Key 可用的所有模型列表。

### 2. API 转发（所有路径）

所有请求原样转发到 Claude API，客户端无需携带 `x-api-key`。

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

### 3. 速率限制查询

启动代理后，先发送至少一次 API 请求（让代理从上游响应头获取限制数据），然后查询：

```bash
curl http://localhost:3456/rate-limits
```

返回示例：
```json
{
  "updatedAt": "2026-04-07T10:30:00.000Z",
  "headers": {
    "anthropic-ratelimit-requests-limit": "1000",
    "anthropic-ratelimit-requests-remaining": "999",
    "anthropic-ratelimit-requests-reset": "2026-04-07T10:31:00Z",
    "anthropic-ratelimit-tokens-limit": "100000",
    "anthropic-ratelimit-tokens-remaining": "99000",
    "anthropic-ratelimit-tokens-reset": "2026-04-07T10:31:00Z",
    "anthropic-ratelimit-input-tokens-limit": "80000",
    "anthropic-ratelimit-input-tokens-remaining": "79000",
    "anthropic-ratelimit-input-tokens-reset": "2026-04-07T10:31:00Z",
    "anthropic-ratelimit-output-tokens-limit": "20000",
    "anthropic-ratelimit-output-tokens-remaining": "19000",
    "anthropic-ratelimit-output-tokens-reset": "2026-04-07T10:31:00Z"
  }
}
```

| 字段 | 说明 |
|------|------|
| `updatedAt` | 最后一次获取限制信息的时间，未发过请求时为 `null` |
| `anthropic-ratelimit-requests-limit` | 每分钟请求数上限 |
| `anthropic-ratelimit-requests-remaining` | 当前周期内剩余请求数 |
| `anthropic-ratelimit-requests-reset` | 请求数限制重置时间 |
| `anthropic-ratelimit-tokens-limit` | 每分钟 token 总量上限 |
| `anthropic-ratelimit-tokens-remaining` | 当前周期内剩余 token 数 |
| `anthropic-ratelimit-tokens-reset` | token 限制重置时间 |
| `anthropic-ratelimit-input-tokens-limit` | 输入 token 上限 |
| `anthropic-ratelimit-input-tokens-remaining` | 剩余输入 token 数 |
| `anthropic-ratelimit-output-tokens-limit` | 输出 token 上限 |
| `anthropic-ratelimit-output-tokens-remaining` | 剩余输出 token 数 |

> 注意：限制信息在首次成功转发请求后才会有数据，启动后未发起请求时 `updatedAt` 为 `null`。

## 生产部署

### 方式一：直接运行

```bash
ANTHROPIC_API_KEY=sk-ant-xxx PORT=3456 node proxy.js
```

### 方式二：systemd 服务（Linux）

创建 `/etc/systemd/system/claude-proxy.service`：

```ini
[Unit]
Description=Claude API Proxy
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/claude-proxy
ExecStart=/usr/bin/node proxy.js
Restart=always
RestartSec=5
Environment=ANTHROPIC_API_KEY=sk-ant-xxx
Environment=PORT=3456

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp proxy.js /opt/claude-proxy/
sudo systemctl daemon-reload
sudo systemctl enable claude-proxy
sudo systemctl start claude-proxy
sudo systemctl status claude-proxy
```

### 方式三：PM2 进程管理

```bash
# 安装 PM2
npm install -g pm2

# 启动
ANTHROPIC_API_KEY=sk-ant-xxx pm2 start proxy.js --name claude-proxy

# 设置开机自启
pm2 save
pm2 startup
```

### 方式四：Docker

创建 `Dockerfile`：

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY proxy.js .
EXPOSE 3456
CMD ["node", "proxy.js"]
```

```bash
docker build -t claude-proxy .
docker run -d \
  --name claude-proxy \
  -p 3456:3456 \
  -e ANTHROPIC_API_KEY=sk-ant-xxx \
  --restart always \
  claude-proxy
```

## 客户端配置示例

### Python（anthropic SDK）

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://your-server:3456",
    api_key="unused",  # 服务端已注入，此处任意值即可
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

### curl

```bash
curl http://your-server:3456/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":1024,"messages":[{"role":"user","content":"Hi"}]}'
```

## 错误处理

| HTTP 状态码 | 含义 |
|-------------|------|
| 502 | 无法连接上游 Claude API（网络问题） |
| 其他 | 上游 API 原样返回的状态码（如 401、429 等） |
