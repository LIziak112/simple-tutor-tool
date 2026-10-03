# simple-tutor-tool

[![CI](https://github.com/LIziak112/simple-tutor-tool/actions/workflows/ci.yml/badge.svg)](https://github.com/LIziak112/simple-tutor-tool/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.en.md) · [简体中文](README.md)

A self-hosted, AI-native teaching and practice tool for online 1-on-1 tutors. It started as a fix for one tutor's daily headaches — lecture notes scattered across files, each student's progress living mostly in the tutor's head — and has been growing through real use ever since.

It tries to do one thing well, end to end: the tutor writes Markdown that follows a small spec (AI can help), imports it, and it becomes interactive lecture notes and exercises; students open a link and work through them, including handwriting with Apple Pencil; the tutor then sees every student's answers, every stroke of their handwriting, and the learning analytics behind them; and the structured data can be handed back to AI to help prepare the next lesson.

**One process, data stays with you**: a single Node process serves the teacher app, the student app, and all the APIs; the data is one SQLite file plus a blobs directory inside a local `data/` folder (raw handwriting strokes, backups, and shared content all live in there) — nothing passes through any third-party platform, and backing up means copying the directory.

The core asset along this chain is a **data-structure contract shared across both ends** (the Zod schemas in [`packages/contract`](packages/contract)): upstream, MD that conforms to the contract is turned automatically into lecture notes and exercises; downstream, answer data comes out as structured JSON that AI can consume directly.

```
AI writes content (DSL-spec MD) ──→ import: auto-parse & render ──→ students answer (incl. handwriting)
         ▲                                                                                     │
         └──── AI analyzes learning / writes targeted practice ←──── structured answer data ───┘
```

## Screenshots

| Students answering (iPad / browser) | Instant feedback after submission |
| --- | --- |
| ![Student answering](docs/screenshots/student-answering.png) | ![Result view after submission](docs/screenshots/student-result.png) |

| Handwriting · stroke replay | Teacher grading, question by question |
| --- | --- |
| ![Handwriting stroke replay](docs/screenshots/handwriting-replay.png) | ![Teacher grading detail](docs/screenshots/teacher-grading.png) |

| Answer data (per student) | Student mistake notebook |
| --- | --- |
| ![Per-student answer data](docs/screenshots/teacher-data.png) | ![Mistake notebook](docs/screenshots/wrong-book.png) |

## Feature overview

### Content engine (Markdown in, interactive pages out)

- **Import and go**: drop in a `.md` — lecture notes, a workbook, or a mix — and it's typed, parsed, and published in one step, with no manual cleanup in between.
- **Structured automatically**: exercises are split into a question bank (unit, question number, type, difficulty, knowledge points, answer, worked solution); lectures are split into parts at each "Lesson X" heading.
- **Interactive rendering**: Markdown and math formulas (KaTeX, bundled locally — no CDN) are typeset automatically; explanations stay collapsed until tapped, and answers and worked solutions appear only after submission.
- **Markdown DSL**: extended syntax such as `:::` container directives (collapsible blocks, tips, step-by-step, function graphs, highlights, …) is managed centrally in a directive registry — **published directives are append-only, so old content keeps working**; the built-in teacher-side CodeMirror editor shows live lint diagnostics.
- **Built-in linter**: `pnpm tutor-lint` validates DSL documents, and the error messages can be fed straight back to the AI for fixing.

### Student side (zero friction)

- Students open a **personal link** in a browser, or sign in with **name + password** — nothing to install, no registration; on iPad, "Add to Home Screen" gives a full-screen app (PWA).
- **Reading lectures**: typeset formulas, an automatic table of contents, collapsible worked examples, and lessons split into parts.
- **Answering online**: true/false, multiple choice, fill-in-the-blank, and handwriting; math answers can be typed with an optional MathLive virtual keyboard; Apple Pencil writing keeps the original stroke image. Step-by-step hints can be unlocked.
- **Grading and feedback**: objective questions are graded authoritatively on the server the moment they're submitted; fill-in and handwriting questions go into the teacher's grading queue. **Student-facing APIs never send down answers, worked solutions, or hints for questions that haven't been submitted.**
- **Records that stay**: the time, score, and per-question results of every practice session are always there to look back at; the mistake notebook keeps round-by-round history, grouping across several dimensions, and mastery criteria, and lets students redo their mistakes in one tap.
- **Drafts don't get lost**: answer drafts are kept in local IndexedDB and survive refreshes and screen locks.

### Teacher side (manage content, get data)

- **Per-teacher isolation**: each teacher's library, courses, assignments, and students are fully isolated; the first teacher is the admin, and the admin panel manages accounts, the registration switch, and the shared directory between teachers.
- **Resource library**: import, preview, edit, reorder, soft-delete, and organize units and lectures — content stays a maintainable asset, not a one-off import.
- **Import wizard**: a lint gate, a dry-run preview, and per-file selective import.
- **Courses and assignments**: create courses, manage student rosters, and assign homework through a wizard (one set per unit, or merged into one).
- **Grading**: mark fill-in / handwriting questions per item, right or wrong, with written comments; reference answers render their LaTeX.
- **Answer data**: browse every submission per student — answers question by question, grading results, time spent per question, and original handwriting images.
- **Learning analytics**: mastery matrix, weekly trends, key knowledge points, per-question statistics, and student profiles (ECharts) — direct input on what to teach in the next lesson.
- **Export and backup**: submissions export to CSV; one click downloads a full backup zip (a database snapshot is taken automatically first), and uploading one restores it (password confirmation, plus an automatic pre-restore snapshot to roll back to).

### AI-native (three ways in)

| Layer | How it works |
| --- | --- |
| Authoring (AI writes content) | DSL spec + prompt templates + linter (served at the `/spec` route): hand the spec to any AI and the MD it produces imports directly. The tutor moves from writing materials to reviewing them. |
| Data (AI reads data) | One-click export of an "AI learning-data bundle": structured answer data plus a ready-made prompt — hand it to AI and get error distributions, weak points, and suggestions for the next lesson. |
| Live access (MCP server) | Built-in MCP server (`/mcp`, authenticated with a teacher API token): AI clients such as Claude can list students, fetch learning-data bundles, write reports, fetch the DSL spec, and validate and import content directly. |

## Tech stack

| Category | Choices |
| --- | --- |
| Language / contract | TypeScript (strict, no `any`) · Zod v4 (one schema shared by frontend and backend, plus a JSON Schema export for AI) |
| Frontend `apps/web` | React 19 · Vite · Tailwind CSS v4 · shadcn/ui (Radix) · TanStack Query · Zustand · React Router v7 · CodeMirror 6 · ECharts · KaTeX · MathLive · Excalidraw + Atrament (handwriting, behind the `InkSurface` adapter) · vite-plugin-pwa |
| Backend `apps/server` | Node.js ≥ 24 · Hono (the frontend uses the `hc` RPC client for end-to-end types) · better-sqlite3 (WAL) · Drizzle ORM + drizzle-kit · pino · MCP SDK |
| Shared packages `packages/` | `contract` (Zod data contract, single source of truth) · `md-dsl` (unified/remark-based parser + linter) · `grading` (pure-function grading, server-side only) |
| Quality | Vitest (2300+ unit tests) · Playwright (E2E, Chromium + WebKit iPad emulation) · Biome (lint + format) · GitHub Actions CI |
| Deployment | Docker multi-stage single container + Caddy reverse proxy (automatic HTTPS); or `node dist` + systemd |

## Architecture and repository layout

```
┌──────────────────── one Node process (apps/server) ────────────────────┐
│  static assets: apps/web build output (SPA + PWA + KaTeX fonts)        │
│  /api/teacher/* (cookie session)   /api/student/* (personal link token)│
│  /mcp (teacher API token)      /spec/* (DSL spec, JSON Schema, prompts)│
│  domain services: content / answers / learning traces / analytics /    │
│                   export / MCP                                         │
│  data/tutor.db (SQLite WAL) · data/blobs/ (handwriting) · data/backups/│
└────────────────────────────────────────────────────────────────────────┘
    ▲ tutor (desktop browser)      ▲ students (iPad / phone / PC, PWA)      ▲ AI clients (MCP)
```

Every contract lives in `packages/contract`; the frontend, backend, MCP, and export files all share the same schema.

```
simple-tutor-tool/
  apps/
    web/        # React frontend (student + teacher, one SPA split by route)
    server/     # Hono backend (API + static assets + MCP + SQLite)
  packages/
    contract/   # Zod data contract (single source of truth) + JSON Schema export
    md-dsl/     # DSL parser + linter + CLI (tutor-lint)
    grading/    # pure-function grading (authoritative, server-side only)
  docs/         # architecture, deployment, DSL spec, feature lists, progress
  samples/      # sample MD documents (one set each for v1/v2), also parser regression fixtures
  e2e/          # Playwright E2E
```

## Quick start

### Development mode

Requirements: Node.js ≥ 24, pnpm 12.6.0.

```bash
pnpm install          # install dependencies
pnpm seed:demo        # optional: seed demo data (teacher / students / courses / answers)
pnpm dev              # start server (8787) and web (Vite, default 5173, /api proxied) in parallel
```

Open the Vite URL in your browser (default `http://localhost:5173`): the first launch walks you through a teacher setup wizard (pick a login name + password; the first teacher becomes the admin). From there you can create a course, add students, and import the sample documents in `samples/` to try the whole flow. For E2E, run `npx playwright install` first.

### Production deployment (details in [docs/部署.md](docs/部署.md))

Option 1: Docker Compose (recommended — Caddy reverse proxy and health checks included):

```bash
git clone https://github.com/LIziak112/simple-tutor-tool.git && cd simple-tutor-tool
mkdir -p data && sudo chown -R 1000:1000 data    # the container runs as the node user, uid 1000
docker compose up -d --build                     # open http://localhost in a browser (public IP on a cloud server)
```

Once a release tag is published, CI pushes the image to GHCR (`ghcr.io/liziak112/simple-tutor-tool`); if you'd rather skip a local build, a quick try works too:

```bash
docker run -d -p 8787:8787 -v ./data:/app/data ghcr.io/liziak112/simple-tutor-tool
```

Option 2: `pnpm build`, then `node apps/server/dist/index.js` kept running under systemd (see the deployment doc, §2).

Key environment variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8787` | Port the server listens on |
| `DATA_DIR` | `./data` | Data directory (tutor.db, blobs/, shared/, backups/, and secret.key all live here — back up this directory and you've backed up everything) |
| `PUBLIC_URL` | `http://localhost:8787` | Public-facing URL; when it's `https://`, Secure cookies and the PWA service worker are enabled |

For public deployments, we suggest turning off teacher self-registration in the admin panel (the registration endpoint is reachable anonymously, though it is IP rate-limited).

## Common commands

| Command | What it does |
| --- | --- |
| `pnpm dev` / `pnpm build` | Development (parallel) / full build |
| `pnpm test` / `pnpm e2e` | Unit tests (Vitest) / E2E (Playwright, Chromium + WebKit) |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Biome check / type check / format |
| `pnpm db:generate` | Generate database migrations after changing the Drizzle schema (never hand-edit a live database) |
| `pnpm schema:export` | Export the content contract as JSON Schema (re-run and commit after changing contract) |
| `pnpm gen:spec` | Generate `docs/dsl/规范.md` and `提示词模板.md` from the directive registry and refresh the JSON Schema (must run after changing the registry/lint/contract; CI verifies the generated files haven't drifted) |
| `pnpm tutor-lint <file or dir>` | Validate DSL documents; exits with code 1 on errors |
| `pnpm reparse [--dry-run]` | After a parser upgrade, re-extract structured fields from the source text stored in the database (question ids stay unchanged) |
| `pnpm seed:demo` | Seed demo data |

## Quality red lines

- **No answer leaks**: student-facing APIs never return the answer, worked solution, or hints of a question that hasn't been submitted; every new student-side endpoint must ship with a leak test (assertNoLeak).
- **Grading runs on the server only** (`packages/grading`); results coming from a client are never trusted.
- **Contract first**: data-structure changes start in `packages/contract`; the frontend and backend never each hand-write the same type.
- **DSL compatibility**: the historical samples in `samples/` are compatibility regression tests — after any change they must still parse and render identically.
- CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)): lint / typecheck / unit tests / gen:spec drift check / build / E2E must all pass before merge.

## Documentation index

| Document | Contents |
| --- | --- |
| [docs/技术架构与实施方案.md](docs/技术架构与实施方案.md) | Architecture decisions and the implementation blueprint (the authoritative document) |
| [docs/部署.md](docs/部署.md) | Deployment, backup and restore, multi-teacher setup, FAQ |
| [docs/页面功能清单.md](docs/页面功能清单.md) | Page-by-page feature specifications |
| [docs/项目最终愿景.md](docs/项目最终愿景.md) | Product positioning and vision |
| [docs/dsl/](docs/dsl/) | DSL spec, complete samples, and prompt templates for AI (generated by `pnpm gen:spec`, served at the `/spec` route) |
| [docs/进度表.md](docs/进度表.md) | Development task progress and acceptance records |
| [AGENTS.md](AGENTS.md) | Development working conventions (hard rules, equally binding on human and AI contributors) |

*Project docs are currently written in Chinese; an auto-translated read or a question in Discussions usually works fine.*

## License

[MIT](LICENSE) — use, modify, and deploy it freely. If it helps with your teaching, we'd love to hear about it: come back with an issue, or just tell us about your use case — that means more to us than a star.
