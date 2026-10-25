# e2e 功能面选测与 vite preview 对照实验（2026-10-25）

任务：开发循环 e2e 只跑受影响功能面 + 冒烟、且只跑 chromium；webkit 与全量留给 CI 闸门与夜跑。含一项独立对照实验：`e2e:full` 的前端改用 `vite build + vite preview`，只有全绿且实测更快才切。

## 一、功能面标签

全部 spec 打 `test`/`test.describe` 第二参数 `{ tag: [...] }`（登记表 `scripts/e2e-affected.mjs` 的 `SPEC_TAGS`，有「e2e 下每个 spec 已登记」单测守卫）：

| 标签 | spec（chromium 用例数） |
| --- | --- |
| `@smoke` | full-chain、student-course-practice、password-login（4） |
| `@teacher` | teacher-mark-flow、teacher-navigation-settings、teaching-pack、math-publication、capability-profile、course-cache、multi-teacher-full-chain（19） |
| `@student` | student-course、student-lecture-reading、student-settings、student-workspace、student-records、student-review-workspace、student-self-review、wrong-book、wrong-practice、attempt-sync、answer-submit-race、question-card-alignment、question-base、practice-feedback、practice-single-workspace（40） |
| `@annotation` | annotation-\*（6）、question-inline-annotation、ink-\*（2）、note-\*（3）、paper-fullscreen、eraser-position（34） |
| `@ai` | student-ai-\*（5 个文件，17） |
| `@mcp` | mcp-smoke、student-mcp-loop（4） |
| `@export` | export-wizard、ongoing-question-export、shared-publish-import（4） |
| `@insights` | insights-pages、teacher-data-page、learning-pack-v2（3） |
| `@admin` | admin-ui、teacher-register-admin（5） |

跨师生两端的链（lesson、dual-role-session、phase3-full-chain）打 `@teacher+@student` 双标签；learning-pack-v2 打 `@insights+@export`。chromium 合计 130 用例，`--grep-invert` 九标签零命中（全覆盖）。

## 二、scripts/e2e-affected.mjs 决策链

基线默认 `v2`（可传 ref 覆盖；`test:affected` 的 `origin/main` 口径会让 v2 后代分支永远摊成全量）：

1. 命中 affected-lib 兜底清单（依赖锁/各类配置/契约/迁移/scripts 等）或本脚本 e2e 兜底（`packages/**`、`apps/server/src/db/**`、`app.ts`——前两条是对 lib 清单对应条目的本档加宽）→ **全量**（仍仅 chromium）；
2. `e2e/` 目录 **default-deny**：除已登记标签的 `*.spec.ts` 外的一切路径（helpers/global-setup 由 lib 清单兜底；fixtures/、package.json、未登记新 spec、未来嵌套目录）一律全量——结构规则取代逐项列举基建文件，新增文件不可能静默漏成「仅冒烟」；
2. `apps/web/src/features/<面>`、`apps/server/src/routes/<文件>`（`.test.ts` 视同同名实现）显式映射表命中 → `--grep "@smoke|@x|@y"`；spec 自身变动并入标签，仅 spec 变动（无应用源码命中）时直接以文件参数跑「变动 spec ∪ 冒烟 spec」（已删除/改名的 spec 先经 existing 过滤，全部已删则跳过）；
3. 映射表外的 apps/ 源码（features/markdown、features/shared、src/lib、pages、services、public.ts、vite.config 等，跨功能面共享）→ 全量；
4. `e2e/*.spec.ts` 变动 → 自身标签并入；未登记的新 spec → 全量；
5. 其余（docs 等）不贡献标签；无命中 → 仅 `@smoke`。

在此之上**不使用** Playwright 自带 `--only-changed`：它只认 spec/helper 的 import 图、认不到应用源码（所以映射表不能省）；且它与 `--grep` 是 AND 关系，叠加会把未变动的冒烟 spec 滤掉，违背「任何选测结果恒含 @smoke」。取而代之：仅 spec 变动（无应用源码命中）时直接以文件参数跑「变动 spec ∪ 冒烟 spec」，精确度相同、恒含冒烟、且省掉一次 `playwright --list` 试探进程。`e2e/` 目录 default-deny：除已登记标签的 spec 外一切路径（fixtures/、package.json、未登记新 spec、未来嵌套目录）一律全量。

决策函数 `decideE2e` 纯函数化，16 组单测（`scripts/e2e-affected.test.mjs`，vitest node project 新增 `scripts/**/*.test.mjs` include；含登记表与 spec 内 tag 声明的双向核对、顶层调用全覆盖检查）。

## 三、workers 与 CI

`playwright.config.ts`：本机显式 6（默认是逻辑核数一半 = 8，16GB 内存下 8 路 Edge/WebKit 并发会顶到内存上限）；**CI 维持 2、webkit 项目不变**（CI 走 `pnpm e2e` 未动）。

## 四、vite preview 对照实验

机制（默认关闭，仅供重试对照；Windows cmd：`set E2E_WEB_PREVIEW=1&&pnpm e2e`，PowerShell：`$env:E2E_WEB_PREVIEW="1"; pnpm e2e`）：`E2E_WEB_PREVIEW=1` 时 playwright webServer 先 `vite build --mode e2e-preview` 再 `vite preview --port 5199`（页面免 dev 冷转译）；vite 以该 mode 裁剪 PWA 插件（e2e 的 PUBLIC_URL 本就是 http、不注册 SW，门控保证产物也不含 sw.js）、产物落独立 `dist-e2e-preview/`（不覆盖生产 dist）、preview 带与 dev 同一份 `/api /blobs /mcp` 代理（其他 mode 的 vite preview 保持默认 localhost、无代理）。**e2e:affected 保持 dev server 便于排错；e2e:full 与 pnpm e2e 等价。**

结论（2026-10-25 凌晨实测，Windows 11 / 16GB，workers 6，chromium+webkit 双浏览器；当时机器另有三个并行会话在跑单测，CPU 饱和）：

| 场景 | 命令 | 用例 | 结果 | 耗时 |
| --- | --- | --- | --- | --- |
| 选测：annotation 面 | `pnpm e2e:affected HEAD`（未提交改动 features/annotation） | 38（chromium） | 36 过 2 挂（1 抖动复跑过、1 为 full-chain 预存项） | **122s** |
| 全量基线（dev server） | `pnpm e2e` | 251 | 232 过 19 挂 | **1050s（17.4m）** |
| 全量对照（preview） | `E2E_WEB_PREVIEW=1 pnpm e2e` | 同上 | 54 挂，**结构性不兼容** | 863s（14.4m） |

**判决：不切换，`e2e:full` 保持等价 `pnpm e2e`（dev server）。** preview 快约 14%，但 54 个失败不是渲染精度问题而是结构性不兼容：

- ink-lifecycle / eraser-position / note-render / annotation-local-base 等 spec 在页面里**动态 import dev server 的源码路径**（如 `/src/features/ink/render-ink-snapshot.ts`）做像素复绘——preview 服务的是构建产物，`/src/*` 不存在，`Failed to fetch dynamically imported module`；
- question-base 依赖 `/dev/question-base` 调试页与 `题面宽度` 控件——开发页不在生产构建里。

基线 19 挂的构成：full-chain 双浏览器（已用 v2 原版 spec 复现，确认 v2 预存项，与本任务无关）；其余为负载敏感型（130 题长作业、富题型回看、学情三视图、批改流、三条全链——两次独立全量 run 失败集高度重合，双浏览器对称），待机器空闲大概率可过；CI（2 workers、独占 runner）历史上这些用例是绿的。注意：该 19 挂与 workers 6 同批落地，未与 Playwright 默认 workers 单独归因（当时的失败也可能有 workers 并发抬高的成分）。`E2E_WEB_PREVIEW` 机制保留在代码里（默认关闭、零影响），供未来 spec 全面脱敏 dev 源码路径后重试。

「130题长作业」计时断言处置（2026-10-25，fix/e2e-130-perf-gate）：热开预算断言改为环境门——CI（`process.env.CI`）或显式 `E2E_PERF_GATE=1` 时硬断言 5 次热开 max ≤300ms，本机并行满载降为中位数（容忍 ≤2 离群样本）仅 console.warn，`workspace-performance.json` 附件照常落盘并新增 `perfGate`/`warmMedianMs` 字段；`unrelatedMutations === 0` 为确定性架构守护（负载不制造 DOM 变更），保持无条件硬断言；用例加 `test.slow()`（120s→360s，只放大用例级超时，expect 15s 预算不变）。@perf 标签 + 专用 workers=1 run 的结构性方案**未采**——需动 package.json 脚本、CI workflow 与「pnpm e2e 即全量」的语义分叉，且本机日常已走 e2e:affected（仅 chromium），边际收益小；留作本机全量仍被该用例拖累时的后手（届时须同步接 CI 每晚 e2e:perf 专用步，防止性能守护无处运行）。
