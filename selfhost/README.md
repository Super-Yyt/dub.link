# Dub 自托管部署（全本地化，PostgreSQL 版）

本目录包含把 Dub 完全自托管所需的全部组件。**所有原依赖的外部 SaaS 均已替换为本地服务，数据 100% 留在本机**，一条命令启动整个技术栈：

```bash
cp .env.selfhost.example .env.selfhost
# 建议修改 .env.selfhost 里的 NEXTAUTH_SECRET / ENCRYPTION_KEY / CRON_SECRET
docker compose --env-file .env.selfhost up -d --build
```

启动完成后：

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| Dub 主应用 | http://localhost:8888 | 短链管理界面 + API |
| 邮件收件箱 | http://localhost:8025 | Mailpit，登录魔法链接在这里查看 |
| 对象存储控制台 | http://localhost:9001 | RustFS（S3 兼容） |
| 短链域名 | http://dub.localhost:8888/xxx | `.localhost` 域名自动解析到本机，开箱即用 |

## 架构：外部服务 → 本地组件对照

| 上游依赖（SaaS） | 本地替代 | 实现位置 |
| --- | --- | --- |
| PlanetScale (MySQL) | **PostgreSQL 16** | Prisma schema 已迁移到 postgresql provider |
| Upstash Redis (REST) | **Valkey** + Upstash REST 协议兼容层 | `selfhost/redis-rest` |
| Upstash QStash | 自研 QStash v2 API 兼容队列（重试/延迟/去重/流控/签名） | `selfhost/qstash` |
| Tinybird | **ClickHouse** + Tinybird API 兼容层（直接复用上游 `packages/tinybird` 的 pipe 定义与模板语法） | `selfhost/tinybird` |
| Vercel Domains API | 不再依赖（通过 `SELFHOST_DOMAINS` 共享域名 + DNS 指向本机） | 见下文 |
| Vercel Cron | 内置 cron 调度器（沿用 `vercel.json` 的调度表） | `selfhost/cron` |
| Resend（邮件） | SMTP → Mailpit（换任意 SMTP 也很简单） | compose `mailpit` 服务 |
| Cloudflare R2 / S3 | RustFS（S3 兼容；也可外接任何 S3） | compose `rustfs` 服务 |
| Vercel Edge Config | 代码本身已内置降级，无需配置 | — |

## 兼容层说明

### redis-rest（Upstash Redis REST 兼容层）
`@upstash/redis` SDK 通过 HTTP REST 协议访问 Redis。本服务把该协议翻译给本地 Valkey：单命令、pipeline、URL 路径风格全部支持，HGETALL 等返回形状与 Upstash 保持一致，Web 应用零改动。

### qstash（QStash 兼容队列）
实现了 Dub 用到的 QStash v2 接口：`/v2/publish/*`、`/v2/batch`、`/v2/enqueue/*`、`/v2/queues/*`。消息按 Upstash 语义投递：2xx 成功、5xx/超时指数退避重试、`Upstash-Delay`/`Upstash-Not-Before` 延迟、`Upstash-Deduplication-Id` 去重、`Upstash-Flow-Control-*` 并发限制，并附带 HS256 的 `Upstash-Signature` JWT。消息持久化到卷，重启后继续投递。

### tinybird（Tinybird 兼容分析层）
直接加载上游仓库 `packages/tinybird` 里的 `.pipe` 文件（32 个管道），内置一个 Tinybird 模板语法（`{% if defined(x) %}`、`{{ Array(x, 'String') }}` 等）的解释器，按请求渲染成 ClickHouse SQL 执行。数据表与物化视图由 `packages/tinybird/datasources` 自动建表。对外提供：

- `GET /v0/pipes/<name>.json` —— 管道查询（响应形状与 Tinybird 一致）
- `POST /v0/events?name=<datasource>` —— 事件写入（NDJSON，自动转换 ISO 时间戳）
- `POST /v0/datasources/<name>/delete` —— 条件删除（ALTER TABLE DELETE）

## PostgreSQL 迁移要点（相对上游的改动）

- `prisma/schema`：`provider` 改为 `postgresql`，`@db.LongText → @db.Text`、`@db.Json → @db.JsonB`，移除 MySQL 专属的 `@@fulltext` 与索引长度参数
- `lib/planetscale/connection.ts`：改为 node-postgres 连接池，自动翻译 `?` 占位符、反引号标识符、`UPDATE t alias SET alias.c` 三种 MySQL 方言写法，调用点保持上游原样
- `lib/prisma/edge.ts`：改用标准 PrismaClient（Node runtime）
- `lib/jackson.ts`：SAML 存储引擎改指向 PostgreSQL
- sitemaps 定时任务的 SQL 改写为 PG 的 `->>` / `jsonb_array_length` 语法

## 域名说明

- `SELFHOST_DOMAINS=dub.localhost`：实例级共享短链域名（等价于 dub.co 的 dub.sh）。`*.localhost` 在所有浏览器里自动解析到 127.0.0.1，本地开箱即用；新工作台可直接在该域名下建短链。
- 生产环境：把 `SELFHOST_DOMAINS` 设为你的真实域名（如 `go.example.com`），DNS A 记录指向本机，所有工作台共享该域名；用户也可以在界面里添加自己拥有的自定义域名。
- `NEXTAUTH_URL` 必须是用户浏览器可访问的地址（默认 `http://localhost:8888`）。

## 常用操作

```bash
# 启动/停止
docker compose --env-file .env.selfhost up -d
docker compose --env-file .env.selfhost down

# 查看日志
docker compose --env-file .env.selfhost logs -f web

# 重置全部数据（慎）
docker compose --env-file .env.selfhost down -v

# 更新代码后重建
git pull && docker compose --env-file .env.selfhost up -d --build
```

## 端到端验收

selfhost/e2e.mjs 是一条无头验收链路：邮箱魔法链接登录（从 Mailpit 取信）→
创建工作区 → 在 dub.localhost 创建短链 → 请求短链验证 302 跳转 →
浏览器 UA 点击后统计落入 ClickHouse：

    node selfhost/e2e.mjs

## 已知边界

- Stripe 支付、Google/GitHub OAuth、Slack/HubSpot 集成、AI 功能等可选能力仍需自行申请相应凭据（与上游一致），不影响核心短链功能。
- `VERCEL` 环境变量不设置时，QStash 签名校验按上游逻辑自动跳过；本队列仍然生成合法签名，设置后亦可校验。
- 上游 `packages/workers`（Cloudflare Worker，用于免费版统计页）不在本地栈中；统计 API 由主应用直接提供。
