# gpt2api Cloudflare Workers 边缘部署

本目录提供一个 **Cloudflare Workers Edge Front Door**，部署方式参考 `TQZHR/grok2api` 的 Wrangler + GitHub Actions 流程，但结合本项目的 Go 后端 / React 前端架构做了调整。

> 注意：本项目后端依赖 Go、MySQL、Redis、Asynq worker，不适合直接完整搬到 Workers 运行。本 Worker 负责把 Cloudflare 作为统一入口、TLS/WAF/自定义域名/美国区域出站入口，实际业务服务仍由 Docker Compose 或其他主机/K8s 源站承载。

## 路由规则

| Worker 路径 / Host | 转发目标 |
| --- | --- |
| `/v1/*` | `OPENAI_API_ORIGIN` |
| `/api/*` | `USER_API_ORIGIN` |
| `/admin/api/*` | `ADMIN_API_ORIGIN` |
| `Host == ADMIN_HOST` 或 `/admin/*` 的页面请求 | `ADMIN_WEB_ORIGIN` |
| 其他页面请求 | `USER_WEB_ORIGIN` |
| `/health`、`/healthz` | Worker 自身健康检查 |

## 本地手动部署

```bash
cd cloudflare
npm install
npx wrangler login
```

编辑 `wrangler.toml` 中的源站变量，确保都是真实 `https://` 地址，然后执行：

```bash
npm run typecheck
npm run dry-run
npm run deploy
```

## GitHub Actions 一键部署

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
