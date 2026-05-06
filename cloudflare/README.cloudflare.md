# gpt2api-cf Cloudflare Workers 原生部署

本目录提供接近 `TQZHR/grok2api` 风格的 Cloudflare 一键部署版本：**TypeScript + Hono + D1 + KV + Cron Trigger**。它不是简单边缘反代，而是在 Worker 内完成用户/API Key 鉴权、账号池选择、积分扣费、调用记录、账号健康状态缓存、OpenAI 兼容路由转发和静态资源托管。

## 功能对齐

| Docker 版能力 | Cloudflare 原生版实现 |
| --- | --- |
| `/v1/health`、`/v1/models` | Worker 内置，返回 Docker 版模型结构 |
| `/v1/chat/completions` | API Key 鉴权、scope 校验、积分扣费、账号池选择后转发到兼容上游 |
| `/v1/images/generations`、`/v1/images/edits` | 与 Docker 版参数语义保持一致，支持 KV 缓存生成元数据 |
| `/v1/video/generations`、`/v1/videos/generations` | 保留 video/videos 双路径别名 |
| `/api/v1/auth/*` | 用户注册、登录、刷新、登出 |
| `/api/v1/keys` | D1 API Key 创建、列表、启停、删除；支持 scope、RPM、daily quota、过期时间 |
| `/api/v1/billing/logs`、`/api/v1/calls` | 积分流水和 OpenAI 调用记录 |
| `/admin/api/v1/*` | 管理登录、仪表盘、用户积分、账号池、API Key、日志、系统设置基础接口 |
| Cron | 每日账号基础健康检查、熔断恢复、过期日志清理 |

> 说明：Workers 无法直接使用 SOCKS5 / HTTP CONNECT 代理。账号级 `proxy_url` 和全局 `GLOBAL_PROXY_URL` 会作为 `X-GPT2API-Proxy` 传给兼容上游网关；如需真实代理出站，请使用可被 Worker `fetch()` 访问的 HTTP 中转网关。

## 目录结构

```text
cloudflare/
  src/                 # Hono Worker 源码
  migrations/          # D1 SQL 迁移
  static/              # 前端静态资源 / Pages Advanced Mode _routes.json
  scripts/             # 一键初始化 / 部署脚本
  wrangler.toml        # Worker、D1、KV、Cron、域名配置
  README.cloudflare.md # 本文档
```

## 初始化 Cloudflare 资源

```bash
cd cloudflare
npm install
npx wrangler login
npm run init:cf
```

`npm run init:cf` 会尝试创建 D1 `gpt2api_d1` 和 KV `CACHE`，并把 ID 回写到 `wrangler.toml`。如果资源已存在，请手动执行：

```bash
npx wrangler d1 list
npx wrangler kv namespace list
```

然后把 `database_id`、`id`、`preview_id` 填入 `wrangler.toml`。

## 必填密钥

生产环境必须设置：

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put ENCRYPTION_KEY
```

- `JWT_SECRET`：JWT HS256 签名密钥。
- `ENCRYPTION_KEY`：账号 Cookie / Access Token AES-GCM 加密密钥；建议 32 字节以上随机字符串。

## 本地开发

```bash
cd cloudflare
npm install
npm run db:migrate:local
npm run dev
```

健康检查：

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/health
```

## 远程部署

```bash
cd cloudflare
npm run db:migrate:remote
npm run typecheck
npm run deploy
```

一键脚本：

```bash
./cloudflare/scripts/deploy-cloudflare.sh
# 首次部署可自动初始化资源：
CF_INIT=1 ./cloudflare/scripts/deploy-cloudflare.sh
```

PowerShell：

```powershell
./cloudflare/scripts/deploy-cloudflare.ps1
$env:CF_INIT="1"; ./cloudflare/scripts/deploy-cloudflare.ps1
```

也可以从仓库根目录执行：

```bash
./scripts/deploy-cloudflare.sh
```

## GitHub Actions

`.github/workflows/cloudflare-workers.yml` 会执行：

1. `npm install`
2. `npm run typecheck`
3. `wrangler d1 migrations apply --remote`
4. `wrangler deploy --dry-run`
5. `wrangler deploy`

需要在 GitHub Secrets 中配置：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

首次运行前请先提交已经填好 D1/KV ID 的 `wrangler.toml`，或在本地先执行 `CF_INIT=1 ./cloudflare/scripts/deploy-cloudflare.sh`。

## 自定义域名与路由

### Workers Custom Domain

在 `wrangler.toml` 取消注释并修改：

```toml
routes = [{ pattern = "api.example.com", custom_domain = true }]
```

或在 Cloudflare Dashboard → Workers & Pages → `gpt2api-native` → Triggers → Custom Domains 添加。

### Pages Advanced Mode

如果前端使用 Pages Advanced Mode，`static/_routes.json` 已提供默认路由规则：静态资源走 Assets，API 与页面兜底交给 Worker。

## API Key 管理示例

注册用户并获取首个 API Key：

```bash
curl -X POST https://api.example.com/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"u@example.com","password":"change-me"}'
```

创建新 Key：

```bash
curl -X POST https://api.example.com/api/v1/keys \
  -H 'authorization: Bearer USER_JWT' \
  -H 'content-type: application/json' \
  -d '{"name":"prod","scope":"chat,image,video","rpm_limit":60,"daily_quota":1000,"expire_days":365}'
```

查看调用记录：

```bash
curl https://api.example.com/api/v1/calls -H 'authorization: Bearer USER_JWT'
```

## OpenAI 兼容调用示例

```bash
curl -X POST https://api.example.com/v1/chat/completions \
  -H 'authorization: Bearer sk-g2cf-...' \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'
```

图片：

```bash
curl -X POST https://api.example.com/v1/images/generations \
  -H 'authorization: Bearer sk-g2cf-...' \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-image-2","prompt":"a cat","n":1}'
```

视频：

```bash
curl -X POST https://api.example.com/v1/video/generations \
  -H 'authorization: Bearer sk-g2cf-...' \
  -H 'content-type: application/json' \
  -d '{"model":"grok-imagine-video","prompt":"city flyover","n":1}'
```

## 账号池与健康检查

- 账号存放在 D1 `accounts`。
- Cookie / Token 入库前使用 `ENCRYPTION_KEY` 加密。
- Worker 选择账号时会跳过 KV 中 `account_health:<id>` 标记为 `down` 的账号。
- 调用成功写入 KV：`healthy`；失败写入 `degraded`，连续失败后 D1 状态进入 `cooldown`，KV 标记 `down`。
- Cron 每天执行一次基础 HEAD 健康检查，并清理 30 天前调用日志。

## MySQL 到 D1 迁移建议

1. 导出 Docker 版用户、钱包、API Key、账号池、生成历史和计费流水。
2. 把 MySQL 自增 ID 转为文本 ID，时间统一为 ISO8601。
3. 明文 API Key 不可逆时重新签发；可迁移 `key_hash`、`prefix`、`last4`、scope 和 quota。
4. Cookie / Token 必须用当前 Worker `ENCRYPTION_KEY` 重新加密后写入 D1。
5. 图片/视频大文件不要写 KV；建议放 R2，D1/KV 只保存 URL、任务状态和小元数据。

## KV / R2 注意事项

- KV 适合缓存任务元数据、缩略图、小型 JSON、临时会话和健康状态。
- 大图、视频、长时间保存文件建议使用 R2。
- `MAX_KV_CACHE_BYTES` 默认 20MB；超过阈值时只缓存元数据。

## 生产安全建议

- 修改 `CORS_ALLOW_ORIGINS` 为前台/后台域名，不要长期使用 `*`。
- 设置强随机 `JWT_SECRET`、`ENCRYPTION_KEY`。
- API Key 仅保存 SHA-256，明文只在创建时返回一次。
- 为关键 Key 设置 `rpm_limit`、`daily_quota`、`expire_days`。
- 保留 `[placement] region = "aws:us-east-1"` 可优化 GPT/Grok 美区出站稳定性。
