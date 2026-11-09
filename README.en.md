# OwnClass · simple-tutor-tool

[![CI](https://github.com/LIziak112/simple-tutor-tool/actions/workflows/ci.yml/badge.svg)](https://github.com/LIziak112/simple-tutor-tool/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.en.md) · [简体中文](README.md)

**Your data. Your way. All for learning.**

OwnClass helps one-to-one tutors teach from their own computer or server. Import lesson materials and exercises, let students read and work in a browser, then review their answers, handwriting, corrections, and progress.

AI can help throughout a lesson. Tutors can use the supplied writing guide to prepare materials. Students can ask their chosen AI about a question and share their working. Tutors can review learning records with AI to prepare the next lesson.

Teaching materials, answers, and handwriting files stay on your server. When a student sends an AI request, the system shares the question context and selected materials with their chosen AI service under the tutor's teaching settings.

## Try it online

The demo provides sample courses and accounts for exploring the teaching workflow. Its data is reset periodically; sample materials are ideal for trying it out.

- **Student**: open the [personal link](http://47.116.99.166/s/L_N7GTSUpoWnxzR03laTsnzUP8lqpecS), or use the [student login page](http://47.116.99.166/s/login) with name `测试` and password `12345678`.
- **Tutor**: open the [teacher login page](http://47.116.99.166/t/login) with login name `demo` and password `12345678`.

Try answering a few questions as a student, then open the tutor's data and analytics pages to see the answers, original handwriting, and progress.

## What you can do

### Tutors: prepare materials, assign work, understand progress

- **Prepare teaching materials**: write in Markdown or give [dsl-kit/](dsl-kit/) to an AI tool to organize existing materials. Import question images alongside the text, check the preview, and confirm.
- **Organize courses and homework**: arrange lectures and practice units, assign students, and choose deadlines and answer-release times. Assign units separately or combine them into one assignment.
- **Grade and review the working**: inspect answers, scratchpads, question annotations, and corrections. Replay handwriting at different speeds and use keyboard shortcuts for continuous grading.
- **Follow learning progress**: view completion, accuracy trends, weak topics, time spent, and lecture reading activity to prepare the next lesson.
- **Review with AI**: export learning records and handwriting images, or connect a compatible MCP client to read records and save reports back to OwnClass.
- **Manage your data**: download a full backup and restore it with password confirmation. Teachers manage their own courses, students, and assignments, and can publish materials to a shared library.

### Students: read, write, ask, and try again

- **Start from a link**: use a tutor's personal link or sign in with an account on a computer, phone, or iPad browser.
- **Learn and practice together**: read a section, answer a question in place, and submit it for feedback. Written answers follow the tutor's grading workflow.
- **Write directly on the page**: annotate the question, use a scratchpad, or write an answer with Apple Pencil. Choose full-screen or split layouts and combine pen input with finger scrolling.
- **Ask AI about a question**: send the question, answer, and selected scratchpad or annotations. Read the reply, ask a follow-up, or return to the question to try a new step.
- **Review after submission**: compare the worked solution with your original, add a correction and reflection, inspect question history, and practice mistakes again.
- **Set your preferences**: open settings from your avatar to adjust writing feel, AI connections, and common question prompts.

## Recent updates

These highlights cover changes released from `v2` between **October 20 and November 9, 2026**.

### Practice, feedback, and corrections

- **Choose a practice rhythm.** Switch between a question list and single-question focus. When tutors allow per-question feedback, students can submit and review each answer as they go or see feedback together after handing in the attempt.
- **Compare and self-assess after submission.** On questions awaiting self-assessment with a reference answer, students can mark their answer correct, incorrect, or leave it undecided. Corrections preserve the submitted original. Students can filter the mistake notebook and choose questions to retry, and tutors can decide whether homework may be redone.
- **Find your place again.** In-progress records show how many questions have been answered, and published results can show how many were correct. Course catalogs support nested folders and search.

### Handwriting and process replay

- **One toolbar for scratch work and annotations.** Keep the question, shared materials, and scratchpad in the same workspace, with side-by-side, stacked, and full-screen layouts. When a PWA update is available, students can save their answers and ink before updating.
- **Question process replay pilot for regular course practice.** With `QUESTION_PROCESS_ENABLED=1`, students can opt in for an attempt or delete its process record. Tutors can replay annotations, scratch work, answer changes, and hint-opening events on one timeline. Pilot records are kept for 30 days.

### AI and MCP

- **Whole-attempt AI review.** Once an attempt is submitted, answers are released, and the teaching policy permits AI access for every question, students can preview and confirm a request for one report from their MCP client. Per-question reviews remain available from the results page.
- **Per-question submission through student MCP.** Students can confirm and submit individual questions in eligible regular practice. Tutor MCP can filter practice records by start time and correct unsubmitted questions in draft attempts, subject to permission and version checks.

## Content and learning options

### Four content formats

| Content | File setting | Use it for |
| --- | --- | --- |
| Lecture | `kind: lecture` | Explanations, formulas, collapsible examples, step-by-step reveals, and function plots. |
| Practice | `kind: practice` | Question banks and worksheets: true/false, single choice, multiple choice, fill-in, calculation, application, and error-finding. |
| Lecture with companion practice | `kind: mixed` | One file that imports as lectures and linked practice units. |
| Integrated lesson | `kind: lesson` | Questions placed within a lecture, answered and submitted individually. |

Students learn through assigned homework, course practice, mistake redos, and integrated lessons. Homework releases answers at the tutor's chosen time; integrated lessons provide feedback per submitted question. Attempts and submitted originals have separate records.

### Three student AI connections

| Connection | How it works |
| --- | --- |
| In-page AI | Enter a compatible API address, model, and personal API key in AI settings, then ask and read below the question. |
| MCP client | Copy the complete MCP configuration into a compatible AI client, which claims question tasks and sends replies back. |
| Question link | Share a link containing the question and selected materials with an AI that can read web pages. Set an expiry time or revoke the link. |

Tutors choose open study, guided hints, or help after completion, with individual student and assignment settings. Guided mode gives the AI the reference answer and explanation and asks it to teach through hints. Tutors who want AI help to begin after completion can select that timing. Completed questions use review-style guidance.

AI requests share the current question context and selected materials. Ordinary practice pages follow the answer-release rules. Anyone holding a question link can read its contents, so share it with a trusted AI service. In-page AI charges follow the student's chosen provider; multi-question reviews make a separate call for each question. See the [student AI guide](docs/学生端AI伴学/使用指南.md) for setup and teaching settings.

## Get started

### Requirements

- Node.js 24 or newer.
- pnpm 12.6.0; Docker installations use Docker Engine and Compose.

### Windows

Run `pnpm install` in the project folder, then choose a script:

- **测试模式.cmd** starts development services at `http://localhost:5173`, with the API on port `8787`. Students on the same Wi-Fi can use the computer's local IP address.
- **启动服务.cmd** builds and starts the production service at `http://localhost:8787`.

### Command line

```bash
pnpm install
pnpm dev
```

On the first visit, follow the tutor setup wizard to create the admin account. After the database is initialized, `pnpm seed:demo` adds sample courses and students. The terminal prints a random initial password for the demo tutor; sample student passwords are `demo-pass-123`.

### Server deployment

Docker Compose:

```bash
git clone https://github.com/LIziak112/simple-tutor-tool.git
cd simple-tutor-tool
mkdir -p data
sudo chown -R 1000:1000 data
docker compose up -d --build
```

Open `http://your-server-address` after startup. Alternatively, run `pnpm build` on the host and manage `node apps/server/dist/index.js` with systemd. See the [deployment guide](docs/部署.md).

**Use prebuilt artifacts on low-memory servers.** Build and verify them on a build machine, then upload them. Stop the service, back up the full data directory, switch artifacts, restart, and check service health. See the [artifact deployment procedure](docs/部署.md#01-现有云服务器的日常部署).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Server port. |
| `DATA_DIR` | `./data` | Database, handwriting, shared materials, backups, and session key. |
| `PUBLIC_URL` | `http://localhost:8787` | Actual public address; HTTPS enables secure cookies and PWA features. |

Use the tutor's backup settings to download a complete backup. Stop the service before manually copying the data directory.

## A daily teaching workflow

1. Give [dsl-kit/](dsl-kit/) to an AI tool to prepare a lecture or worksheet; import it, review the preview, and confirm.
2. Create a course, add students, arrange materials, and assign homework as needed.
3. Share personal links so students can read, answer, write, and ask AI for help.
4. Review the working, grade written answers, and choose corrections and further practice.
5. Export a learning pack or connect a tutor MCP client to review records and prepare the next lesson.

## Technology and development

The project uses a pnpm workspace. Shared Zod schemas define content and API formats for the frontend, backend, MCP, and exports.

| Area | Technology |
| --- | --- |
| Frontend | React 19, Vite, Tailwind CSS v4, shadcn/ui, TanStack Query, Zustand, React Router, CodeMirror, KaTeX, MathLive. |
| Handwriting and images | Atrament, Excalidraw, html-to-image. |
| Backend | Node.js 24, Hono, SQLite, better-sqlite3, Drizzle ORM, pino, MCP SDK. |
| Checks and tests | TypeScript strict, Vitest, Playwright (Chromium / WebKit), Biome, GitHub Actions. |
| Deployment | One Node process serves the web app and APIs; systemd or Docker + Caddy. |

```text
apps/web/           Student, tutor, and admin pages
apps/server/        APIs, MCP, static files, and database
packages/contract/  Shared data definitions and capability registry
packages/md-dsl/    Markdown parser, checks, and spec generation
packages/grading/   Server-side grading
samples/            Teaching examples and compatibility fixtures
dsl-kit/            AI writing guide, examples, prompts, and checking tools
docs/               Usage, deployment, design, and verification records
e2e/                Browser tests
```

| Command | Purpose |
| --- | --- |
| `pnpm dev` / `pnpm build` | Start development / build. |
| `pnpm test:quick` / `pnpm test:affected` | Select unit tests for development checkpoints / final validation. |
| `pnpm e2e:affected` | Local Chromium feature tests plus smoke coverage. |
| `pnpm test` / `pnpm e2e` | Full unit / dual-browser end-to-end suites, run by PR CI. |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Code checks / type checks / formatting. |
| `pnpm db:generate` | Generate database migrations. |
| `pnpm schema:export` | Export JSON Schema. |
| `pnpm gen:spec` | Generate the DSL spec and refresh dsl-kit and its standalone checker. |
| `pnpm tutor-lint <file-or-directory>` | Check teaching material syntax. |
| `pnpm reparse [--dry-run]` | Extract question and lecture fields using the current parser; `--dry-run` previews the result. |
| `pnpm seed:demo` | Generate demo data. |

Development starts with shared contracts. Grading runs on the server, student content follows submission and release rules, and AI requests follow the teaching policy. Existing samples provide compatibility coverage. Follow the [verification guide](docs/约定/工程验证说明.md) for local test selection, including automatic full-suite fallbacks. PR CI selects affected tests and builds application changes; infrastructure changes, main pushes, scheduled and manual runs retain full regression. Documentation-only PRs skip application jobs. Do not duplicate CI locally. Required generated-spec checks still apply. See [AGENTS.md](AGENTS.md) for agent execution and handoff rules.

## Documentation

| Document | Contents |
| --- | --- |
| [Documentation index](docs/README.md) | Documentation and directory map. |
| [Page feature guide](docs/页面功能清单.md) | Current features by page. |
| [Student AI guide](docs/学生端AI伴学/使用指南.md) | Tutor settings, student connections, help, and review. |
| [Deployment guide](docs/部署.md) | Installation, upgrades, backup, and operations. |
| [DSL spec and examples](docs/dsl/) | Teaching material format and complete examples. |
| [AI material kit](dsl-kit/) | Writing guide, prompts, and checking tools. |
| [Architecture](docs/技术架构与实施方案.md) | Architecture decisions and implementation. |
| [Progress and verification](docs/进度表.md) | Development milestones and checks. |

## License

[MIT](LICENSE). Share teaching scenarios, feedback, and suggestions through Issues.
