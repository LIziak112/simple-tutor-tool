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

These highlights cover **October 10–19, 2026**, grouped by feature. Dates show when each area received its main updates.

### Ask AI, read the feedback, and keep working · October 15–19

- **Three ways to ask**: connect a personal AI API, use an MCP client, or generate a question link for an AI with web access. The result page also supports selecting several questions for separate AI reviews.
- **Tutor-controlled timing**: choose open study, guided hints, or help after completion, with settings for individual students or assignments. Tutors can view help and reply records.
- **Replies under the question**: ask and read beside the relevant work. Wide screens offer an optional pinned comparison view, and focused reading provides more room for a reply.
- **Ready-to-send prompts**: choose how to ask and send, optionally adding your own words. Your text stays in place as you choose prompts. Review the question, answer, and selected materials before sending.
- **Return and try a step**: jump back to the original position, add some working, and send fresh materials or written steps for a check. Follow-ups on an earlier reply keep using the materials originally sent.
- **Keep your place**: question drafts survive switching questions, closing the conversation, and a visit to connection settings during the current page session. New replies arrive as a notification so students choose when to read them.
- **Read longer replies comfortably**: use headings, quote a step in a follow-up, enter focused reading, and view typeset formulas. Longer content also offers reading in plain-text sections.
- **Reopen the right conversation**: help records lead to the matching question and task so students can continue reading or working.

### Read a section, practice a question · October 13–16

- **Integrated lessons are available**: tutors place questions at the relevant point in a lecture, and students submit each question separately.
- **Feedback per question**: objective questions provide immediate results and worked solutions; written answers enter grading. Submitting the last question completes the attempt.
- **Clearer course entries**: each integrated lesson appears as one course item, with its embedded questions inside. Import previews present it as one lesson too.
- **Learning records follow the work**: question progress, answers, and handwriting originals stay available for later review and another practice attempt.

### Scratchpads, annotations, and handwriting together · October 10–19

- **Use annotations and a scratchpad together**: circle a condition while calculating; choose side-by-side, stacked, or full-screen working.
- **Scale the question and ink together**: saved annotations retain the question layout for proportional display during review and across devices.
- **Clearer saving and device changes**: answers, scratchpads, written answers, and annotations each have saving status. Returning on another device checks existing materials, with a version choice when the same material has competing edits.
- **Export a question and its working**: include the question, existing annotations, and handwritten materials. Long work spans pages with a repeated question, with download and per-page copy options.
- **Save a preferred writing feel**: name configurations and choose one for the current device. Scratchpads, written answers, and corrections share that device choice.
- **Smoother writing in long assignments**: reopening annotations is faster, and other questions stay steady while saving and AI status updates arrive.
- **Smoother opening and review**: improvements cover material loading, annotation preparation, and repeated layout work. Original annotations load as the question comes into view.

### Assignments, review, and personal settings · October 10–19

- **A home page focused on pending work**: see the latest two pending assignments and the total count. My Assignments offers status, date, and title filters with pagination and remembers them on return.
- **A simpler phone header**: back, unit title, and more actions stay at the top; saving status and practice details live in the practice information panel.
- **Review actions together**: worked solution, original, correction, question history, and more actions share one row, with a return to the original question from history.
- **AI connections in one place**: start from My Connections, then add, view, or edit a connection. MCP details provide the complete configuration, token, and endpoint for copying.
- **Settings grouped by purpose**: personal information, learning preferences, and AI help preferences share one settings page. Collapsing an editor preserves the current input.

### Tutor workspace and everyday details · October 12–19

- **OwnClass styling**: tutor and admin pages share the brand and indigo theme. Navigation groups teaching, analytics, and system tools, with a drawer on smaller screens.
- **Settings by category**: teaching, backup, and account settings have separate sections, with reminders when leaving edited settings.
- **Safer consecutive saves**: each save advances the settings version. An older page receives a refresh prompt while the latest saved settings stay in place.
- **Fresh course choices**: creating or changing a course refreshes the import page's course selector.
- **Smoother account changes**: tutor and student sessions can coexist in one browser; switching accounts refreshes the relevant page data.
- **More complete formula display**: improvements cover formula checking, annotation fonts, and formulas in exported images.

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

**On a small-memory server, stop the existing service before installing dependencies and building. Start it again after the build and check its health.** Back up the full data directory before an upgrade. Stop systemd with `systemctl stop simple-tutor-tool`, or Docker Compose with `docker compose stop app`.

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
| `pnpm test` / `pnpm e2e` | Unit tests / browser end-to-end tests. |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Code checks / type checks / formatting. |
| `pnpm db:generate` | Generate database migrations. |
| `pnpm schema:export` | Export JSON Schema. |
| `pnpm gen:spec` | Generate the DSL spec and refresh dsl-kit and its standalone checker. |
| `pnpm tutor-lint <file-or-directory>` | Check teaching material syntax. |
| `pnpm reparse [--dry-run]` | Extract question and lecture fields using the current parser; `--dry-run` previews the result. |
| `pnpm seed:demo` | Generate demo data. |

Development starts with shared contracts. Grading runs on the server, student content follows submission and release rules, and AI requests follow the teaching policy. Existing samples provide compatibility coverage. Before merging, run lint, type checks, unit tests, generated-spec checks, builds, and browser tests. See [AGENTS.md](AGENTS.md) for the project workflow.

## Documentation

| Document | Contents |
| --- | --- |
| [Page feature guide](docs/页面功能清单.md) | Current features by page. |
| [Student AI guide](docs/学生端AI伴学/使用指南.md) | Tutor settings, student connections, help, and review. |
| [Deployment guide](docs/部署.md) | Installation, upgrades, backup, and operations. |
| [DSL spec and examples](docs/dsl/) | Teaching material format and complete examples. |
| [AI material kit](dsl-kit/) | Writing guide, prompts, and checking tools. |
| [Architecture](docs/技术架构与实施方案.md) | Architecture decisions and implementation. |
| [Progress and verification](docs/进度表.md) | Development milestones and checks. |

## License

[MIT](LICENSE). Share teaching scenarios, feedback, and suggestions through Issues.
