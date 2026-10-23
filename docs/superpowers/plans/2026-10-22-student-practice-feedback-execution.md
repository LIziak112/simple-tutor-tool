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
| M2 通用逐题服务 | 失败测试先行：提交版本、幂等、邻题泄露、教师收紧、并发收尾；抽取 submitAttemptQuestion；事务内判分 | 服务层与路由已完成并通过编排者三闸门验收（2026-10-22：契约层 6ee218e5+f31b3f08、服务层 afb7ebd2、验收修复 832444c5..9bac38bb，全量 461 文件 5464/5464 绿；学生端 UI 属 M3）；详见「M2 契约层」「M2 服务层」「M2 编排者验收」小节 |
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

### M2 契约层（2026-10-22，分支 codex/practice-question-submit，Claude 会话执行）

提交：d721b86e（台账 M2 行修正）→ 6ee218e5（契约 + 测试 + index 导出 + gen:spec 产物）。

- TDD 顺序：先写 packages/contract/src/practice-question-submit.test.ts（18 用例）→ 红灯 exit 1（模块未实现、导入失败；派单明示契约层此顺序合规）→ 实现 practice-question-submit.ts → 绿灯 18/18。中途两处测试自身笔误（M1 schema 导入源、包装 schema 少包一层 feedback）修正后一次通过，非实现返工。
- 落地内容：practiceQuestionSubmitRequestSchema（workflowVersion=1 字面量、questionRevisionId、expectedAnswerRevision 非负整数、submissionMutationId uuid、必填 evidence 复用整卷 submitEvidenceDeclarationSchema 三态语义；strict、未知字段拒绝、缺省拒绝）；practiceQuestionFeedbackSchema 共用授权投影（判别二态 released/not_submitted/pending_attempt/restricted；released 复用 attemptResultQuestionSchema，restricted 复用 M1 practiceRestrictionReasonSchema）；practiceQuestionSubmitDataSchema 四键白名单（feedback/questionProgress/attempt/practiceWorkflow）；practiceQuestionFeedbackDataSchema 单键 feedback——两 data 的 feedback 字段与投影 schema 对象同一（identity 断言防漂移）；成功壳 practiceQuestionSubmitOkSchema / practiceQuestionFeedbackOkSchema。
- 设计决定（供编排者复核）：
  - 请求体未含 workflowRevision：派单字段清单（workflowVersion/questionRevisionId/expectedAnswerRevision/submissionMutationId/evidence）为准；计划 §10.2「workflowVersion/revision」措辞按 workflowVersion-only 落地，提交 vs 改节奏竞态由服务端事务内按当前 gate 重裁（M2 服务实现若需 409 WORKFLOW_REVISION_STALE 可诊断分码，契约可后续小步扩展）。【翻案记录】后续提交 f31b3f08 已把 workflowRevision（非负整数）补进请求契约并随服务层 WORKFLOW_REVISION_STALE 三键 CAS 消费——本条 workflowVersion-only 取舍作废，以 HEAD 契约为准。
  - 「待公布」独立为 pending_attempt 态（本题已提交、本卷节奏 after_attempt 待整卷公布）；教师规则/历史协议受限为 restricted（M1 三原因）；两态分离避免把学生自选 after_attempt 误报成 teacher_after_attempt。
  - 回执不夹带整卷 summary/score（邻题对错不可反推，§6.1 白名单纪律）；released 态与 questionProgress 之间不加跨字段 refine（最后一题自动收尾后 canSubmitQuestion=false 会与 released 并存，语义合法）。
- 真实命令与退出码（工作树内）：
  - `pnpm test packages/contract/src/practice-question-submit.test.ts` → 红灯 exit 1；绿灯 exit 0，18/18。
  - `pnpm test packages/contract` → exit 0，42 文件 677/677。
  - `pnpm exec biome check packages/contract` → 首跑 2 错（导入排序+格式），`--write` 修复后 exit 0（84 文件）。
  - `pnpm -C packages/contract typecheck` → exit 0；`pnpm -r typecheck` → exit 0（全部包）。
  - `pnpm schema:export` → exit 0；二跑零 diff（content.json 不含本契约，幂等）。
  - `pnpm gen:spec` → exit 0；dsl-kit/tutor-lint.mjs 因契约变更重打包（114 行标识符漂移，esbuild 重打包正常现象）；二跑 sha1 一致（52f6089b…），幂等；已随 6ee218e5 提交。
- 未做（M2 后续批次范围，不宣称）：submitAttemptQuestion 服务抽取与路由分流、幂等/并发/邻题泄露泄露测试（服务端 assertNoLeak）、expectedAnswerRevision 事务内比对实现、错误码接线、学生端 UI。

### M2 服务层（2026-10-22，分支 codex/practice-question-submit，Claude 会话执行）

提交：afb7ebd2（服务层 + 路由 + 测试）+ 本台账提交。

- TDD 红灯（真实运行、行为断言失败）：先写 `apps/server/src/routes/student-practice-question-submit.test.ts`（21 用例：端到端闭环 5、协议分流与守卫 5、版本核对 4、教师收紧 2、after_attempt/after_due 2、整卷混跑 1、泄露矩阵 2）→ `pnpm test apps/server/src/routes/student-practice-question-submit.test.ts` exit 1，21/21 失败（新协议请求被既有 lesson 协议路径按非 lesson 来源 404——行为失败非导入失败）。（该文件用例数随验收期增补：832444c5 +1、验收修复 +1，HEAD 共 23。）
- 绿灯：同命令 exit 0，21/21。中途四处**测试自身**口径修正（重试用例先存答案再断判对、未知题用例显式 questionRevisionId、feedback GET 跨学生按取卷口径断 403 FORBIDDEN、course 夹具需 PATCH course-items visible=true 且单元改名避免与库单元同名合并），非实现返工。
- 落地内容：
  - **submitPracticeQuestion**（attempt-service，M2 新协议普通卷通用逐题提交）：单事务按 §10.2 顺序——归属（and(id,studentId) 404 不暴露差异，同 PATCH workflow 口径）→ 作废 409 → 课程失权（requireVisibleCourseUnit 分态）→ 协议形态（lesson→409 WORKFLOW_PROTOCOL_MISMATCH、历史卷→409 WORKFLOW_LEGACY）→ **幂等与已提交裁决**（同 mutationId 同摘要→重放按当前规则投影返回同一提交事实，不重判不重复事件；同 id 异摘要→409 WORKFLOW_MUTATION_CONFLICT；异 mutationId 含整卷已收尾→409 QUESTION_ALREADY_SUBMITTED）→ resolver 当前裁决（canSubmitQuestion=false→409 WORKFLOW_RESTRICTED；重放分支先于它，教师收紧后重试不再被拒）→ workflowRevision CAS（409 WORKFLOW_REVISION_STALE）→ questionRevisionId（409 与整卷/lesson 同口径）→ **expectedAnswerRevision 与事务内实际读取的学生答案版本比对**（409 ANSWER_REVISION_CONFLICT 附 _current，复用既有答案冲突协议）→ 证据声明（buildSingleQuestionEvidence 与 lesson 同一实现：questionId 一致、有稿 none 拒、frozen 精确比对落行、missing 如实记录）→ **事务内**读冻结快照与答案判分（M0 风险 1「事务前读答案」窗口关闭）→ 行级真实 CAS（UPDATE WHERE submittedAt IS NULL，幂等凭据 practice_mutation_id/practice_request_digest 同事务写入）→ 最后一题共同收尾。成功记 question_submit 事件（重放不重复）；回执四键在事务后 fresh 读 + 读取时刻投影组装。
  - **共享收尾 autoFinishPerQuestionAttempt**：从 submitLessonQuestion 收尾块抽取（瘦行集重读 + finalScoreOf/scoreAutoOf 与整卷同口径 + WHERE status='draft' 真实 CAS——逐题与整卷并发收尾只成功一次），lesson 与 M2 同源；lesson 行为零变化（student-lesson.test.ts 既有用例全绿为回归证据）。
  - **题级反馈 GET /attempts/:id/questions/:questionId/feedback**（新增路由）：getPracticeQuestionFeedback（归属/作废/课程失权/协议形态/冻结集守卫，lesson 与历史卷 409 WORKFLOW_LEGACY——不当题复制 lesson 释放或整卷结果视图）+ **共用授权投影 practiceQuestionFeedbackOf**（提交回执的 feedback 字段与 GET 的 data.feedback 是同一函数，单一实现防漂移）。四态按读取时刻裁决：not_submitted；pending_attempt（本题已提交但公布条件未满足——进行中卷 after_attempt 节奏，或已收尾卷 after_due 截止前，公布 gate 与结果视图 answersReleased 同口径读时比较）；restricted（教师收紧，原因复用 M1 practiceRestrictionReasonSchema 三值）；released（question 为 attemptResultQuestion 同构，stemMd 一律经 studentFacingResultOf/studentStemMd 与 lesson 同一出口；**attempt 未交卷期间 teacherMark/teacherComment/finalCorrect 恒 null 投影**，收尾公布后随行）。响应 Cache-Control: private, no-store。
  - **协议分流路由**：POST 单题提交按请求形态分流——携带 workflowVersion 字段走新协议 strict 契约（回执经 practiceQuestionSubmitDataSchema.parse 白名单校验 + private,no-store），否则 lesson 旧协议形态沿用既有契约与行为（400 消息格式不变）；lib/http-error 增 readJsonBody（非 JSON 400 与 parseJsonBody 同口径）。
  - **整卷混跑**（§10.1 末行）：submitAttempt 的逐题语义条件从 isLesson 扩为 `lesson || practiceWorkflowVersion===1`——已单题提交行不重判、不覆盖材料（教师课中批改 teacherMark/finalCorrect/submittedAt/幂等凭据保留），剩余行判分并把 submittedAt 记为交卷时刻，证据声明范围只覆盖剩余题；历史卷（无版本）行为零变化。submitLessonQuestion 增协议守卫：新协议卷收到旧协议形态→409 WORKFLOW_PROTOCOL_MISMATCH 提示刷新（§5.3 不退回无版本写入），历史卷维持 404。
- 设计决定（供编排者复核）：
  - **共享抽取方式**：证据验证（evidenceRowOfDeclaration/buildSingleQuestionEvidence）、判分原语（grade/snapshotOfRow/answerOf）、收尾（autoFinishPerQuestionAttempt）、拒绝工厂（questionAlreadySubmitted/revisionStale）为两协议共享件；lesson 与 practice 的**编排**保持独立——lesson 无工作流 CAS、答案版本比对与幂等键，两套事务必要顺序不同，强行参数化统一会增加抽象层级而不减少语义（lesson 零变化有全量回归证据）。
  - **请求摘要**：sha256(版本标签 v1 + attemptId + questionId + workflowRevision + questionRevisionId + expectedAnswerRevision + 证据 state/versionId/revision/questionId 字段拼接)；submissionMutationId 是配对键本身不进摘要。任一提交后节奏冻结（PATCH 被 QUESTION_ALREADY_SUBMITTED 阻断），workflowRevision 进摘要不会误伤合法重试。
  - **新错误码**（全部服务层 HttpError，ApiErr UPPER_SNAKE 通用壳，无契约改动）：WORKFLOW_RESTRICTED（409，教师收紧/节奏不允许逐题提交——学生按「继续完成剩余题目并交卷」收敛）；WORKFLOW_MUTATION_CONFLICT（409，同 id 异摘要）；WORKFLOW_PROTOCOL_MISMATCH（409，两方向协议错配：新协议请求打 lesson 卷 / 旧协议形态打新协议卷，均提示刷新）。
  - 教师域字段口径：released 在 attempt 未交卷期间 teacherMark/teacherComment/finalCorrect 恒 null（派单明示）；收尾公布后随行（与结果视图 answersReleased 同 gate，attemptResultQuestion「公布 gate 截止前置 null」注释的题级实例化）。
- 泄露矩阵结果（§10.4）：未授权形态（not_submitted/pending_attempt/restricted 的 feedback GET 与重放回执）完整 assertNoLeak + assertNoStemLeak；released 正断言（judge 详解与参考答案确实在）+ 负断言（邻题未提交答案/未解锁提示、教师私注哨兵〔draft 期间〕、题块原文、`- [x]` 与 `[[…]]` 标记绝不出现）；逐题提交后普通取卷/草稿视图仍全绿（questionProgress 白名单只有 submittedAt/feedbackReadable，无对错得分）。
- 真实命令与退出码（工作树内）：
  - `pnpm test apps/server/src/routes/student-practice-question-submit.test.ts` → 红灯 exit 1（21 failed）；绿灯 exit 0（21 passed）。
  - 定向回归 `pnpm test apps/server/src/routes/student-lesson.test.ts student-practice-workflow.test.ts student-attempts.test.ts attempt-freeze.test.ts student-course-attempts.test.ts` → exit 0，5 文件 113/113。
  - `pnpm test -- --maxWorkers=4` → exit 0，461 文件 5443/5443。
  - `pnpm -r run typecheck` → exit 0（修测试文件三处类型：判别联合换宽松形态接口 SubmitBody、两处未用变量）。
  - `pnpm lint` → 首跑 exit 1（2 格式错），`biome check --write` 4 文件后 exit 0（余 2 warning + 1 info 均旧代码）。
  - `pnpm build` → exit 0。
- 未做（M3+ 范围，不宣称）：学生端单题工作区与按题 flush（M3）、AI 完成态/统计/导出整合（M4）、e2e spec（M6）、gen:spec/schema:export（契约未动，无需重跑）。

### M2 编排者验收（2026-10-22，同分支，Claude 会话编排执行）

验收序列：D2 交付全量独立核验（diff 全读 + 1440 行测试文件全读 + 与 origin/v2 合并冲突面预计算）→ 64e33922 合并 origin/v2（零冲突）→ /simplify 四角度（23 发现收敛 9 项修复）→ /code-review max（10 角度 + 补漏扫描；15 发现：14 修复 / 1 记档接受）→ 修复六笔 → /security-review（无发现）→ 全量回归。

- 修复提交（质量闸门产物，均小步绿）：
  - 832444c5 / c5531e7f（/simplify）：四态裁决统一纯函数 resolvePracticeQuestionFeedbackState、requireOwnActiveAttempt/practiceProtocolOf 共享件、作业授权行悬挂 409 WORKFLOW_LEGACY 降级（M1 d7c84b89 语义接线）+ PRAGMA 回归。
  - b46422d6（契约）：M2 三错误码（WORKFLOW_PROTOCOL_MISMATCH/MUTATION_CONFLICT/RESTRICTED）注册进 attemptErrorCodeSchema + M1/M2 六码 doc 补齐 + gen:spec 重跑（补漏扫描发现：契约/实现漂移，锁测试加用例）。
  - 6ba615c5（公布 gate 收敛，三角交叉命中）：新纯函数 attemptAnswersPublished（practice-workflow-service）——作业行悬挂时已收尾卷 GET 反馈从裸 404 ASSIGNMENT_NOT_FOUND 收敛 pending_attempt（fail-closed 家族统一，assignmentReleaseByIds 含软删取数）；已收尾判别键统一 status !== "draft"（wiring 两处 submittedAt 代理取齐）；now 穿透 attemptWorkflowView（dueAt 边界同一时钟）；谓词早退收敛（isV1ProtocolAttempt 委托式类型守卫恢复字面量窄化）。矩阵单测 4 + PRAGMA 收尾悬挂回归 1。
  - 0e9fb96d（协议谓词）：submitAttempt perQuestionAttempt 改 practiceProtocolOf(attempt) !== "legacy"（异常行 version=1 而 feedbackMode 缺失时与四个逐题消费点口径一致）；schema.ts submittedAt 列注释与 lessonQuestionSubmitted/assertRowNotSubmitted 谓词 doc 随 M2 语义扩散更正。
  - 124f2c8f（热路径）：question_submit 事件挪入主事务（省一次独立 autocommit fsync、消除「提交已持久事件丢失」窗口；lesson 事件仍事务外属既有模式）；released 快照单次解析随事务产物带出（重放路径维持惰性）；事务后 view-null 409 注释修准——该发现（同 mutationId 回执在异常数据修复前不可取）记档接受：触发需多进程并发破坏授权行、届时全卷读取面同步降级、契约 practiceWorkflow 必填无法产出合法降级体。
  - 5daf75d5（清理批）：questionNotFound 工厂五处收敛、课程失权守卫 assertDraftCourseVisible 三处共用（wiring 导出）、hasSnapshot .mapWith(Boolean)（better-sqlite3 返回 0/1 整数的潜伏严格比较陷阱归零）、测试换 note-world 会话三件套、契约测试删 no-op 断言、删迁移孤注释。
  - 9bac38bb（lint 债）：v2 合并带入的 b20 演练脚本三处 biome 诊断修复——根 `biome check .` 全仓 1183 文件归零（b260681c 自称 lint 0 实为范围检查；v2 存量债随本分支合回治愈）。
- 最终验证（日志 /tmp/m2-verify3.log）：pnpm test 461 文件 5464/5464 exit 0（较服务层交付时 +21：验收语义修复与新增矩阵/回归/契约锁用例）；typecheck / lint / build 全 exit 0。
- /security-review（聚焦学生端防泄露边界，独立子代理）：无高置信度发现——四态非 released 零题目内容（strict 白名单 + 路由 .parse 再校验）、未提交题无 released 旁路、幂等重放零写入按读取时刻重投影（教师收紧后重试返回 restricted 非缓存正文）、课程失权校验先于幂等重放、digest \u0000/\u0001 分隔注入不可构造、全程 drizzle 参数化、两端点 Cache-Control private,no-store、跨学生 POST 404 / GET 403 不暴露存在性。
- 遗留待用户拍板：§5.4 教师收紧后已提交行 feedbackReadable 语义——现按「当前 gate」实现（收紧后已提交行重取受限、已下发内容不宣称撤回，已提交事实与成绩保留），M2 验收以此口径为准；如需「提交时刻快照语义」须改契约并另行批次。
- 台账更正（约定角发现）：M2 表格行与「M2 服务层」绿测数字原停在 afb7ebd2 时点（21 用例/5443），本节为最终口径（23 用例/5464）；「M2 契约层」workflowVersion-only 设计决定补翻案记录（f31b3f08）。

### M3 编排开工（2026-10-23，分支 codex/practice-single-workspace，Claude 会话编排）

- 用户指令：继续编排执行直到 M6 全部完成；§5.4 按「当前 gate」口径定案（教师收紧后已提交行重取受限、不宣称撤回已下发内容，已提交事实与成绩保留）——M3/M4 UI 按此口径消费 questionProgress/feedbackReadable 与四态反馈，不再另问。
- 分支自 origin/v2@25a3a7f7（含结果页 AI 入口按题召唤与批量复盘图标化）。
- 派单拆层：D1 骨架与偏好（PracticeWorkspace 呈现层/偏好存储/设置与开始区入口/题目导航/URL questionId）→ D2 逐题提交交互闭环（主操作状态机/QuestionFeedback 反馈区/最后一题留反馈）→ D3 快捷键与按题 flush（键盘方案与保护规则/切题本机落盘）。串行同分支，每层 TDD 红灯先行；编排者验收统一三闸门+全量回归（M2 模式）。
- 范围边界：M3 工作区只覆盖 AttemptSession 驱动的普通三来源（course/assignment/wrong）v1 新协议卷；lesson 页与 legacy 卷保持既有形态零回归（lesson 适配是否纳入 M4 视计划再定）。

### M3-D1 骨架与偏好（2026-10-23，子代理实现，编排者独立验收通过）

- 提交链（分支 codex/practice-single-workspace）：134da248（偏好存储）→ 9325f8cd（设置区配置行）→ f017d569（摘要行+导航四态+紧凑行/占位条）→ 180a5cae（作答页双呈现集成）→ 88e18fd2（RadioGroup 修正）。
- 落地：practice-preference-store（契约 strict v1 形态、部署/角色/账号隔离、跨标签同步、损坏回默认不阻断）；/s/settings「做题方式」配置行（暂存-保存）；PracticeWorkspace 呈现件（摘要行/紧凑进度行/占位操作条/菜单切换项/提交标记）；practice-protocol 纯裁决（协议判别只信服务端投影、受限文案、首道未提交定位）；AttemptSession 同一 keyed `<ol>` + `hidden` 切换列表/单题（§11-1 不重建，测试有 DOM 同一性断言 `toBe(q2Input)`）；URL `?q=` replace 导航+属本卷校验；导航四态（已提交/待公布中性色不泄对错，「未答」排除已提交行）；AttemptHeader menuItems 槽；dropdown-menu 补 RadioGroup/RadioItem（此版 Radix RadioItem 无 checked prop，选中态来自组 value）。
- 关键取舍（沿用桌面会话裁决）：摘要行落作答会话顶部（三来源汇聚 AttemptSession，作业无预开始 UI）；互切不重建靠同一 keyed `<ol>`+hidden；legacy/lesson 恒列表零变化（practiceProtocolOfDraft 判别，测试断言）。
- 编排者独立验收（2026-10-23）：全量 diff 通读（19 文件 +1992/-73）；pnpm test 465 文件 5498/5498 exit 0（/tmp/m3-d1-accept-*.log）；typecheck/lint/build 全 exit 0。发现一项遗留：布局初值在账号绑定 effect 之前读取，硬刷新直达作答页会错过已保存默认「单题」——已随 D1.5 修复（1fa1735a）。

### M3-D1.5 建卷 opt-in（2026-10-23，子代理实现，编排者独立验收通过）

- 缺口核实（编排者 grep 实证）：契约 attemptStartOptionsRequestSchema 与服务端三入口（assignment/course/wrong-practice，student.ts:302/:953/:1061）M1b 已就绪且省略按旧协议；唯 web 从未携带 workflowVersion（grep 为空）→ 生产新建卷恒旧协议。D1.5 实为纯 web 小单。
- 提交：d7224f07（三 start 封装可选 options；useStartAttempt/useStartCourseAttempt/两处错题重练 mutationFn 执行时读 getPracticePreference().feedback 构造 {workflowVersion:1, feedbackMode}；api 层 mock fetch 请求体测试）+ 1fa1735a（D1 遗留修复：绑定时刻对齐已保存默认布局，显式切换标志防拉扯，补两条集成测试）。
- 编排者独立验收：两笔 diff 通读；代理哨兵日志核验（红→绿、全量 466 文件 5506/5506、TSC/LINT/BUILD 全 0）；编排者自跑全量复核 /tmp/m3-d15-accept-full.log。自此生产新建普通卷（course/assignment/wrong）默认进入 v1 新协议（学生偏好 per_question，教师约束服务端裁决），M3 单题 UI 可达。
- 未做（后续批次）：PATCH workflow 节奏切换 UI（计划 §6.1 canChangeFeedback 呈现，M5 偏好批次或 M4 视工作量定）。

### M3-D2 逐题提交交互闭环（2026-10-23，子代理实现，编排者独立验收通过）

- 提交链：4b0f8d1b（QuestionFeedback 四态呈现 + 受限文案单源 + VerdictBadge 结论文案可选）→ f43bf67e（usePracticeQuestionSubmit 编排 + 回执 overlay + 原位只读 + 主操作三态）→ 330e3037（AttemptResultParts 拆分，草稿渲染不静态加载结果回看模块，保住 T6R.15 F 惰性纪律）→ fc40eda7（缺稿明确选择弹层接入提交编排 + 反馈惰性 GET + 错误分诊 + 查看本次结果收敛测试）。
- 落地：五字段 POST 编排（submissionMutationId {id,payloadKey} 同载荷重试固定复用、WORKFLOW_MUTATION_CONFLICT 换新 id 自动重试一次）；回执 overlay（questionProgress/attempt/workflow，data 刷新整体重置——服务端权威）；已提交行原位只读（readOnly 链：输入 disabled/readOnly、隐藏标画/草稿/手写编辑入口，§11-2 原位不换卡）；列表 footer/单题主操作位三态（提交本题→正在提交→下一题/查看本次结果/继续未提交题目）；最后一题自动收尾停轮询留反馈视图，「查看本次结果」显式收敛；题级反馈按需 GET（单题当前题 effect、列表 IntersectionObserver rootMargin 160px、失败可重试不缓存失败）；错误分诊（ALREADY_SUBMITTED 静默 refetch、STALE 家族提示刷新、ANSWER_REVISION_CONFLICT 复用既有冲突裁决 UI、WORKFLOW_RESTRICTED refetch 受限呈现）。
- 编排者独立验收（2026-10-23）：四笔全量 diff 通读（18 文件 +2392/-175）；编排者自跑 /tmp/m3-d2-accept-{full,tsc,lint,build}.log：5532/5532、TSC/LINT/BUILD 全 0；子代理红灯日志核验。发现并确认子代理自修一处：330e3037 修复提交 2 静态引入结果回看模块破坏惰性加载（全量测试当场暴露）。
- 记档接受：部分填空未填满时主提交按钮禁用（isAnswered 判定），「不会」次按钮覆盖提交路径（与整卷语义一致，P1 打磨候选）；单题模式反馈按 data 加载缓存一次（refetch 重置，与 overlay 同生命周期）；已提交手写题卸载纸面编辑入口（笔迹提交前已封存上传，编辑入口随 readOnly 移除与既有先例一致）；缺稿弹层为组件级测试+接线走查（problems 全链 jsdom 集成未做，成本高）。

### M3-D3 快捷键与按题 flush（2026-10-23，子代理实现，编排者独立验收通过）

- 提交链：6adfb080（useAttemptAnswers 按题 flush：flushQuestionLocal 本机落盘 / flushQuestion 单题服务端确认，inFlight 按题 Map 索引，全局 flush 零变化）→ 609d6410（提交流接入 flushQuestion + 切题前本机落盘保护/重试入口）→ 4236cdbf（单题键盘方案 Enter/←→/1-9 + 快捷键帮助）。
- 落地：按题 flush（§11-4 提交第 8 题不等第 19 题在途；§11-5 切题只要求本机落盘成功，离线可切题）；切题保护统一入口 goSingleQuestion（本机写失败不切题，「本机稿未保存，仍停留本题」+ 重试成功再切，不清空原稿不跳页）；键盘方案仅 v1+单题模式挂载（legacy/lesson 零变化），三类键统一受 keyboardShortcuts 偏好门禁——Enter 主动作（未提交=提交本题含空答「不会」链、已提交=下一题/继续未提交、查看本次结果永不入键）、←→仅工作区容器焦点域、1-9 复用选项控件链（option.click() 后焦点回容器）；保护链：composedPath 文本编辑区判定（含 MATH-FIELD/shadow DOM 宿主）、按钮/链接保留自身 Enter、isComposing/repeat/keyCode 229/修饰键/defaultPrevented 抑制、任一弹层打开（role=dialog data-state=open）不推进、提交中/书写中/纸面展开/答案冲突/切题保护拦截、键盘提交持 practiceKeyActionRef 同步锁堵收笔 await 微任务窗口；「更多 → 快捷键」帮助弹层（粗指针提示需实体键盘，弹层状态在菜单子树外持有）；单题工作区容器 tabIndex=-1 聚焦域，切题后焦点落容器（不弹软键盘）。
- 编排者独立验收（2026-10-23）：三笔全量 diff 通读（10 文件 +1438/-22）；红灯日志核验（red1 7 failed|3 passed）；隔离断言实测有效（q19 挂起不阻塞 q8 flushQuestion、全局 flush 仍等全部）；编排者自跑 /tmp/m3-d3-accept-{full,tsc,lint,build}.log：5562/5562、TSC/LINT/BUILD 全 0。
- 记档接受：焦点落点为单题工作区容器（键盘域锚点）而非题干元素本身——满足「不弹软键盘+键盘域锚定」功能意图；jsdom 未实现 composedPath/isContentEditable 且 shadow 事件 target 重定向，practice-keyboard 以 composedPath 优先+target/深焦点链回退（真实浏览器走标准路径），MathLive 让位列真机抽验归 M6 用户清单；flushQuestion 的 denied（无权限保存）路径提示为通用网络文案（原全局 flush 有专属文案；该路径 attempt 已不可编辑，详情轮询自然收敛，罕见不阻断）。

### M3 三闸门与合并验收（2026-10-23，分支 codex/practice-single-workspace，Claude 会话编排执行）

- /simplify（独立子代理，四角度：复用/简化/抽象层级/死代码）：12 发现 → 10 项修复于 2855bf5f（+104/-167：受限文案单源 practiceRestrictionCopy 委托 teacher_* 落 practiceFeedbackRestrictedCopy、进度按题查表 progressById Map 替换 5 处 practiceProgress.find、提交错误路径 failWith 收敛、建卷选项 workflowStartOptions 单一出处三处复用、FeedbackNoticeBox+PENDING_ATTEMPT_FEEDBACK_COPY 复用、四测试文件 workflowOf 夹具收敛 practice-test-fixtures.ts、dropdown RadioItem 内联 SVG 换 lucide Check）；2 项记档：单双模式按钮对结构保留差异（两模式操作语义不同，强行统一引入配置复杂度不偿）、设置区状态机抽象（savePracticePreference 调用面小，M5 偏好批次扩展时再议）。
- /code-review（独立子代理，max 力度）：3 应修 + 2 建议 + 1 存疑 → 4 项修复于 489c64d0（格式漂移 biome 修后 amend 为 c43ffc68）：① 焦点重取尊重收尾暂停——refetchOnWindowFocus 补轮询暂停谓词（此前仅 refetchInterval 尊重，切窗再切回会绕过暂停把反馈视图翻成整卷结果，违背 §10.3 显式查看才收敛）；② 反馈缓存重置后当前题补取——data 刷新重置 feedbacks 后单题模式当前已提交题悬在等待态，effect 改依赖 feedbacks 状态按行达标补取；③ 单题切题先收笔——goSingleQuestion 先 editor.request(null) 收笔再动状态；④ 保存详情定位与切题入口统一（单题模式走 jumpForMode 同一入口，URL/状态同源）；+3 回归测试（visibilitychange 焦点重取抑制、反馈补取、保存详情定位）。2 项记档：detailPollingPaused 集合条目不清（无行为副作用，会话级内存小）、flushQuestionLocal 保存态窗口（pagehide 兜底既有）；1 存疑（MathLive 键盘让位）归 M6 真机清单。
- /security-review（独立子代理，六焦点：未提交题答案泄露面/呈现层只读与服务端边界/凭据与身份/请求构造/注入面/偏好与指纹）：高/中/低发现 0。核对要点：feedback 缓存仅两写入口（回执 result.feedback + ensureFeedback GET 双守卫）、四态投影零题目内容（released 才挂结论文案/答案比对/详解）、readOnly 链完整（输入 disabled/编辑工具隐藏/键盘 1-9 查 option.disabled）、偏好键部署+角色+账号隔离无指纹、五字段 POST 白名单、静态文案无注入面。4 观察项记档：① 已提交只读卡保留分步提示解锁（提示不属 §10.4 答案边界，M3 前既有语义，若按题级反馈重划提示边界需服务端 hint 端点配合——M4 视计划定）；② aiTrigger 已提交卡保留（attempt 口径重校验既有机制，M4 按题完成态适配时一并核对）；③ URL q 参数携 questionId（学生可见 DOM 标识非秘密）；④ readable 未入视口 FeedbackPending 持续转圈（呈现瑕疵非安全，守卫保证不发未授权请求——M6 真机清单）。
- 测试方法论沉淀（闸门修复过程实证）：TanStack Query v5 焦点重取监听 window visibilitychange 而非 focus（jsdom 测试须派发前者）；structuralSharing 使深度相等响应保持同引用（重取无变化=缓存不动是合法行为，测试要制造真实变化才触发效应）。
- 全量回归（编排者自跑，哨兵日志 /tmp/m3-final-{full,tsc,lint,build}.log）：pnpm test 471 文件 5565/5565 exit 0（M2 基线 5464，+101）；typecheck exit 0；lint exit 0；build exit 0。
- 合并：v2merge 工作树 git merge --no-ff codex/practice-single-workspace（直系后代零冲突）→ 快验 test/typecheck → 推送 origin/v2。

### M4 编排开工（2026-10-23，分支 codex/practice-feedback-integration，基于 v2@73c875e3，Claude 会话编排）

- 摸底（只读子代理）结论：§13 大半已被 M2 机制覆盖（待批按行级收录 pending-mark.ts:49-55 含 draft 卷行级 submittedAt、markResponse draft 卷不重算整卷、整卷混跑护改判、错题本/趋势按完成卷纳入）；真正落差＝① phaseOfRows 对 v1 逐题卷仍按 attempt 级（teaching-policy-service.ts:168-175，且 :699-710 防御用例方向相反）；② 单题模式切题不收起 AI 阅读、openTask 不切题卡；③ 「已提交 n/N 题」未出作答页（记录页/矩阵/作业列表均无）；④ 三处 stale 注释（pending-mark.ts:18、mark-response.ts:224-226、student-records.ts:222-223）与「pendingCount=0⇔graded 全站成立」推理（pending-mark.ts:21-24）；⑤ 整卷结果缺「逐题反馈/交卷后反馈」摘要（§13.8；数据面已就绪——attemptWorkflowView 对任意状态 v1 卷产出 practiceWorkflow+questionProgress，attempt-service.ts:2798 已并入投影）。
- 派单拆层：D1 服务端 AI 完成态按题化 → D2 前端 AI 单题整合 → D3 统计/摘要/注释裁决。串行同分支，一层一单，TDD 红灯先行，编排者验收统一三闸门+全量回归。
- 裁决预告（D3 依据总计划定案，子代理不得另议）：§13.4 第一版口径——AI 批量复盘 draft 拒绝、学习包/CSV 只收非 draft、review-pack draft⇒「未交卷」**维持现状**（§13.7「不盲目统一放宽导出权限」）；教师题级待批可提前查看已由 pendingMarkCounts 覆盖；只改 stale 注释与新增进行中 n/N 呈现、结果摘要。M3 安全观察①（已提交卡提示解锁）维持既有语义不入 M4；PATCH 节奏切换 UI 归 M5。

### M4-D1 服务端 AI 完成态按题化（2026-10-23，子代理实现，编排者独立验收通过）

- 提交：5b6dc30d（6 文件 +406/-17：phaseOfRows 单源分支 + wiring 谓词 isPerQuestionV1Attempt + AGENTS.md 不变量行同步 + teaching-policy 测试改写/新增 + 矩阵 D1-18/19/20 fake provider 双断言）。
- 落地：phaseOfRows 分支改为 practiceProtocolOf(attempt)==="lesson" || isPerQuestionV1Attempt(attempt) → 行级 submittedAt（与 lesson 同语义）；v1 after_attempt 卷与历史卷维持 attempt 级（行级残留值不改整卷语义，翻转后的防御用例收窄锁定）。isPerQuestionV1Attempt 落 practice-workflow-wiring.ts 紧邻 practiceProtocolOf 单一出处（类型 Pick 三字段），AI 侧不另写协议判别；完成态仍单源 questionPhaseOf→resolveAttemptQuestionAiPolicy（摸底核对全部通道无旁路）。矩阵用例：D1-18 guided×本题已提交→open_study 复盘携带参考+解析、邻题仍启发尺度；D1-19 post×未提交创建 403 零任务行→提交后本题复盘、邻题 403；普通取卷出口不因行级提交解锁（assertNoLeak+哨兵全零）；D1-20 教师中途切 post：已完成题出站照常复盘（不可被关闭重锁）、未提交邻题出站前拦截转 paused。
- 派单纠偏（子代理正确拒绝编排者 brief 错误，记档）：brief 曾写「guided_only 未提交出站不携带答案解析」——与 AGENTS.md 定案相反（「仅启发」是提示词输出约束非保密模式，需求规格 §2.3 授权启发模式携带）；子代理维持既有 D1-02/D1-12 携带口径（断言启发硬约束在场），「不携带」禁止场景正确落在 post_submit_only 未提交。**后续派单引用教学模式语义一律以 AGENTS.md 该行为准。**
- 编排者独立验收（2026-10-23）：全量 diff 通读；practiceProtocolOf 等价性核对（:173 lesson 分支恒先于版本判定，与旧 sourceType==="lesson" 判定等价）；红灯日志核验（/tmp/m4-d1-red.log：7 failed|44 passed EXIT=1）；编排者自跑 /tmp/m4-d1-accept-{full,tsc,lint}.log 与复跑 full2：TSC=0、LINT=0、全量 5572/5572（首跑 5571/5572，唯一失败 backup-gc.test.ts 备份恢复全链 5s 超时抖动——11s 实跑 vs 5s 预算，与 D1 改动面零交集，隔离复跑 5/5、全量复跑全绿；该测试超时预算偏低已记观察）。

### M4-D2 AI 前端单题整合（2026-10-23，子代理实现，编排者独立验收通过）

- 提交：62a63ee5（7 文件 +831/-93，dock 面大半为 JSX 包 Provider 重排缩进）。
- 落地：① 切题先收起——goSingleQuestion 返回布尔、在收笔与本机落盘保护之后真正切换之前插入 aiCompanion.collapseForNavigation()（复用 dock 既有收起链 flush→closePanel→焦点/锚点还原，不开第二套收起；未打开直接放行，收起失败 dock 就地提示保留现场不叠加切题横幅）；收起后绑定留旧题并记工作集，返回原题见「再看回复」折叠入口续读（锚点语义）。② 旧任务统一定位——dock 新增 goToQuestion 宿主口（AttemptSession 以 goToQuestionRef 晚绑定打断互引注入 goSingleQuestion），openCompose/openTask/openQuestion 三入口先切题再展开，失败保留现场；仅单题模式且目标非当前题触发切题链，列表模式直接放行维持既有行为。③ URL 深链消费修复——ai 参数清理按 locationRef 最新 search 重算，防统一切题改写 q 后被过期 search 回写 undo。④ 侧栏对照广播——AiCompareActiveContext（rail 值 fixedActive&&open），题卡草稿「自动」布局消费回退 below（题干/草稿/AI 对照不成四列并排）；显式布局偏好不受拉扯；无 Provider 默认 false 不改既有布局。⑤ 测试锁定——AI 输入聚焦键盘不劫持（Enter/←→/数字保持输入语义）、AI 节点不进题面域与反馈区（底图与导出零 AI 输入断言）。
- 记档取舍：jsdom+KaTeX MathML 的 computed-style 缺口（role 查询 miss 时 prettyRoles 转储崩溃）→ 测试改 queryAllByRole+waitFor 手动轮询、选项名用正则；收起失败不设 singleSwitchBlocked（dock 已就地提示，避免双横幅）。
- 编排者独立验收（2026-10-23）：全量 diff 通读（含 returnToWork 语义等价性核对——旧实现 close 成功才记工作集，新 collapseForNavigation 同序保持）；红灯日志核验（/tmp/m4-d2-red.log：8 failed|40 passed EXIT=1，行为失败非导入失败）；编排者自跑 /tmp/m4-d2-accept-{full,tsc,lint,build}.log：5582/5582（472 文件）、TSC/LINT/BUILD 全 0。

### M4-D3 统计口径收尾与结果节奏摘要（2026-10-23，子代理实现，编排者独立验收通过）

- 提交链：6cd0421d（契约先行：analyticsUnitCell/studentRecordRow 增 practiceSubmittedCount(+practiceQuestionCount) 成对可选、studentAssignment 增 practiceSubmittedCount（N 复用既有 questionCount）、attemptResultData 增 practiceWorkflow 可选（与草稿视图同一 schema 单源））→ 53007f4e（服务端：practiceSubmittedCounts 批量聚合落 pending-mark.ts 纯叶模块（500 id 一块分组查询，与 pendingMarkCounts 同款；防循环依赖），接进记录行/学情矩阵/作业列表三消费面——协议判定统一 practiceProtocolOf、矩阵只对 in-progress 格取 draft 卷；buildResultData 经 attemptWorkflowView 携带 practiceWorkflow（lesson/legacy null 零查询早退）；stale 注释改写三处+teacherAttemptCard「待批数=0⇔graded」限定已收尾卷，零行为变化）→ a9a2c3dd（web：记录卡/矩阵格/作业卡「已提交 n/N 题」（v1 卷缺省回落既有呈现）；AttemptResultView 反馈节奏摘要行——per_question「作答时逐题反馈…」/after_attempt「交卷后反馈…」+未公布后缀，legacy/lesson 不渲染）。
- 口径细节：practiceSubmittedCounts 对已收尾卷收敛 n=N（status≠draft ⇒ submitted=total——整卷交卷路径行级 submittedAt 事实两种可能实现下都显示整卷口径，稳健）；n/N 为白名单纯公开进度计数（只读 submittedAt 与行数），路由测试对新增载荷保持 assertNoLeak。
- 记档取舍：任务前提勘误——practiceWorkflow 原本只在草稿视图契约（摸底「数据面已就绪」结论对结果视图不成立），按契约优先补可选字段复用同一 schema；教师侧整卷结果摘要（§13.8「帮助教师理解作答条件」的教师面呈现）未做——学生结果视图已呈现，教师批改页补节奏行记 P1/M6 候选；schema:export 首跑即零产物 diff（新增字段不属导出顶层契约），无产物需提交（幂等已验）。
- 编排者独立验收（2026-10-23）：三笔全量 diff 通读（契约/服务端/web 三面 + 消费面接线逐个核对——批量聚合无 N+1、单源谓词、条件展开不破坏既有字段）；红灯日志核验（/tmp/m4-d3-red.log：契约 7 失败+服务端 3 失败+web 6 失败，均为缺功能断言）；编排者自跑 /tmp/m4-d3-accept-{full,tsc,lint,build}.log：5603/5603（475 文件）、TSC/LINT/BUILD 全 0。

### M4 三闸门与合并验收（2026-10-23，分支 codex/practice-feedback-integration，Claude 会话编排执行）

- /simplify（独立子代理，四角度：复用/简化/抽象层级/死代码；diff 73c875e3..HEAD 38 文件）：应修 0、建议 4、记档 5。四建议全修于 62cf3988（进度 Map 单次 get+!==undefined 展开——student-records 原三重 get+永不可达 ?? 0 收敛为与 analytics/assignment 同款；assignment-service 双间接+空串哨兵拆两步显式取值；AiCompanionDock 三处 `goToQuestion !== undefined && !(await …)` 守卫收敛为模块级 ensureAtQuestion（未注入=已就位；首版箭头表达式 `true | Promise<boolean>` 与返回类型不符，tsc 抓出后改 async 块）；AttemptSession 切题 flush 与 collapse 两段同判定并块）。记档 5：practiceSubmittedCounts 落 pending-mark 叶模块取舍成立（三消费方单向外引无环）；AiCompanionDock finally 里 search 用 locationRef 而 pathname 用闭包旧值（当前等价）；collapseForNavigation 对旧 returnToWork 的语义外扩（不可达态且唯一调用点不读返回值）；三份同形「落 responses.submittedAt」测试助手分属三套夹具体系不抽公共 util；practiceWorkflow 8 字段字面量夹具 contract/web 各一份跨包不共享。
- /code-review（独立子代理，max 力度；定向测试 8 文件 290 用例全绿）：应修 0、建议 3、存疑 3。重点核查结论：goSingleQuestion 异步时序（并发二次点击捕获同一 from 与同一目标，重复 flush/收起幂等收敛）、跨页 ai 参数定位与统一切题的 URL 竞态（旧 run 被 cancelled 短路+新 run 幂等重开，jsdom 集成测试钉住一种真实交错）、practiceSubmittedCounts 聚合口径（draft 行级/收尾卷收敛 n=N，三消费面 practiceProtocolOf 单源）、answersReleased=false 时纯公开计数照发与定案一致、新字段无对错/得分/答案/教师私注列。建议修 2（945e7131，注释级零行为）：pending-mark 头注释「整卷交卷路径不写行级 submittedAt」事实错误——attempt-service rowSubmittedAtPatch（:2062）对逐题语义卷全部 graded 行写交卷时刻（lesson 与 v1 同款），收敛分支改记「防御性口径——语义上已收尾=n/N 同 N 恒成立，勿据行值本就齐全删掉收敛」；teaching-policy v1 分支补整卷收尾同款说明对齐；checkNewSteps/再看回复钉注「只在目标题为当前题时可见可点、非当前题卡 hidden 不可点」的隐含前提（若日后真卸载或折叠入口移常驻栏须补切题守卫）。存疑 3 记档 M6：作业卡 N=live questionCount 与 n=冻结行数口径差（D14 内容锁定下正常不漂移，题目删除链路是否被作业引用拦截待领域复核）；跨页 ai 参数重入交错面（真机若见「定位后回复闪两次/重复 startNew」优先查此）；after_due 未公布时「已提交 2/5 题+待批不显示」并现观感。after_attempt 草稿「已提交 0/N 题」噪音（真实但信息量低）记 M6 真机定夺是否收窄过滤。
- /security-review（独立子代理，max 力度，六焦点：新字段泄露面/AI 出口重校验/身份越权/请求注入/呈现层边界/TOCTOU）：高/中/低发现 0。核对要点：新契约字段全部只出现在响应 schema（本 diff 未给任何请求 schema 增字段）；attemptWorkflowView.practiceWorkflow 投影 strict 白名单穷举核对（releaseAt 仅复制 dueAt，dueAt 本就在作业列表下发，无 answerRelease 模式值/无 publishedAt/无提前泄露信号）；practiceSubmittedCounts 只读 submittedAt 与行数绝无对错/得分/答案列，计数只泄本人「是否已提交」行为事实不构成侧信道；三消费面全部归属校验后域内查询（学生本人/教师本人域）；AI 四通道（任务新建/MCP 领取/票据附件读/回信交付）实时调 resolveAttemptQuestionAiPolicy 不缓存、裁决与状态迁移/规则重装同一事务（better-sqlite3 同步无请求内交错）；教师中途切 post_submit_only：已提交题 completed→恒 open_study 不回锁（定案兑现）、未提交邻题 403+零任务行出站前拦截（D1-18..20 对 fake provider 捕获的真实出站体断言钉住）；SQL 模板全参数化（inArray chunk 绑定值）无新路由无动态拼接；节奏行由服务端 answersReleased 闸驱动无「答案已公布」误导；两个闸门修复提交复核无安全面回退。观察 5 记档：①v1 已收尾结果视图缺 assertNoLeak 直断言——当场补于 7b5a2e5c（on_submit 默认公布下 allow 白名单 answers/answer/solutionMd + choiceHint/judgeHint 哨兵负断言，硬性规则 3 收口；首跑无 allow 的失败实证默认公布策略下答案/详解合法在场，allow 面与既有 released 场景同款）；②after_attempt 0/N（同 code-review 记档）；③作业卡分母口径（同存疑 1）；④v1 逐题 draft 待批数外显系 D4 既有设计同口径；⑤inapp 派发事务提交后到 provider HTTP 调用间的固有窗口系既有双阶段设计（回执落地按任务态二次门禁）非 M4 引入。
- 全量回归（编排者自跑，哨兵日志 /tmp/m4-final-full.log）：pnpm test --maxWorkers=4 5603/5603（475 文件）、typecheck/lint/build exit 0。过程记档：首轮链被系统内存压力于 web 工程段中断（3462 例中 7 例 jsdom 失败，落点恰在闸门修复触碰面）——隔离复跑两文件 35/35 全绿定性为环境性失败非代码回归；内存回升（预检 5198MB≥2500 门槛）后以 4-worker 节流版整链重跑全绿。
- 合并：v2merge 工作树 git merge --no-ff codex/practice-feedback-integration（零冲突，直系后代）→ 快验 → 推送 origin/v2。分支最终形态：D1(5b6dc30d) → D2(62a63ee5) → D3(6cd0421d/53007f4e/a9a2c3dd) → 闸门(62cf3988/945e7131/7b5a2e5c) + 台账提交。

### M5 编排开工（2026-10-23，分支 codex/practice-preferences-dsl，基于 v2@5716bf93，Claude 会话编排）

- 摸底结论（Explore 子代理，缺口图落盘编排会话）：PATCH /attempts/:id/workflow 服务端 M1b 已建成（CAS/错误码/测试齐全），M5 缺口=web UI；frontmatter `practice:` 推荐命名空间、units 推荐列、resolver 推荐档、偏好未设置态、开始页呈现全不存在；feedbackMode 省略语义契约已具备（resolver 缺省档 per_question）；未知 frontmatter 键静默剥离——老文档天然安全。
- 分层：D1 契约+DSL+导入导出往返（推荐 schema→frontmatter/unitSchema(optional)→md-dsl 解析与 lint→units.practiceDefaultsJson 迁移 0039→commitImport 写/清→exportUnitMd/教学包写回→往返/重导/同名合并/samples 测试→spec 文档段+samples 正例+gen:spec 产物）→ D2 resolver 推荐档与三建卷点（assignment 多单元一致才采纳、course 单元推荐、wrong 不参与；web 偏好未设置省略 feedbackMode；landing 契约推荐字段）→ D3 PATCH 节奏切换 UI + 开始页推荐呈现与显式选择 + 设置反馈节奏项 + 状态机抽象再议。
- 裁决预告（D2/D3 依据总计划定案，子代理不得另议）：①存量 M3 偏好的 feedback 值视作已设置（M3 保存动作保存完整对象），不做读迁移手术；文档推荐生效面=从未保存偏好的学生；开始页显式选择恒最高优先（§5.4 档 2）。②wrong-practice 不参与文档推荐（无单元语义，§5.1 错题重练用所属教师默认规则）。③layout 推荐只影响开始页预选呈现（layout 非权限、不进 start columns；服务端建卷列仍仅 feedbackMode）。④导出无推荐不写 practice 行（老文件字节级稳定）；重导无字段置 null 清除（teachingPackJson 同款口径）。⑤lecture/lesson 声明 practice → warning「不适用」，讲练语义零变化；非法值 → schema error。⑥多单元推荐冲突回学生偏好/缺省 + 开始页允许选择，不拼多节奏。⑦unitSchema 推荐字段必须 optional 禁 default 注入（防 parse.test toEqual 精确断言破裂）。⑧units 新列随表级备份走，恢复不丢不放宽（§6.2），补恢复测试断言。

### M5-D1 契约+DSL+导入导出往返（2026-10-23，独立验收，Claude 编排）

- 子代理交付 7 提交（2a59c09d→fecd9751，29 文件 +5158/−118）：契约 practiceRecommendationSchema（strict 双可选）+ frontmatter/unitSchema 挂 practice 可选（禁 default，裁定⑦）；parse.ts kind 门控贯通（practice/mixed 进单元、lecture/lesson 不进，裁定⑤）；lint PRACTICE_NOT_APPLICABLE warning（lecture/lesson 带 practice 提示不阻断，非法值走既有 INVALID_FRONTMATTER error）；spec gen 练习推荐小节 + LINT_RULES 注册；样例 samples/v2/练习推荐样例.md（自动入样例回归，裁定⑫）；迁移 0039 units.practice_defaults_json（drizzle 生成含快照账本）；commitImport 双 upsert 路径写/清（无字段置 null，裁定④）；exportUnitMd 确定性 flow 映射行 practiceYamlLineOf（坏 JSON/契约失败→null+warn 不抛）、无推荐不写行老单元字节级不变；回填保真对比排除新列（随 0039 迁移同口径）；备份往返断言不丢。红灯日志 /tmp/m5-d1-red.log（3 failed：teaching-pack/library 导入导出路径先行红）。
- 编排者验收：全 diff 逐文件读过（契约/解析/lint/spec/迁移/导入/导出/测试/样例）符合裁定与 brief；红灯日志核实；全量回归 pnpm test --maxWorkers=4 5633/5633（476 文件）、typecheck/lint exit 0、gen:spec 双跑 git diff 为空（哨兵 /tmp/m5-d1-accept-*.log）。

### M5-D2 推荐档接入建卷裁决链（2026-10-23，独立验收，Claude 编排）

- 子代理交付 3 提交（27109389→80909da1，22 文件 +1221/−148）：契约 feedback 改可选（禁 default，裁定①⑦——存量 M3 全量形态天然已设置）+ landing practiceRecommendation nullable；裁决链 studentChoice ?? unitRecommendation ?? per_question 整体被 allowedFeedbackModes 收敛（教师限制最终裁决）、续作不读推荐；wiring unitFeedbackRecommendationOf——assignment 按 assignment_units 聚合非空一致才采纳（裁定⑥）、course 单元直取、wrong 恒 null（裁定②）、坏 JSON/契约失败 null+warn、units 复合主键按教师域读（T2B.5）；landing 下发坏数据不下发原文；web 偏好 store feedback null=未设置、保存布局不补写伪造 feedback、workflowStartOptions 未设置整键不发。红灯 /tmp/m5-d2-red.log（26 failed 先行红）。偏离 brief 三项均合理：路径笔误纠正、C1 连带提交保每步绿（硬规则 8）、首轮 SAI-11 环境性抖动（编排者复跑未复现）。
- 编排者验收：全 diff 逐文件读过（契约/裁决器/wiring/landing/store/发送链/测试）符合裁定①②⑥⑦；assertNoQuestionFields 泄露断言实调用核实（assertNoLeak 全局禁键+题目侧字段）；schema:export 产物零变更成立（改动面不在 content 契约导出集）；自跑全量 5665/5665（478 文件）、typecheck/lint exit 0、gen:spec 双跑 git status 仅余未跟踪交接文档（哨兵 /tmp/m5-d2-accept-*.log）。
- 附带核查：practiceWorkflowStartOptionsFields.feedbackMode 本就 optional（M1 设计），web 省键契约合法；tutor-lint.mjs 变更系契约源内嵌随 gen:spec 联动，重生成零 drift。

### M5 追加裁决⑨：开始页预选与显式选择（2026-10-23，D3 派单前定案）

- 偏好 schema 的 `layout` 与 `feedback` 同款可选（键缺省=未设置）：存量 M3 文件两字段都带（保存动作一直写全量形态）→ 天然视作已设置；未保存过的学生才是文档推荐生效面。不引入读写迁移。
- 开始页选择器初值 = 已保存偏好 ?? 单元推荐 ?? 缺省（布局 list、节奏 per_question）；显式点选后本次访问内恒定。
- 「开始练习」仅当学生本次显式触碰过节奏选择器才随请求发 feedbackMode（预裁决①开始页显式选择恒最高）；未触碰维持 D2 链（已设置发偏好、未设置整键不发）。
- 布局预选不经服务端（预裁决③）：模块级一次性 transient 携带，作答页初值消费一次后清除；硬刷新直写作答页回落本机偏好（「进入时取一次」语义不变）。
