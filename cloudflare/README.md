# gpt2api-cf Cloudflare Workers 原生部署版

本目录把原 Docker/MySQL/Redis 形态扩展为 **Cloudflare Workers 原生运行**：TypeScript + Hono 承载 API，D1 保存用户、API Keys、账号池、计费、配置与日志，KV 保存临时缓存和图片/视频生成元数据，Cron Trigger 每天清理与账号熔断恢复。

## 整体改造方案

- **入口**：`src/index.ts` 使用 Hono 注册 `/v1/*`、`/api/*`、`/admin/api/*`、健康检查与静态资源兜底。
- **数据库**：`migrations/0001_init.sql` 创建 Users、API Keys、GPT/Grok Cookie 账号池、Proxy、Billing、Generation、Config、Request Logs 等表。
- **账号池**：`services/db.ts` 按 provider、状态、熔断时间和最近使用时间轮换账号；连续失败会进入 cooldown，Cron 到期恢复。
- **上游访问**：`services/upstream.ts` 保留 GPT/Grok Cookie、Access Token、账号级代理、全局代理配置语义。Workers 不能原生 TCP CONNECT 代理，因此代理 URL 通过 `X-GPT2API-Proxy` 传递给兼容上游网关；如需真实代理，请接入 HTTP 中转网关。
- **计费**：OpenAI 兼容接口调用前扣除积分，并写入 `billing_records`；余额不足返回 OpenAI 风格 `insufficient_quota`。
- **安全**：JWT 登录、API Key SHA-256 存储、Cookie/Token AES-GCM 加密、CORS、安全响应头、KV 简易限流。
- **前端**：`static/` 可直接放 Vite 打包产物；当前提供占位页。也可以使用 Pages Advanced Mode 指向同一个 Worker。

## 可能遇到的难点

1. **GPT/Grok Web 协议会变化**：Cookie 直连依赖上游网页接口，建议保留 Docker 版作为协议适配参考，必要时在 `callModel()` 中更新具体 endpoint。
2. **Workers 代理能力限制**：Workers `fetch` 不支持传统 TCP CONNECT/SOCKS 代理。要实现“账号级代理”实际出站，需要用 Cloudflare Worker 可访问的 HTTP 代理网关或自建中转服务。
3. **D1 与 MySQL 差异**：D1 基于 SQLite，不支持 MySQL 专有语法、长事务和部分锁语义；大批量迁移建议分批导入。
4. **KV 大文件限制**：KV 单值不适合超大视频。推荐只缓存元数据、缩略图或小文件；视频/大图上传到 R2，再把 R2 URL 写入 D1/KV。
5. **静态资源体积**：完整 React 前后台可以 `pnpm build` 后复制到 `cloudflare/static`，大型资源建议 Pages 或 R2。

## 前置条件

- Node.js 20+
- Cloudflare 账号，开通 Workers、D1、KV
- `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`

## 初始化

```bash
cd cloudflare
npm install
npx wrangler login
npm run init:cf
```

`init:cf` 会尝试创建/复用 `gpt2api_d1` 和 `CACHE` KV，并把返回的 ID 写入 `wrangler.toml`。如果 Cloudflare 返回资源已存在，请在 Dashboard 或 `wrangler d1 list`、`wrangler kv namespace list` 中复制 ID 手动填入。

设置生产密钥：

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put ENCRYPTION_KEY
```

## 本地开发

```bash
cd cloudflare
npm install
npm run db:migrate:local
npm run dev
```

默认管理员种子账号为 `admin@example.com`。请部署后立即通过 D1 控制台更新密码哈希，或自行插入管理员账号。

## 远程迁移与部署

```bash
cd cloudflare
npm run db:migrate:remote
npm run typecheck
npm run deploy
```

也可以使用一键脚本：

```bash
./cloudflare/scripts/deploy-cloudflare.sh
# Windows PowerShell
./cloudflare/scripts/deploy-cloudflare.ps1
```

根目录 `scripts/deploy-cloudflare.sh` 与 `.ps1` 会转发到上述脚本，方便从仓库根目录执行。

## GitHub Actions 一键部署

仓库已提供 `.github/workflows/cloudflare-workers.yml`。在 GitHub Settings → Secrets and variables → Actions 中配置：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

首次使用前请先在本地执行 `npm run init:cf` 并提交已填好 D1/KV ID 的 `wrangler.toml`，或在 CI 中改用你自己的创建脚本。Workflow 会执行：安装依赖 → typecheck → D1 remote migrations → dry-run → deploy。

## API 示例

注册并获取 JWT + API Key：

```bash
curl -X POST https://your-worker.example.com/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"user@example.com","password":"change-me"}'
```

调用 OpenAI 兼容聊天接口：

```bash
curl -X POST https://your-worker.example.com/v1/chat/completions \
  -H 'authorization: Bearer sk-g2cf-...' \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'
```

## MySQL 到 D1 迁移建议

1. 从 Docker 版 MySQL 导出用户、API Key、账号池、计费、生成记录。
2. 把自增 ID 映射为文本 ID，时间字段统一 ISO8601。
3. API Key 只迁移哈希；明文 Key 无法恢复时应重新签发。
4. GPT/Grok Cookie 与 Token 迁移前用 `ENCRYPTION_KEY` 重新 AES-GCM 加密后写入 `accounts`。
5. 大型 generation 结果迁移到 R2，仅把 URL、状态与元数据写入 D1。

## 自定义域名

```bash
npx wrangler route add your-domain.example.com/* gpt2api-native
```

或在 Cloudflare Dashboard → Workers & Pages → gpt2api-native → Triggers 添加 Custom Domain。

## 生产注意事项

- 必须修改 `JWT_SECRET`、`ENCRYPTION_KEY`。
- 推荐把 `CORS_ALLOW_ORIGINS` 改为实际前台/后台域名。
- 如果图片/视频较大，请启用 R2，不要把大视频直接写 KV。
- 若需要强代理出站，请接入 HTTP 代理网关；Workers 无法直接使用 SOCKS5/CONNECT。
- 可保留 `[placement] region = "aws:us-east-1"` 优化美区上游访问。
