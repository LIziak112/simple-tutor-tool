# 学生端做题方式与反馈节奏升级 · 执行追踪

- 日期：2026-10-22。
- 状态：用户已批准完整计划（docs/superpowers/plans/2026-10-22-student-practice-feedback-upgrade.md）；M0 文档与原型已核对，M1 契约与裁决器实施/审查中，分批验收。
- 执行者：GLM-5.3（独立工作树 codex/practice-feedback-design，编排者 Codex 验收合并）。

## 工作区事实

- 原分支工作区 HEAD 为 813ef1a0；本工作树不包含用户三份 AI 未提交修改，后续集成必须保留它们。
- task-workflow 在磁盘技能目录未找到。后续检查 Claude Code 启动清单，确认 simplify / code-review / security-review 为内置命令；它们不位于前述磁盘目录。后续实际调用记录另列，不能把先前的人工检查冒充内置命令执行。
- 已找到 ~/.claude/skills/test-driven-development/SKILL.md 与 verification-before-completion/SKILL.md，M1 起实现须按其纪律。

## 基线检查真实结果（2026-10-22，本工作树）

| 命令 | 结果 |
| --- | --- |
| pnpm install --frozen-lockfile | exit 0 |
| pnpm lint | exit 0（2 warning + 1 info，均为旧代码） |
| pnpm typecheck | exit 0 |
| pnpm test | 453 文件 / 5312 用例，5311 通过、1 失败：apps/web/src/features/student-ai/route-integration.test.tsx beforeEach 初始化 10 秒超时；当时尚未改动业务代码，资源争用仅为待证实推测 |
| pnpm test apps/web/src/features/student-ai/route-integration.test.tsx --maxWorkers=2 | 5/5 通过，exit 0 |
| pnpm test --maxWorkers=4 | 453 文件、5312 用例全部通过，exit 0，312.09 秒 |
| pnpm build | exit 0；有既有大分包与动态导入警告 |

- 首次全量不是全绿；单文件复核及限制并发的全量复核均通过，未修改测试或扩大超时掩盖失败。
- 日志：C:/Users/HUAYU/.claude/orchestration/practice-feedback-20261022/。

## 已核对风险（M0 源码核对结论，详见同目录 2026-10-22-student-practice-feedback-baseline.md）

1. `submitLessonQuestion` 在事务外读取 row.answerJson 并判分，事务内仅检查状态；M2 必须把版本核对与实际答案读取/判分移入事务（计划 §10.2 已确认此窗口）。
2. `useAttemptAnswers.flush()` 为全局接口，M3 须扩展按题 flush。
3. 数据库当前无 workflow / 反馈相关新字段；backup-service 为整库 VACUUM/ZIP 恢复，新增列需迁移兼容与备份往返测试，不新造 JSON 备份系统。
4. 教师设置实际页面为 apps/web/src/pages/teacher/SettingsPage.tsx，教师能力配置仅 steps/ink，反馈默认须独立配置项；计划中 packages/contract/src/teacher-settings.ts、lesson.ts 不存在，讲练契约实际在 lesson-api.ts，计划文件路径仅为建议，落地须实际定位。
5. AttemptSession 为通用会话（课程/作业/错题共用）；QuestionSurface/FinalAnswerInput 同源输入；PaperPresentation 为同稿全屏。phaseOfRows 普通来源仅整卷完成，lesson 看题 submittedAt，M4 需统一完成态 helper。AI compare 常量 1060px。
6. pending-mark 已按响应行 submittedAt 纳入 draft 卷待批（注释过时）；teacherMark / attempt draft 状态收尾须保护（计划 §13）。

## 批次清单 M0–M6

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| M0 设计确认与交互基线 | 执行追踪、基线核对、离线交互线框稿；不改领域逻辑 | 文档与浏览器基线已核对；真机待验收 |
| M1 契约与教师裁决 | 失败测试先行：策略组合、历史缺省、非法组合、CAS、旧客户端；契约 + 迁移 + resolver + 教师默认与作业三选项 | M1a+M1b 已完成：契约/迁移 0038/裁决器/教师设置与作业授权/建卷读侧接线/PATCH workflow CAS/教师 UI；三项审查修复完毕、全量绿（见验收记录）；M2 起未动 |
| M2 通用逐题服务 | 失败测试先行：提交版本、幂等、邻题泄露、教师收紧、并发收尾；抽取 submitAttemptQuestion；事务内判分 | 进行中（2026-10-22 起分支 codex/practice-question-submit、基于 M1 收尾 44ecb4a3；由 Claude 会话编排执行，本会话先行 M2 契约层，实际命令与结果见「M2 契约层」小节） |
| M3 单题工作区及输入 | 失败测试先行：当前题恢复、原位只读、四组合、按题 flush、快捷键保护、最后一题留反馈 | 未开始 |
| M4 AI、证据及统计整合 | 失败测试先行：本题 AI 完成态、旧回复不串题、三布局回退、待批/改判/统计与导出 | 未开始 |
| M5 偏好、DSL 与往返 | 失败测试先行：账号隔离、来源返回、推荐优先级、mixed、重导/导出与历史 samples | 未开始 |
| M6 全链验证与发布 | 压测、真实 Chromium/WebKit、手机/iPad/Pencil/软键盘、质量闸门、发布/回退说明 | 未开始 |

- 依赖主线 M0 → M1 → … → M6；每批次独立 codex/ 分支，测试先行，未完成项不得写成通过。
- M0 待验收项：真机（iPhone/Android/iPad Safari、Pencil、软键盘）与 iPad Pencil 待编排者/用户核对，不得把视口模拟写成真机通过。

## 验收记录

### M0 文档与原型审查

- GLM-5.3 经 Claude Code CLI 写入三份工件，Codex 审查并修正题卡宽度、示例主动作、AI 窄屏回退及侧栏位置。原型是示例线框稿，不是已上线功能或最终视觉稿。
- 实际调用日志返回 `contextWindow: 258000`，模型为 `glm-5.3`。较长响应发生中途截断及自动重试，改为分段写入；日志保存在上文目录。没有启动其他模型或子代理。
- 真实 Edge 无头浏览器：320/390/820/1180 四视口 × 四组合，共 16 项宽度检查；七题型已提交输入只读、标签、输入/宿主保持、整卷模式不展示题级参考答案、AI 三布局及窄屏弹窗回退，共 15 项行为检查通过；页面脚本异常和外站请求均为 0。
- 同一原型检查在真实 WebKit 引擎复核通过：16 项宽度检查、15 项行为检查，脚本异常与外站请求均为 0；这是浏览器视口检查，不是手机/iPad 真机记录。
- 截图、检查脚本与报告：上文日志目录 `prototype-*.png`、`check-prototype.mjs`、`prototype-report.json`。检查脚本属于本次编排工件，未成为业务测试替代品。
- 简化审查：复用单张题卡与单份 AI 正文，移除重复 ID 和多余状态循环。正确性审查修复填空锁定、输入标签及下一题动作；安全审查确认仅离线示例、无真实数据或出站。
- 手动验证：打开 `docs/superpowers/prototypes/student-practice-feedback.html`，切换两布局、两反馈、七题型和四状态，输入后切换布局，查看 AI 题下/侧边/弹窗；窄屏侧边回退弹窗，关闭后焦点回入口。
- 本阶段是文档与独立原型，按 AGENTS 纯样式/文案豁免镜像单测；浏览器检查已实际执行。真机、Pencil、Safari 软键盘未执行，继续列为发布前门槛。

### M1a 共享工作流契约 + 纯策略裁决器（2026-10-22，分支 codex/practice-workflow-contract）

- TDD 红灯（真实运行、行为断言失败，非导入错误）：
  - `pnpm test packages/contract/src/practice-workflow.test.ts` → exit 1，13 用例 8 失败（枚举/strict/白名单断言）；
  - attempt.test.ts 追加 3 用例 → exit 1，2 失败（practiceWorkflow/questionProgress 透传）；
  - assignment.test.ts 追加 4 用例 → exit 1，4 失败（可选字段缺省/组合拒绝）；
  - `pnpm test apps/server/src/services/practice-workflow-service.test.ts` → exit 1，16 用例 14 失败（空壳抛错）；语义修正三态（stored undefined=新建 / null=历史 / 对象=续作）后二次红灯 9 失败再实现。
- 绿灯：practice-workflow 13/13、attempt 45/45、assignment 27/27、service 16/16；针对性合集 104/104 exit 0。
- 验证：pnpm typecheck exit 0；pnpm lint 首次 exit 1（9 文件全部为可修复格式/导入顺序），`biome check --write` 修复后 exit 0（仅旧代码 2 warning + 1 info）；pnpm gen:spec exit 0；pnpm schema:export exit 0；二次生成无新增 diff（dsl-kit/tutor-lint.mjs 为含新契约的 bundle 重建，幂等）。
- 改动文件：packages/contract/src/practice-workflow.ts（新）+ 测试 + index.ts 导出；attempt.ts 草稿视图可选 practiceWorkflow/questionProgress + 测试；assignment.ts create/update 可选 allowPerQuestionFeedback（缺省保持 undefined，显式 after_due+true schema 拒绝，partial PATCH 只在请求内同时显式冲突才拒绝）+ teacherAssignment 可选输出 + 测试；apps/server/src/services/practice-workflow-service.ts（新，纯函数 resolvePracticeWorkflow + checkWorkflowCas）+ 测试。
- 裁决器语义：lesson 抛错；assignment 缺授权事实抛错（fail closed）；历史卷恒 after_attempt/legacy_attempt 不可升级；assignment 授权仅显式 true+on_submit；after_due（含异常 true）恒 teacher_after_due，过截止不放宽；自由练习教师未配置缺省 student_choice、新建默认 per_question、学生显式 after_attempt 生效；续作保持 stored feedbackMode（放宽不改写）；收紧不改写已选模式但 canSubmitQuestion=false、allowed 仅 after_attempt、原因 teacher_after_attempt；任一题级/整卷提交后 canChangeFeedback=false；releaseAt 仅复制 dueAt。输出恒过 practiceWorkflowSchema（投影即契约）。
- 未做（留 M1b/M2）：数据库迁移（teachers/attempts/assignments 新列）、建卷/读侧服务接线（恒显式返回 allowPerQuestionFeedback 与 practiceWorkflow）、PATCH workflow 路由与真实事务 CAS、逐题提交/反馈端点、教师设置与作业 UI 三选项。M1a 不宣称 M1 完成。
- 既有测试最小修改：assignment.test.ts 列表行字段集合断言补入新可选键（原 13 键 → 14 键）。
- 日志：C:/Users/HUAYU/.claude/orchestration/practice-feedback-20261022/m1a-*.log。

### M1a 编排确认发现修复（2026-10-22，同分支 codex/practice-workflow-contract）

仅改 practice-workflow 契约/纯裁决器与对应测试；未动 M1b/M2、未提交 git。红→绿日志：同目录 m1a-fix-red-contract.log（3 失败）、m1a-fix-red-service.log（5 失败）、m1a-fix-green.log（契约+service 39/39、attempt+assignment 72/72）、m1a-fix-typecheck.log（exit 0）、m1a-fix-lint.log（exit 0，biome check --write 格式化 3 文件后过）、m1a-fix-genspec.log / m1a-fix-schema.log（exit 0，二次生成 sha1 一致，幂等）。

1. lifecycle 判别联合：ResolvePracticeWorkflowInput 拆为 new（可缺省 stored、用 studentChoice、禁带 stored）与 existing（必须显式 stored 对象或 null、null 恒 legacy、禁 studentChoice）。运行时缺省/非法 lifecycle、existing 缺 stored、new 带 stored 均抛错（绕过 TS 同样拦截）。调用样例（写在 service 类型注释，M1b 接线不得猜 undefined）：
   - 新建：{ sourceType: "course", lifecycle: "new", studentChoice: "per_question" }
   - 续作：{ sourceType: "course", lifecycle: "existing", stored: { feedbackMode, revision, hasSubmittedQuestion, attemptSubmitted } }
   - legacy：{ sourceType: "assignment", lifecycle: "existing", stored: null, assignment: {...} }
2. 来源白名单：PracticeWorkflowSource = Exclude<AttemptSource,"lesson">，运行时非 course/assignment/wrong 一律抛错（unknown/lesson 测试均拒）；StoredPracticeWorkflow 改 extends Pick<PracticeWorkflow,"feedbackMode"|"revision"> 不手抄。
3. practiceQuestionProgressSchema 加 superRefine：submittedAt=null 时 feedbackReadable 必须 false；已提交但不可读仍合法；白名单与 assertNoLeak 禁止键未动。
4. releaseAt/submittedAt 收紧为 z.iso.datetime({offset:false}).nullable()：拒绝非法字符串/无时区/+08:00 偏移；未从 content.ts 导入 assignmentDueAtSchema（M5 content 将反向引用 practice 推荐字段，避免循环依赖）。
- 不采纳 code-review 建议（记录理由）：教师收紧后不自动把已选 per_question 改写为 after_attempt、不自动改写已提交卷节奏——计划 §5.4 要求保留原选择事实，收紧表现为 canSubmitQuestion=false + allowedFeedbackModes 单一 after_attempt + 原因 teacher_after_attempt，学生经普通保存 + 整卷交卷出口完成，不是死锁，业务规则不可改。亦不以 answersReleased 替代逐题授权；after_due 即使已过截止仍不允许逐题（读侧 fail closed 保持）。
- 更正：simplify/code-review/security-review 是 CLI 内置命令，不是缺失技能；M0 Edge 与 WebKit 原型检查各 31 项通过，是浏览器视口检查，不是真机。M1a 仍不宣称 M1 完成。


### M1b 契约落库、教师裁决接线与学生端工作流 API（2026-10-22，同分支 codex/practice-workflow-contract）

提交序列（小步、每步保持绿）：11cd80ae（契约扩展+迁移 0038）→ 49f25db0（wrongPractice 契约非 strict 语义对齐测试）→ bc725716（教师反馈设置路由+作业逐题授权落库）→ 1bdab3cc（建卷/草稿读取接线+PATCH workflow 事务 CAS）→ ef50a1c0（教师 UI：设置页反馈策略区+作业三选项）+ 本轮审查修复收尾提交。

- 契约：attemptStartOptionsRequestSchema（strict，workflowVersion=1 字面量门禁+feedbackMode 联带拒绝）；assignment/课程/错题 start 请求接入；practiceWorkflowUpdateRequestSchema 与响应 attemptWorkflowUpdateDataSchema；错误码 WORKFLOW_LEGACY / WORKFLOW_REVISION_STALE / WORKFLOW_MODE_NOT_ALLOWED。wrongPractice 维持非 strict（旧 schema 语义），未知字段被剥离（测试固化）。
- 迁移 0038（drizzle-kit 生成，无手写 SQL）：teachers.practice_feedback_policy 可空、assignments.allow_per_question_feedback 默认 0、attempts.practice_workflow_version/feedback_mode/workflow_revision(默认0)、responses.practice_mutation_id/practice_request_digest。边界夹具测试（0037 边界原生 SQL 种入）验证保守缺省+幂等；backup roundtrip 测试验证不放宽。
- 教师：GET/PUT /api/teacher/settings/practice-feedback（未配置=NULL；异常持久化值读侧保守 after_attempt）。assignment-service：create/update 落 allowPerQuestionFeedback，after_due+true 请求内显式冲突拒绝；partial PATCH 仅在请求内组合冲突拒绝；输出显式 allowPerQuestionFeedback。
- 学生接线：workflowStartColumns（省略 workflowVersion=旧协议恒定）；assignment create-or-return 不升级不覆盖；wrong/course 同口径；draft 读取白名单投影 practiceWorkflow+questionProgress（assertNoLeak，无答案秘密），lesson/legacy 缺失两字段。PATCH /api/student/attempts/:id/workflow：单事务真实 CAS（UPDATE WHERE workflowRevision … RETURNING），陈旧 revision 409、模式不允许 400、已交/题级已交/跨学生/legacy/lesson 各自拒绝，响应 private,no-store。
- 教师策略裁决：teacherPolicyOfStudent——未配置(NULL)=resolver 缺省 student_choice；学生不存在/无教师域/教师行悬挂 join 未命中→after_attempt fail closed（regression 测试覆盖悬挂 teacherId）。
- UI：设置页「教学」区练习反馈默认策略（radio 二选一，未配置默认标注、显式保存、失败保留草稿、教师隔离草稿，抽 useSettingsSectionDraft 骨架）；建卷向导与编辑弹窗三选项（由学生选择/交卷后/截止后；after_due 需先设截止时间；编辑配对发送 answerRelease+allowPerQuestionFeedback）。
- 三项审查（当场修复）：
  - simplify：已采纳——删 checkWorkflowCas 死代码、合并 assignment 两查询为 assignmentFactsOf/resolverInputsOf、单次 CAS UPDATE…RETURNING 全行、assertNoAfterDuePerQuestion 抽取、useSettingsSectionDraft 抽取（#7）。拒绝——移除 resolver 运行时 lifecycle/stored 守卫（#2）：M1a 编排确认加固成果+回归测试，不得丢弃。未做——#9/#10 记录为可选清理。
  - code-review：修复 #1（leftJoin 未命中教师行误判「未配置」→ 保守 after_attempt，加悬挂 teacherId regression）；修复 #2（陈旧 revision 409 优先于模式 400，加陈旧+不允许组合 regression）；#3 教师收紧后已提交题重取按当前 gate 受限=计划 §5.4 设计（注释固化，不采纳改写）。
  - security-review：无可利用项；PATCH 路由注释错位已修。
- 验证（日志同目录 m1b-final-*.log）：pnpm test --maxWorkers=4 → 459 文件 5404/5404 通过 exit 0；pnpm typecheck exit 0（修一处 exactOptionalPropertyTypes 报错：checked ?? 兜底仅类型完备）；pnpm lint exit 0（仅旧代码 2 warning + 1 info）；pnpm build exit 0；pnpm gen:spec + pnpm schema:export 二次生成 sha1 一致（幂等）。
- 既有测试最小修改：schema.test/migrate.test/backfill.test 行形状断言补 0038 新列缺省；migrate.test 旧库种子对 teachers/assignments/attempts/responses 改原生 SQL（Drizzle 当前表模型会带上 0038 新列导致旧库插入失败，与 units/attempts 既有惯例一致）；backfill 快照 helper 剔除 0038 新增列（保真断言针对原有业务字段）。
- 真实修正 bug：教师未配置（NULL）曾被误判 after_attempt——改为 NULL→resolver 缺省 student_choice，after_attempt 仅留给异常值/缺行（wrong-practice 默认测试暴露）。
- 未做（M2/M3 范围，不宣称）：逐题提交/答案出口端点与判分、学生单题工作区 UI、AI/证据/统计整合、偏好与 DSL、全链压测与真机。M2 前需拍板：feedbackReadable 对已提交行在教师收紧后的语义快照（当前按当前 gate 近似）。
- 手动验证步骤（Codex 验收用）：教师 /t/settings 教学区改默认策略→保存→刷新回显；建作业选三选项各建一卷；学生开新练习可选节奏/改节奏（PATCH 生效、他端改后本端 409 提示刷新）；旧作业（0038 前建的 attempt）打开无 practiceWorkflow 字段且不可改节奏。
