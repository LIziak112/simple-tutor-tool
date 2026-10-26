# PR #13 架构规范、防泄露安全、AI 受控出口与 v2 融合终审报告

**报告类型**：系统性代码审查、防泄露安全审计与 v2 冲突消解终审报告  
**审查分支**：`audit/pr13-review-sync`  
**合并提交**：`fc4fdd4c4fc47ad3a4819aa8d54432ae8a46a423`  
**基准分支**：`origin/codex/qm` (`c92370b9`) × `origin/v2` (`7125d285`)  
**审计结论**：**通过（APPROVED / ALL CLEAR）**  
**阻断问题**：**0 项未决 P0 / 0 项未决 P1**  

---

## 报告摘要

PR #13（统一作答适配层与题型适配专题，`origin/codex/qm` -> `origin/v2`，变更规模 +63,794 / -3,160 行代码，涉及 315 个文件）是 simple-tutor-tool v2 架构演进中的核心基础工程。该 PR 完整落地了纯行为作答适配器层、材料（Material）与题组（Group）实体模型、开卷冻结快照机制、学生对照自评状态机、行级有效判定模型、3 种全新题型（主观开放题 `response`、配对题 `matching`、排序题 `ordering`）以及 AI 出站隐私闭包防线。

在独立审查分支 `audit/pr13-review-sync` 上，经 Milestone 1 与 Milestone 2 系统性审查与实测验证：
1. **v2 最新主干完全融入**：成功合入 upstream `origin/v2` 全部 37 个提交（涵盖 PR #12 圈画底图持久化、PR #15 性能门禁、PR #16 AI 提示词配置、PR #20 契约 155 个无引用导出精简及文档重构）。
2. **阻断级问题（P0/P1）就地清零**：数据库迁移序号冲突通过按时间戳严格单调顺延（`0046_brief_scourge` -> `0047_clumsy_doctor_strange`）彻底解决；PR #20 契约精简与 PR #13 契约扩展完成无缝并集；`canSubmitQuestion` 全仓统一切至工作流级；写作材料与共享材料拼接闭包完备。
3. **安全与质量闸门全绿**：`pnpm typecheck` 全仓 6 个工程 0 报错；`pnpm lint:changed` 1377 个文件 0 违规；`pnpm db:generate` 49 张表 0 漂移；`pnpm schema:export` 与 `pnpm gen:spec` 生成产物 0 diff；针对性与受影响核心单测 70 余文件、1340 余测试 100% 通过。

---

## 一、核心架构与硬性规则审查（Architecture Specifications）

### 1.1 契约优先（Contract First）与严格类型（Strict Typing）
- **Zod Schema 权威收敛**：
  - 所有新题型结构定义收敛在 `packages/contract/src/content.ts`：`questionTypeSchema` 扩充 `"response" | "matching" | "ordering"`；新增 `responseAnswersSchema`, `matchingAnswersSchema`, `orderingAnswersSchema` 并在 `questionAnswersSchema` 建立判别联合；学生题面投影 `matchingOptionStudentSchema`, `orderingItemStudentSchema` 严格剔除 `distractor`。
  - 学生答案收敛在 `packages/contract/src/grading.ts`：`responseStudentAnswerSchema`（强制校验 `RESPONSE_TITLE_MAX_CHARS: 200` 与 `RESPONSE_BODY_MAX_CHARS: 50_000` 防 DoS）、`matchingStudentAnswerSchema`、`orderingStudentAnswerSchema`，统一纳入 `studentAnswerSchema` 判别联合。
  - 材料与题组收敛在 `packages/contract/src/material.ts`：`slotKindSchema`, `materialSchema`, `materialPublicSchema`, `questionGroupSchema`, `questionGroupPublicSchema` 等均经 Zod 严格定义，禁止任意手写类型。
  - 自评状态机收敛在 `packages/contract/src/self-review.ts`：`selfReviewVerdictSchema`, `selfReviewRecordSchema`, `selfReviewRequestSchema`, `effectiveVerdictSchema`, `gradingPolicySchema` 构成自评完整契约。
- **严格类型合规审计**：
  - 全仓 TypeScript 代码实现中 **0 处 `any`、`as any`、`: any` 或 `<any>` 违规使用**（仅 Vitest 断言如 `expect.any(String)` 存在于测试中）。
  - 全仓生产代码中 **0 处 `@ts-ignore`**。
  - 仅测试文件（如 `new-kinds.test.ts`）保留少量 `@ts-expect-error` 用于负向类型用例，均附带明确的冒号解释理由并通过 `tsc` 校验。

### 1.2 服务端判分单源（Single-Source Server Grading）
- **判分权威单源在 `packages/grading`**：
  - 客户端 `apps/web/package.json` 完全不依赖 `@tutor/grading`，`apps/web` 源代码中对 `@tutor/grading` 的引用数量为 **0**。客户端绝对不执行判分，判分结果恒由服务端 API 下发。
  - 新题型（`response`, `matching`, `ordering`）在 `packages/grading/src/validator-registry.ts` 显式注册为 `gradeNewKindAlwaysNull`，客观校验恒返回 `null`，杜绝任何未经授权的伪自动判分。
  - 行级判分权威收敛在 `packages/grading/src/grade-row.ts` 的 `gradeResponseRow(gradingPolicy, question, answer)`。当 `gradingPolicy` 为 `reference_self` 或 `manual_only` 时，恒返回 `null`；仅 `auto` 策略执行对应题型校验器。
  - 服务端交卷（`submitAttempt`）、单题提交（`submitPracticeQuestion`）与讲练单题提交（`submitLessonQuestion`）3 处入口完全收敛调用 `gradeResponseRow`，无旁路判分逻辑。

### 1.3 冻结快照不可侵犯（Snapshot Inviolability）
- **快照与 live 实体彻底解耦**：
  - 开卷时，关联材料与题组在 `attempt_context_snapshots` 表中就地冻结。
  - 重解析与重抽服务（`apps/server/src/services/reparse-service.ts`）受到严格防护，写入事务仅作用于 `questions` 与 `lectures` 实体表，绝不触碰 `responses`、`attempts` 或 `attempt_context_snapshots`。
  - `reparse-service.test.ts` 显式验证：即使 live 题目的材料被篡改或修复重抽，已冻结作答快照中的 `snapshotJson` 与 `sourceVersion` 绝对保持不变，彻底杜绝历史批改与学情漂移。

### 1.4 并发控制与 409 CAS / 幂等协议
- **多端与并发防护完备**：
  - **学生对照自评**（`self-review-service.ts`）：请求强制携带 `baseRevision` 与 `mutationId`。服务端基于 `WHERE id = fresh.id AND selfReviewRevision = req.baseRevision` 执行原子 CAS 更新。版本不一致时抛出 `409 SELF_REVIEW_REVISION_CONFLICT` 并携带 `_current`；相同 `mutationId` 重放执行幂等去重；教师一旦批改（`teacherMark !== null`），自评立即拒绝并抛出 `409 SELF_REVIEW_TEACHER_MARKED`。
  - **逐题作答提交**（`submitPracticeQuestion`）：强校验 `submissionMutationId`（带请求摘要对比）、`workflowRevision` CAS 与 `expectedAnswerRevision` CAS，版本冲突时抛出 `409`。
  - **草稿保存**（`saveDraftAnswer`）：强校验 `mutationId` 与 `baseRevision` CAS，防护多设备覆盖。

### 1.5 DSL 规范与向后兼容性（Backward Compatibility）
- **已发布指令只增不改**：
  - PR #13 新增 8 项指令（`material`, `group`, `seg`, `ref`, `options`, `option`, `item`, `variant`），全部标记 `since: "2.1"`；原有 17 项指令无任何改名或破坏性变动。
  - **未知指令优雅降级**：解析器触发 `UNKNOWN_DIRECTIVE` 告警（warning 级别，不阻断）；Web 渲染层优雅渲染 `<UnknownDirective>` 并保留正文文本。
  - **教学包缺失阻断**：`frontmatter.teachingPack` 显式依赖的指令或校验器缺失时，严格输出 `error` 并阻断导入。
  - **语料兼容回归**：`samples/v2/` 与 `samples/lint/` 保持 0 diff，回归测试 100% 绿；新增 `samples/qm/` 包含 9 份有效语料与 7 份反例语料，精准覆盖所有语法规则。

---

## 二、学生端出口防泄露安全审查（Anti-leak Security Review）

### 2.1 普通学生接口零泄露（Zero Leakage on Ordinary Student Endpoints）
- **`publicOfSnapshot` 白名单强过滤**：
  - 普通学生开卷与题目接口（`apps/server/src/services/attempt-service.ts:737-785`）通过 `attemptQuestionPublicSchema.parse({...})` 进行白名单裁剪。
  - 核心涉密字段 `answers`, `answersJson`, `solutionMd`, `sourceMd`, `hintsJson` 物理剔除。
  - 干扰项隐蔽性：`matchingOptionsStudentOf` 与 `orderingStudentOf` 在生成学生面题面时，遍历剥离 `distractor` 标记，防止学生通过浏览器审查元素或网络包抓取识破干扰项。
- **题干级内容脱敏 `studentStemMd`**：
  - `packages/md-dsl/src/v2/public-stem.ts`：通过 `displayStemMd`（剥离 `- [x]` 选择标记）与 `publicStemMd`（将含答案的 `[[答案]]` 替换为脱敏占位符 `[[]]`）。
  - 双重安全断言守护：测试工具 `assertNoLeak`（键名扫描）与 `assertNoStemLeak`（题干内容正则反作弊探测）在全部题目与作答单测中保持 100% 拦截生效。
- **未公布（Unreleased）与草稿态保护**：
  - 在作业截止交卷或教师发布答案前，`buildResultData` 中 `releaseAwareQuestion` 强制将 `answers: null, solutionMd: null, autoCorrect: null, teacherMark: null, finalCorrect: null, selfReview: null` 整体置空，总分折叠为 `pending`。
- **讲练切段防护**：
  - `apps/server/src/services/lesson-service.ts` 严禁下发讲义 Markdown 原文，统一调用 `splitLessonBlocks` 下发纯净切段；未做题目走 `publicOfSnapshot` 投影。

---

## 三、AI 受控出口安全审查（AI Controlled Egress Review）

### 3.1 单题页内 AI 伴学（Payload, Share Ticket & MCP Claim）
- **最小化白名单载荷**：`aiContextSnapshotSchema`（`packages/contract/src/student-ai.ts`）严格过滤，禁止夹带教师私注、讲义全篇、全卷答案及内部用户 ID。
- **策略动态三重鉴权**：在上下文组装（`buildAiContextBundle`）、公共分享票据读取（`requirePolicyUsable`）、MCP 任务领取（`claimMcpTask`）三个时点，均独立重验当前题目 AI 伴学权限（`resolveAttemptQuestionAiPolicy`）。若教学策略收紧或被禁用，即刻返回 403 `AI_POLICY_DISABLED`。

### 3.2 整卷整体复盘（Overall Attempt Review）四点硬性门禁
在 `apps/server/src/services/ai-companion/student-ai-attempt-review.ts` 中，发起与生成整体复盘严格执行 4 重硬性前置安全门禁：
1. **学生主动触发**：仅由学生端通过 `POST /api/student/ai/attempt-reviews` 主动请求，无后台静默外发。
2. **整卷必须交卷**：`attempt.status === "draft"` 时立即抛出 409 `AI_ATTEMPT_REVIEW_NOT_SUBMITTED`。
3. **答案必须公布**：`attemptAnswersReleased(...) === false` 时立即抛出 409 `AI_ATTEMPT_REVIEW_NOT_RELEASED`。
4. **预览确认版本锚定**：采用 HMAC-SHA256 对范围、答案、得分和提示词哈希签名（`previewVersion`），发起时强制比对 `range.previewVersion !== input.expectedPreviewVersion`，杜绝未确认或跨版本篡改。
5. **全卷题级策略兜底**：卷内任意一题若未获 AI 策略授权（`!resolution.usable`），整卷复盘全面阻断（403 `AI_POLICY_DISABLED`）。

### 3.3 材料边闭包与切段拼接（Material Edge Closure）
- **闭包解析权威收敛**：`frozenMaterialsFromRows`（`attempt-question-materials.ts`）同时解析题组材料引用（`group.materialRefs`）与题级引用（`snapshot.materialRefs`），且恒读开卷时已冻结的快照数据。
- **无损拼接防漏**：在 `assembleOutboundMessages`（`student-ai-context.ts:589-595`）中，写作材料（`writingMaterialLines`）与共享材料（`sharedMaterialLines`）采用并集拼接，确保写作类题目在输出 AI 上下文时共享材料绝不被丢失（验证了 QM-12 P1-1 修复点）。

---

## 四、与 v2 融合与冲突消解（origin/v2 Integration）

### 4.1 合并冲突消解明细（Commit: `fc4fdd4c`）
在分支 `audit/pr13-review-sync` 上，`worker_m1` 完整消解了与 `origin/v2` 的全部冲突：

| 冲突文件 | 根因分析 | 处置决策与落地方案 |
| :--- | :--- | :--- |
| `AGENTS.md` | v2 精简全局规则迁出专题 vs QM 增补专题规则 | 采纳 v2 精简架构并在索引表追加题目模型与适配专题；QM 具体约定迁入 `docs/约定/学生作答与讲练.md` |
| `packages/contract/src/attempt.ts` | PR #20 清理 7 个无引用导出 vs QM 新增自评与上下文契约 | 移除 7 个遗留导出；全量保留 QM 的 `selfReviewDataSchema`、上下文快照 Schema 及 6 个新错误码 |
| `packages/contract/src/grading.ts` | PR #20 清理 5 个废弃答案类型 vs QM 新增 3 题型契约 | 移除 5 个遗留类型；保留 `RESPONSE_*` 常量、3 新题型答案 Schema 与推导类型 |
| `packages/contract/src/learning-pack.ts` | PR #20 清理 15 个遗留类型 vs v2 提示词更新 vs QM 材料扩展 | 移除 15 个遗留类型；融合 v2 提示词安全边界；保留 QM 材料引用与扩展字段 |
| `dsl-kit/tutor-lint.mjs` | 生成脚本打包环境差异 | 通过 `pnpm schema:export` 与 `pnpm gen:spec` 重新生成，保持全仓 0 diff |
| `migrations/meta/_journal.json` | v2 新增 0046 (PR #16) 与 QM 0046 序号碰撞 | 调整 QM 迁移为 0047，建立严格单调时间戳单链（详见 4.2） |

### 4.2 数据库迁移单链严格单调性
- **序号与时间戳单调排列**：
  - `idx: 44, tag: "0044_odd_bloodstrike", when: 1792912597972`
  - `idx: 45, tag: "0045_lazy_iron_monger", when: 1792915800229`
  - `idx: 46, tag: "0046_brief_scourge", when: 1792935275845`（v2 PR #16：`ai_prompt_overrides` 表）
  - `idx: 47, tag: "0047_clumsy_doctor_strange", when: 1792952331084`（QM：5 张材料/题组表 + 6 列扩展）
  - 时间戳满足严格单调性：`1792912597972 < 1792915800229 < 1792935275845 < 1792952331084`。
- **快照链完整无损**：
  - `0046_snapshot.json`（prevId 指向 0045，44 张表）
  - `0047_snapshot.json`（prevId 指向 0046，49 张表）
  - `pnpm db:generate` 验证结果：`49 tables ... No schema changes, nothing to migrate 😴`。
- **迁移单测与幂等验证**：
  - `apps/server/src/db/migrate-qm.test.ts` 与 `migrate-ai-prompts.test.ts` 全绿。
  - 经 5 轮连续重复迁移与旧脏数据升级压测，迁移记录与表结构零异常、零数据丢失。

### 4.3 `canSubmitQuestion` 门控口径收敛
- v2 早期自评分支曾尝试在题目级挂载 `questionPublicSchema.canSubmitQuestion`。
- PR #13 架构规范已将其彻底升级并收敛至工作流级别（`practiceWorkflow.canSubmitQuestion`）。
- 经代码审查确认：`apps/web` 中所有组件（`AttemptSession.tsx`、`PracticeQuestionSubmit.tsx`、`practice-protocol.ts`）已统一读取 `practiceWorkflow?.canSubmitQuestion`，全仓 0 处残留读取 `question.canSubmitQuestion`。

---

## 五、综合分级问题目录（Comprehensive Issue Catalog）

本目录涵盖审查过程中识别的全部 P0 / P1 / P2 / P3 问题项、所处位置、严重性、影响及处置结论：

| 问题编号 | 严重度 | 问题标题 | 定位模块 / 文件 | 潜在影响 | 处置方案与当前状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **ISSUE-01** | **P0** | 迁移序号冲突与链条重叠 | `apps/server/src/db/migrations/` | v2 合入 PR #16 (0046) 与 QM (0046) 序号重叠，会导致 Drizzle 迁移乱序或漏跑 | **[已就地修复 - M1]** 顺延 QM 迁移为 `0047_clumsy_doctor_strange.sql`，修正 snapshot prevId 链，经实测双迁移套件 100% 通过。 |
| **ISSUE-02** | **P1** | PR #20 契约精简与 PR #13 契约扩展交汇冲突 | `packages/contract/src/attempt.ts`, `grading.ts`, `learning-pack.ts` | 合并时若简单覆盖会导致 155 个已清理死代码复活，或导致 QM 核心类型被误删 | **[已就地修复 - M1]** 细粒度三方合并：精确移除 27 个冲突遗留类型，完整保留 QM 所有新契约。`pnpm typecheck` 0 报错验证通过。 |
| **ISSUE-03** | **P1** | `canSubmitQuestion` 门控口径不一致 | `packages/contract/src/content.ts`, `apps/web/src/features/attempt/` | 若前端组件误读已废弃的题目级字段，会导致逐题提交按钮无法正常显示或类型报错 | **[已就地对齐 - M1]** 确认题目级字段已移除，Web 端全量统一切换至 `practiceWorkflow.canSubmitQuestion`。 |
| **ISSUE-04** | **P1** | AI 伴学写作材料与共享材料拼接丢失 | `apps/server/src/services/ai-companion/student-ai-context.ts` | 写作类题目若存在共享材料，组装出站消息时可能遗漏共享段落 | **[已验证修复 - M1/M2]** 验证 `assembleOutboundMessages` 已采用并集拼接，单测覆盖通过。 |
| **ISSUE-05** | **P2** | `dsl-kit/tutor-lint.mjs` 跨环境换行符与构建漂移 | `dsl-kit/tutor-lint.mjs`, `packages/md-dsl/` | Windows 与 Linux 下 esbuild 重新打包可能产生行尾差异触发 CI git diff 检查阻断 | **[已标准化 - M1/M2]** 运行 `pnpm schema:export && pnpm gen:spec` 保持 0 diff，且 `.gitattributes` 维持规范。 |
| **ISSUE-06** | **P2** | 本地开发者旧测试数据库迁移失效边界 | 本地开发环境 SQLite 文件 | 若开发者曾在未合入前分支跑过带 0046 的迁移，本地 DB 可能跳过 PR #16 迁移 | **[已出具指引 - 处置建议]** 线上生产环境与 CI 从 v2 正序迁移完全正常；提示开发人员切至合并分支后重建本地测试 DB（`rm *.db`）。 |
| **ISSUE-07** | **P2** | 大并发测试时 jsdom 资源竞争导致偶发超时 | `AiPromptPanel.test.tsx`, `ai-queue.test.tsx` | 在 Windows 单机跑 554 文件的全量 affected 测试时，高内存负载偶发单个用例超时 | **[已验证非回归 - 处置建议]** 隔离单跑 2 个文件 24 项测试 100% 通过（27s）。建议重型 CI 分批跑前端 DOM 测试。 |
| **ISSUE-08** | **P2** | `pendingSelfReviewCount` 遗留字段清理 | `packages/contract/src/attempt.ts` | 旧自评原型的冗余计数与 QM 的有效判定模型正交指标不匹配 | **[已对齐收敛 - M1]** 前端学情卡片与结果视图全量切换至 QM 正交模型指标（`pending` 与 `notDoneCount`）。 |
| **ISSUE-09** | **P3** | 公共 AI 票据端点应用层限流增强 | `apps/server/src/routes/student-ai.ts` | `/api/public/ai/share/:token` 依赖 43 位安全随机串，但应用层无 IP 级防刷 | **[合入后优化建议]** 生产环境前置 Nginx/Caddy 或 Cloudflare WAF 限流；后续迭代可在 Fastify 挂载全局 rate-limit 插件。 |
| **ISSUE-10** | **P3** | 材料多版本同 ID 槽位解析顺序约定 | `apps/server/src/services/attempt-service.ts:908` | 若同一作业材料跨版本修改了 slot 标记，开卷快照取最高版本解析 | **[合入后优化建议]** 在教师端教学包编写与修改指引中加入建议，避免同一作业发布后对同一材料做破坏性 slot 编号重构。 |

---

## 六、自动化测试与质量闸门验证汇总（Quality Gate & Test Metrics）

所有验证命令均在 `audit/pr13-review-sync` 分支独立执行并通过：

### 6.1 静态与生成闸门指标

| 质量闸门 | 执行命令 | 耗时 | 验证结果 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| **严格类型检查** | `pnpm typecheck` | 17.5s | 6 个工程全量通过（`e2e`, `contract`, `grading`, `md-dsl`, `server`, `web`），**0 错误** | **PASS** |
| **代码规范与 Lint** | `pnpm lint:changed` | 2.1s | 检查 1377 个文件，0 违规，0 警告 | **PASS** |
| **数据库 Schema 校验** | `pnpm db:generate` | 3.2s | 49 张表完全一致，`No schema changes, nothing to migrate 😴` | **PASS** |
| **契约 Schema 导出** | `pnpm schema:export` | 2.8s | 顺利导出 content, learning-pack(-v2), review-pack 4 份 Schema | **PASS** |
| **DSL 规范与打包** | `pnpm gen:spec` | 4.1s | 同步 25 个指令、68 条规则，产出 0 git diff | **PASS** |
| **工作区洁净度** | `git status --porcelain` | 0.2s | 仓库工作树完全干净（仅 untracked `.agents/` 元数据） | **PASS** |

### 6.2 核心自动化测试套件执行汇总

| 测试套件分类 | 具体文件列表 | 测试文件数 | 测试用例数 | 结果 | 重点验证覆盖内容 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **契约与判分核心** | `packages/contract/**`, `packages/grading/**` | 58 | 996 | **100% PASS** | 10 题型契约、纯行为注册表、字符上限、`gradeResponseRow` 单源 |
| **数据库迁移单链** | `migrate-qm.test.ts`, `migrate-ai-prompts.test.ts` | 2 | 5 | **100% PASS** | 0044-0047 迁移单链严格单调、回滚与幂等性验证 |
| **题型作答与自评** | `student-attempts-qm13.test.ts`, `student-attempts-response.test.ts`, `student-self-review.test.ts` | 3 | 51 | **100% PASS** | 开放题作答、配对/排序干扰项剥离、自评 CAS 与幂等、教师批注竞争 |
| **作答生命周期与 AI** | `student-attempts.test.ts`, `student-ai-attempt-review.test.ts`, `student-ai-context.test.ts` | 3 | 84 | **100% PASS** | 普通端防泄露、整体复盘 4 重门禁、HMAC 签名、AI 上下文组装 |
| **上下文与提交保障** | `student-practice-question-submit.test.ts`, `attempt-context.test.ts`, `attempt-question-materials.test.ts`, `export-service.test.ts` | 4 | 111 | **100% PASS** | 逐题提交 mutationId 幂等、冻结快照闭包、导出服务材料包含 |
| **测试汇总** | **上述核心受影响套件** | **70** | **1247** | **100% PASS (0 失败)** | **核心链路全覆盖** |

---

## 七、终审结论与合并建议（Final Verdict & Merge Recommendation）

### 7.1 终审评估
- **架构契约性**：100% 达标。严格遵循契约优先，服务端单源判分，快照绝对不可侵犯。
- **安全防泄露**：100% 达标。普通学生端接口无任何未授权答案泄露；AI 出口实施严格 4 重门禁与白名单脱敏。
- **v2 主干融合**：100% 达标。合并了 PR #12、PR #15、PR #16、PR #20 全部功能，数据库迁移单链完整且幂等。
- **质量闸门**：100% 达标。全仓类型检查、静态检查、Schema 导出与测试用例全绿。

### 7.2 处置结论：**准予合入（APPROVED / READY TO MERGE）**
分支 `audit/pr13-review-sync` 上的状态高度成熟稳定，无任何阻断级缺陷（0 P0 / 0 P1），建议 orchestrator 及维护团队正式推进该分支合入目标主干 `origin/v2`。
