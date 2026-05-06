# gpt2api Cloudflare Workers 边缘部署

本目录提供一个 **Cloudflare Workers Edge Front Door**，部署方式参考 `TQZHR/grok2api` 的 Wrangler + GitHub Actions 流程，但结合本项目的 Go 后端 / React 前端架构做了调整。

> 重要：**不要把 Cloudflare 账号密码发给任何人，也不要提交到仓库。** 如需别人协助部署，请只创建权限最小化的 Cloudflare API Token，并通过本地环境变量或 GitHub Secrets 使用；部署完成后可随时删除/轮换 Token。

> 架构说明：本项目后端依赖 Go、MySQL、Redis、Asynq worker，不适合完整搬到 Workers 运行。本 Worker 只负责把 Cloudflare 作为统一入口、TLS/WAF/自定义域名/美国区域出站入口，实际业务服务仍由 Docker Compose、VPS 或 K8s 源站承载。

## 先决条件

1. 先把 gpt2api 源站跑起来，例如 `deploy/docker-compose.server.yml`，并准备能从公网访问的 HTTPS 地址。
2. Cloudflare 账号中准备一个域名，或者先使用 `*.workers.dev` 进行测试。
3. 创建 Cloudflare API Token：Cloudflare Dashboard → My Profile → API Tokens → Create Token → 使用 Workers 编辑权限模板；同时记下 Account ID。

## 路由规则

| Worker 路径 / Host | 转发目标 |
| --- | --- |
| `/v1/*` | `OPENAI_API_ORIGIN`，OpenAI 兼容 API |
| `/api/*` | `USER_API_ORIGIN`，用户端 API |
| `/admin/api/*` | `ADMIN_API_ORIGIN`，管理后台 API |
| `Host == ADMIN_HOST` 或 `/admin/*` 的页面请求 | `ADMIN_WEB_ORIGIN`，管理后台前端 |
| 其他页面请求 | `USER_WEB_ORIGIN`，用户前端 |
| `/health`、`/healthz` | Worker 自身健康检查 |

## 方式 A：本地部署（推荐先用这个验证）

```bash
cd cloudflare
cp .env.example .env.local
```

编辑 `.env.local`，把 `example.com` 改成你的真实源站地址，并填入：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CF_USER_WEB_ORIGIN`
- `CF_ADMIN_WEB_ORIGIN`
- `CF_USER_API_ORIGIN`
- `CF_ADMIN_API_ORIGIN`
- `CF_OPENAI_API_ORIGIN`

然后执行：

```bash
npm install
npm run typecheck
npm run dry-run
npm run deploy
```

或在仓库根目录直接执行：

```bash
./scripts/deploy-cloudflare.sh
# Windows PowerShell:
# ./scripts/deploy-cloudflare.ps1
```

脚本会生成 `cloudflare/wrangler.local.toml`。该文件包含真实源站信息，已被 `.gitignore` 的 `*.local` 规则忽略，不要提交。

部署后先访问：

```bash
curl https://<你的-worker域名>/healthz
curl https://<你的-worker域名>/v1/models -H "Authorization: Bearer <你的用户密钥>"
```

## 方式 B：GitHub Actions 一键部署

仓库包含 `.github/workflows/cloudflare-workers.yml`。在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置：

必填：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CF_USER_WEB_ORIGIN`
- `CF_ADMIN_WEB_ORIGIN`
- `CF_USER_API_ORIGIN`
- `CF_ADMIN_API_ORIGIN`
- `CF_OPENAI_API_ORIGIN`

可选：

- `CF_ADMIN_HOST`
- `CF_CORS_ALLOW_ORIGINS`，逗号分隔；不填时默认 `*`。

推送到 `main` 或手动运行 workflow 后，会自动生成 `cloudflare/wrangler.ci.toml`，注入源站地址与 `BUILD_SHA`，随后执行 Wrangler dry-run 和 deploy。

## 常见问题

### 能不能把 Cloudflare 账号发给别人代部署？

不建议，也不需要。正确做法是创建一个临时 API Token，只授予 Workers 相关权限；把 Token 放到本机 `.env.local` 或 GitHub Secrets，用完后在 Cloudflare 后台删除或轮换。

### Worker 能不能替代 Docker Compose 后端？

不能。Worker 只做边缘反代；MySQL、Redis、worker 队列、Go API 服务仍然要在源站运行。

### 源站地址应该填什么？

如果你的 Docker Compose 源站已经通过 Caddy/Nginx 暴露：

- `CF_USER_WEB_ORIGIN=https://app.example.com`
- `CF_ADMIN_WEB_ORIGIN=https://admin-origin.example.com`
- `CF_USER_API_ORIGIN=https://app.example.com`
- `CF_ADMIN_API_ORIGIN=https://admin-origin.example.com`
- `CF_OPENAI_API_ORIGIN=https://api-origin.example.com`

也可以先都指向同一个源站域名，由源站 Nginx/Caddy 根据路径继续转发。
