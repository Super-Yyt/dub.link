<!--
  This repository is a community fork of dubinc/dub focused on
  fully self-hosted deployments. Upstream README follows below.
-->

# Dub · 全本地化自托管版 (Fully Self-Hosted Fork)

> 一条命令跑起完整的 Dub 短链平台，零外部 SaaS、数据 100% 留在本机。
> Run the entire Dub link-management stack with one command - no external SaaS, all data stays on your machine.

这是 [Super-Yyt/dub.link](https://github.com/Super-Yyt/dub.link) —— 基于 [dubinc/dub](https://github.com/dubinc/dub) 的社区分支（AGPL-3.0，遵循上游协议开源），
把上游依赖的全部云服务替换为了本地组件。完整文档见 [selfhost/README.md](selfhost/README.md)。

## 快速开始 (Quick Start)

```bash
cp .env.selfhost.example .env.selfhost
# 生成密钥: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
docker compose --env-file .env.selfhost up -d --build
```

| 入口 | 地址 |
| --- | --- |
| 主应用 | http://localhost:8888 |
| 邮件收件箱（注册魔法链接） | http://localhost:8025 |
| 对象存储控制台 | http://localhost:9001 (dub / dubsecret) |
| 本地短链域名 | http://dub.localhost:8888/xxx |

端到端验收：`node selfhost/e2e.mjs`（注册 → 建短链 → 302 跳转 → 统计入 ClickHouse）。

## 外部服务 → 本地组件 (SaaS → Local)

| 上游依赖 | 本地替代 |
| --- | --- |
| PlanetScale (MySQL) | PostgreSQL 16 |
| Upstash Redis | Valkey + Upstash REST 协议兼容层 |
| Upstash QStash | 自研 QStash v2 兼容队列（重试/延迟/去重/签名） |
| Tinybird | ClickHouse + Tinybird API 兼容层（复用上游 pipe 定义） |
| Vercel Cron | 内置 cron 调度器 |
| Resend | SMTP（Mailpit，可换任意 SMTP） |
| Cloudflare R2 / S3 | RustFS（也可外接任意 S3） |
| Vercel Domains / Edge Config | 不再需要（共享域名机制 + 内置降级） |

## 相对上游的改动 (Changes vs Upstream)

保持最小侵入以便跟进上游：Prisma schema 迁移到 PostgreSQL、pg 连接层自动翻译 MySQL 方言、
两个 edge 路由改 nodejs runtime、共享域名机制（SELFHOST_DOMAINS）等，详见
[selfhost/README.md](selfhost/README.md) 与 git 历史。

---

<a href="https://dub.co">
  <img alt="Dub is the modern, open-source link attribution platform for short links and conversion tracking." src="https://github.com/user-attachments/assets/42cf0705-f5a2-4200-bc4a-c5acf0ba9e15">
</a>

<h3 align="center">Dub Links</h3>

<p align="center">
    The open-source link attribution platform.
    <br />
    <a href="https://dub.co/links"><strong>Learn more »</strong></a>
    <br />
    <br />
    <a href="#introduction"><strong>Introduction</strong></a> ·
    <a href="#tech-stack"><strong>Tech Stack</strong></a> ·
    <a href="#self-hosting"><strong>Self-hosting</strong></a> ·
    <a href="#contributing"><strong>Contributing</strong></a>
</p>

<p align="center">
  <a href="https://twitter.com/dubdotco">
    <img src="https://img.shields.io/twitter/follow/dubdotco?style=flat&label=%40dubdotco&logo=twitter&color=0bf&logoColor=fff" alt="Twitter" />
  </a>
  <a href="https://news.ycombinator.com/item?id=32939407"><img src="https://img.shields.io/badge/Hacker%20News-255-%23FF6600" alt="Hacker News"></a>
  <a href="https://github.com/dubinc/dub/blob/main/LICENSE.md">
    <img src="https://img.shields.io/github/license/dubinc/dub?label=license&logo=github&color=f80&logoColor=fff" alt="License" />
  </a>
</p>

<br/>

## Introduction

[Dub Links](https://dub.co/links) is the modern, open-source link attribution platform for [short links](https://dub.co/links) and [conversion tracking](https://dub.co/analytics).

Our platform powers 250M+ clicks and 12M+ links monthly, and is used by world-class engineering teams at Twilio, Zillow, Jobber, Vercel, Raycast, and [more](https://dub.co/customers).

## Tech Stack

- [Next.js](https://nextjs.org/) – framework
- [TypeScript](https://www.typescriptlang.org/) – language
- [Tailwind](https://tailwindcss.com/) – CSS
- [Prisma](https://www.prisma.io/) – ORM
- [Upstash](https://upstash.com/) – redis
- [Tinybird](https://tinybird.com/) – analytics
- [PlanetScale](https://planetscale.com/) – database
- [NextAuth.js](https://next-auth.js.org/) – auth
- [BoxyHQ](https://boxyhq.com/enterprise-sso) – SAML/SSO
- [Turborepo](https://turbo.build/repo) – monorepo
- [Stripe](https://stripe.com/) – payments
- [Resend](https://resend.com/) – emails
- [Vercel](https://vercel.com/) – deployments

## Self-Hosting

You can self-host Dub for greater control over your data and design. [Read this guide](https://dub.co/docs/self-hosting/guide) to learn more.

## Contributing

We love our contributors! Here's how you can contribute:

- [Open an issue](https://github.com/dubinc/dub/issues) if you believe you've encountered a bug.
- Follow the [local development guide](https://dub.co/docs/local-development) to get your local dev environment set up.
- Make a [pull request](https://github.com/dubinc/dub/pull) to add new features/make quality-of-life improvements/fix bugs.

### Recommended Versions

| Package | Version  |
| ------- | -------- |
| node    | v23.11.0 |
| pnpm    | 9.15.9   |

### Common Local Development Issues

- `The table <table-name> does not exist in the current database.` - Run `pnpm prisma:push` push the state of the Prisma schema file to the database without using migrations files.
- The project is not building correctly locally - verify your versions of `node` and `pnpm` match the recommended versions above. Delete all `node_modules`, `.next`, and `.turbo` directories in the `apps` and `packages` directory. You may now reinstall `node_modules` by running `pnpm install` and attempt to rebuild the project with `pnpm build`.

### Dev Seed Script

This script seeds the database with development data for testing and development purposes.

**Basic seeding (adds data without deleting existing data):**

```bash
cd apps/web
pnpm run script dev/seed
```

**Truncate database before seeding (deletes all existing data first):**

```bash
cd apps/web
pnpm run script dev/seed --truncate
```

When using `--truncate`, the script will ask for confirmation before deleting any data.

## Repo Activity

![Dub repo activity – generated by Axiom](https://repobeats.axiom.co/api/embed/6ac4c94a89ea20e2e10032b932a128b6d8442e66.svg "Repobeats analytics image")

## License

Dub Technologies, Inc. is a commercial open-source company, which means some parts of this open-source repository require a commercial license. The concept is called "Open Core" where the core technology (99%) is fully open source, licensed under [AGPLv3](https://opensource.org/license/agpl-v3) and the last 1% is covered under a commercial license (["/ee" Enterprise Edition](<https://github.com/dubinc/dub/tree/ee/apps/web/app/(ee)>)) which we believe is entirely relevant for larger organisations that require enterprise features. Enterprise features are built by the core engineering team of Dub Technologies, Inc., which is hired full-time.
