收到指令：**后续子 Agent 一律改用 flash 子智能体（GLM 5.3-flash）**，不再用 GLM 5.3。说明一点：B01 在指令到达前已用默认模型派出并返回（6 条发现），其结果仍要过逐字验收；从本轮起 B02–B09 及所有重派全部走 flash。

B01 已返回（🔴1 🟡1 🟢4）。现在并行做三件事：① 按 阶段3 对 B01 做证据逐字核对（🔴 全查、🟡🟢 抽查 60%）；② 读取 B04 批次代码；③ 用 flash 派出 B02、B03。

三个子 Agent 均已返回，我先做验收核对，同时发现一个拆批脚本 bug 必须先修复：**B04.txt 被错误写成了后半段内容（与 B05 相同），assignments.test.ts 的前半（约 L1–L953）尚未进任何批次**。B05 本身正确（续接头完好）。现在：① 重算 B04 为真正的前半；② 核对 B02 两条疑似证据不实的引用（L22、L263 是否真的不在批输入中）；③ 读取 B06 待派。

B04 已修复为真正的前半（948 行，L1–L953）✓。B01 作废项复核确认：`^794|` 在批输入中不存在（0 命中）、真实 L394 是带缩进的正常闭合 `  });` —— 该 🔴 确系证据不实，作废。B02 的 L22 确认不在批输入（作废）；L263 需用完整引文再精查。现在：用 flash 派出 B05、B06（B04 等读回修复后的内容后即派），同时精查 B02、读回 B04。

B05 已返回（🔴1 🟡1 🟢2），验收通过：四条证据引用与批输入逐字一致（标题与断言矛盾那条是实打实的测试自相矛盾），汇总行 4 条与明细一致。继续派 B06（flash），同时读回修复后的 B04 与下一批 B07，并精查 B02 最后一条待核证据。

B06 已返回（🟡1 🟢4），验收通过：5 条证据全部与批输入逐字一致（含 paper 与详情/存答鉴权口径不一那条有价值的 🟡），汇总行一致。B02 最后一条待核证据确认不在批输入（0 命中）→ 作废并记录；B02 终态：🔴1 🟢2 有效。

现在读回修复后的 B04 全文及剩余三批（B07、B08、B09），随后一次性派满 3 路并发。

B04（前半，修复后 948 行）、B07、B08、B09 内容全部就绪。现在派出 B04、B07、B08（flash，3 路并发）；B09 待本波收单后补派。

**状态表**：B01✅ B02✅ B03✅ B05✅ B06✅（验收全过，5 条作废记录在案）｜ B04/B07/B08 运行中 ｜ B09 待派。

B04、B07、B08 全部返回并验收通过（证据逐字核对一致，汇总行与明细一致）：
- **B04**：🟡2 🟢2 —— 含两条有价值的测试质量发现（倒序假设 flaky、summary 语义 pending/unanswered 重叠存疑）
- **B07**：🟡1 —— hasAttempts 语义扩为「有作答或有作业」但契约注释/前端文案仍是旧口径（引用了批外文件 → 记需跨批上下文）
- **B08**：🟡2 🟢1 —— 旧作业引用无兜底、usage 无排序、讲义标题未过滤软删

派出最后一批 B09。

B09 已返回（🔴1 🟡1 🟢2）。其中 🔴 的核心证据行（L166-170）落在摘录区之外（摘录只含改动区 L109-163、L208-258），子 Agent 自述已对照仓库实际文件核实——按验收规则我需要亲自核对这几行是否真实存在于源文件，再决定该条是“作废”还是“需跨批上下文”。

B09 的摘录外证据核对通过：L166、L170、L66 注释均逐字存在于源文件 → 该 🔴 按“需跨批上下文”保留（不作废）。**全部 9 批终态，进入阶段 4/5：去重合并 + 最终报告。**

# 代码审查总报告

## 执行统计

派出 **9** 批 / 合格 **9** / 退回后通过 **0** / 失败丢弃 **0**；峰值并发 **3/3**；子 Agent 共 **9** 个（B01 为默认模型、在“改用 flash”指令到达前已返回；B02–B09 均为 flash/GLM-5.3-flash）。子 Agent 原始返回 **38** 条，验收作废 **3** 条（证据不实/引用行不在批输入，见覆盖缺口），同根因合并 **1** 组（B03 两条 🔴 → 1 条）。去重后发现 **🔴2 🟡9 🟢20**，另 **3** 条因引用批外文件转“需跨批上下文”。

审查对象：会话开始时快照的 **24 个改动文件**（契约层 + 服务端，T2A.7「作业多单元与名单结构」），快照 = HEAD `984c45b` 时点工作区、聚焦 diff 改动区 ±20 行（共 7183 行）。按用户指示未纳入会话中途出现的 8 个前端文件。拆批脚本一处装配 bug（B04 曾误装为后半）在派单前发现并修复，未产生失败批次。

## 建议优先复核（最多 5 条）

1. `apps/server/src/routes/assignments.test.ts:1079` — 测试标题声称“重复先报 400 DUPLICATE_UNIT”，断言却锁定 409，且未断言错误码（D14 校验顺序无有效规格）。来源：[🔴|B05]
2. `packages/contract/src/attempt.test.ts:60-66` — course 来源 fixture 经展开继承 `unitId: null`，把“course 来源 unitId 为空”锁定为契约合法形状，与契约注释「course 来源恒有值」矛盾。来源：[🔴|B02]
3. `apps/server/src/services/assignment-service.ts:887-891、1054-1055` — D16 软删单元口径：学生列表剔除软删单元题数 + paper 整组过滤软删单元（需跨批上下文；审查期间分支已继续演进，该子 Agent 核实后续提交 c18d290 已反转此口径，请以最新代码为准）。来源：[🔴|B03]

## 发现清单

### 🔴（大概率 bug / 契约不匹配）

**[🔴|B05] apps/server/src/routes/assignments.test.ts:1079 — 测试标题与断言直接矛盾：标题声称先报 400，断言却锁定 409**
- 证据：`1079|   it("锁定后 unitIds 重复仍先报 400 DUPLICATE_UNIT（校验顺序不因锁定放宽）", async () => {`；`1090|     expect(res.status).toBe(409); // 锁定优先（D14：锁定即不可改内容）`
- 风险：标题与行内注释互斥，必有一方错误；当前断言把实现钉在 409，标题宣称的校验顺序完全未被验证，且全程未断言错误码，任何 409 都能通过，无法作为 D14 规格依据（跨批验收注：B03 批实现侧确为“先判锁定后校验”，断言与实现一致、标题错）。
- 建议：对照 D14 需求确认预期顺序；改标题并补 `ASSIGNMENT_CONTENT_LOCKED` 错误码断言（或反向改断言 + 补 `DUPLICATE_UNIT` 断言）。
- 置信度：高

**[🔴|B02] packages/contract/src/attempt.test.ts:60-66 — course 来源摘要 fixture 的 unitId 继承为 null，被测试锁定为合法形状**
- 证据：`44|  unitId: null,`（SUMMARY_DRAFT）；`59| /** 课程练习来源的摘要（D9/D10：courseId 非空、assignmentId 空、attemptNo 递增） */` `60| const SUMMARY_COURSE_SECOND = {` `61|   ...SUMMARY_DRAFT,`；契约注释 `71|    * 目标练习单元（units.id）：course 来源恒有值（单单元）；assignment 来源`
- 风险：fixture 覆盖 attemptNo=2 却漏覆盖 unitId，`attemptStartDataSchema.parse(SUMMARY_COURSE_SECOND)` 照样通过——契约测试把“course 来源 unitId=null”blessing 为合法；服务端若漏填，契约层拦不住，前端按“恒有值”写的逻辑拿到 null 即破坏。
- 建议：fixture 补 `unitId: UNIT_ID`；如需锁定 assignment 来源 unitId=null 的反面样例，另加断言。
- 置信度：高

### 🟡（疑似问题，需上下文确认）

**[🟡|B01] packages/contract/src/assignment.ts:41 — 状态优先级注释含枚举中不存在的 "draft"，漏 "in_progress"**
- 证据：`41|  * 优先级 graded > submitted > draft > 无记录。`；`45|   "in_progress",`
- 风险：旧状态机残留；实现者按此注释理解优先级顺序会走错分支口径。
- 建议：改为 “graded > submitted > in_progress > not_started”。
- 置信度：高

**[🟡|B05] apps/server/src/routes/assignments.test.ts:1137 — 测试名承诺“再交一次次数递增”，测试体只交卷一次**
- 证据：`1137|   it("学生在课程练习交卷过 → 返回正确次数（含课程名/单元标题）；再交一次次数递增", async () => {`；断言止于 `1183|         submittedCount: 1,`
- 风险：“递增”行为无覆盖，累计计数被破坏时此处不会失败。
- 建议：补第二次交卷后 `submittedCount: 2` 断言，或删去标题中的递增承诺。
- 置信度：高

**[🟡|B06] apps/server/src/services/attempt-service.ts:549-558 — 取卷（paper）与详情/存答的鉴权口径不一致**
- 证据：`549|   if (attempt.sourceType === "course") {`（paper 对 course 来源恒重校验、assignment 来源走 requireAssignmentVisible）；对照 `161|   if (attempt.sourceType === "course" && attempt.status === "draft") {` 与注释 `86|  * - course 来源 + 已交卷：只读记录，不做课程校验（D7/D10：已交卷课程练习记录`
- 风险：同一份作答的两个入口闸门相反——assignment 来源被移出名单后详情/存答仍 200 但 paper 403/404；course 来源已交卷可看结果视图却取不到卷面；前端若走 paper 接口会出现“能存答案拿不到卷面”的割裂。
- 建议：确认 D7/D10 与 D22 两套注释是否确为有意分层；若非，paper 对 draft 复用 requireUsableAttempt 口径。
- 置信度：中

**[🟡|B08] apps/server/src/services/library-service.ts:368-372 — 作业引用查询只走 assignment_units，对存量旧作业无兜底，与 attempts 双路径兜底不对称**
- 证据：`368|     .from(assignmentUnits)`、`371|       and(eq(assignmentUnits.unitId, unitId), isNull(assignments.deletedAt)),`；对照同文件兜底注释 `378|  * - attempts.unitId 直接命中（course 来源与旧 assignment 行）；`；同样单路径也在 `601|     .select({ unitId: assignmentUnits.unitId })`
- 风险：若迁移未把存量 `assignments.unitId` 回填进 assignment_units，getUnitUsage 与题库作业数漏计旧作业引用，purge 前置校验（D3）被绕过（跨批验收注：分支提交记录显示迁移含“D23-5 回填”，需人工确认覆盖完整）。
- 建议：确认回填覆盖；若无，两处查询补 `eq(assignments.unitId, unitId)` OR 关联命中的兜底分支。
- 置信度：中

**[🟡|B09] apps/server/src/services/hint-service.ts:234-238 — draftHintsOpenedView 未过滤软删题，与草稿题目清单口径不一致**
- 证据：`237|           .where(inArray(questions.unitId, unitIds))`（无 deletedAt 过滤）；对照注释 `247|     if (hints === undefined) continue; // 已移出单元的题不回显（与草稿清理口径一致）`
- 风险：草稿期题目被软删后 hintsOpened 仍回显该题条目，而 units[].questions 已不含此题，产生孤儿键（仅学生自己解锁过的序号，不构成新泄露）。
- 建议：该查询补 `isNull(questions.deletedAt)`（另见 B06 🟢 drafts 未过滤，同族口径问题）。
- 置信度：中

**[🟡|B04] apps/server/src/routes/assignments.test.ts:687-688 — 学生列表倒序假设在近同时创建时可能不稳定，`as string` 掩盖空值**
- 证据：`687|     // 学生列表按布置时间倒序：[0] 是后创建的「单元 A 作业」` `688|     const unitAAssignmentId = (await studentList(app, cookie))[0]?.id as string;`
- 风险：两份作业相邻毫秒创建，若排序键无确定性决胜键则 `[0]` 可能取错，断言 flaky；列表为空时 `undefined as string` 把问题推迟且报错误导。
- 建议：确认服务端排序含决胜键；或按 units 内容筛选目标作业。
- 置信度：低

**[🟡|B04] apps/server/src/routes/assignments.test.ts:641-653 — summary 语义存疑：未作答的可自动判题同时计入 pending 与 unanswered**
- 证据：`641|     // fillB2 不作答（未答也进 responses，计待批/未答）`；`650|       pending: 1,` `651|       unanswered: 1,`
- 风险：若契约本意 pending=需人工批改则为判分口径 bug 被测试固化；若 pending=未定论题数则命名误导消费方（跨批验收注：B02 批契约注释定义 pending=“未作答 + 需教师批改”，即设计如此，属命名/文档易误解项）。
- 建议：在契约注释中显式写明 pending 口径，避免前端当“待人工批改”展示。
- 置信度：低

**[🟡|B08] apps/server/src/services/library-service.ts:591-597 — lectureTitles 全量取讲义未过滤 deletedAt，与同函数其他数据删除口径不一**
- 证据：`592|       .select({ id: lectures.id, title: lectures.title })` `593|       .from(lectures)` `594|       .all()`（无 where）；对照 `623|     .where(isNull(questions.deletedAt))`
- 风险：回收站内软删讲义的标题仍出现在题库列表配套讲义展示；教师端接口、无泄露问题，属删除口径漏网或有意保留。
- 建议：明确口径——补 `isNull(lectures.deletedAt)` 或加注释说明刻意保留。
- 置信度：低

### 🟢（防御性缺失，不影响当前正确性）

**[🟢|B03] apps/server/src/services/assignment-service.ts:527-539 — 移出校验对 removeIds 逐个发 attempts 查询（N+1）**
- 证据：`527|       const started = removeIds.filter(`，循环体内 `529|           db` `530|             .select({ id: attempts.id })` `531|             .from(attempts)`
- 风险：移出名单较长时每生一条 SQL；正确性无影响。`1059|       questions: unitPublicQuestions(db, unit.unitId),` 按单元逐个查询属同类。
- 建议：一条 `inArray(attempts.studentId, removeIds)` + assignmentId 查询取已开始集合。
- 置信度：高

**[🟢|B04] apps/server/src/routes/assignments.test.ts:567 — 夹具恒返回 `db: undefined`，误导性残留**
- 证据：`566|     return {` `567|       app,` `567|       db: undefined,`（原文：`567|       db: undefined,`）
- 风险：后续维护者按 makeApp 形状使用 `env.db` 会在运行时对 undefined 取属性报错。
- 建议：删除该字段或补真实 db 引用。
- 置信度：高

**[🟢|B04] apps/server/src/routes/assignments.test.ts:893-921 — 用例标题声称验证“行复用”，断言只覆盖可见性恢复**
- 证据：`893|   it("移出不在册学生返回 400；曾移出再加回恢复在册（行复用）", async () => {`；断言仅 `919|     expect(back.status).toBe(200);` `920|     expect((await studentList(env.app, env.aCookie)).length).toBe(1);`
- 风险：实现改为删行+插行本用例仍绿，行复用（addedAt 保留/行数不增）回归未被守护。
- 建议：补 db 层断言或把标题收窄。
- 置信度：高

**[🟢|B08] apps/server/src/services/library-service.ts:362-373 — usageAssignmentRefs 无排序，返回顺序依赖 SQLite 实现细节**
- 证据：`372|     )` `373|     .all();`（全程无 orderBy）；对照同文件 `346|     .orderBy(asc(courses.order), asc(courses.title))`
- 风险：单元被多个作业引用时 usage 面板顺序不稳定。
- 建议：补确定性排序。
- 置信度：高

**[🟢|B02] packages/contract/src/attempt.ts:61-88 — attemptSummarySchema 未按 sourceType 锁定交叉不变式**
- 证据：`67|   assignmentId: z.uuid().nullable(),` `69|   courseId: z.uuid().nullable(),` `75|   unitId: z.string().min(1).nullable(),`（不变式仅存在于注释）
- 风险：违反不变式的数据契约层不报错（上面 🔴 即被 fixture 触发）。
- 建议：加 refine 集中校验 source 条件字段组合（另见 🔴|B02）。
- 置信度：中

**[🟢|B02] packages/contract/src/attempt.ts:275-278 — 详情 union 无判别键，超集载荷静默落入 draft 分支**
- 证据：`275| export const attemptDetailDataSchema = z.union([` `276|   attemptDraftDataSchema,` `277|   attemptResultDataSchema,` `278| ]);`
- 风险：两分支共享 units 后区分键只剩顶层键存在性，服务端状态/视图错配时客户端静默解析错分支且多余键被 strip。
- 建议：分支加 `strict()` 或 superRefine 校验 attempt.status 与视图形状一致。
- 置信度：中

**[🟢|B03] apps/server/src/services/assignment-service.ts:908,914 — JSON.parse 无容错，坏数据炸成 500**
- 证据：`908|   const parsed: unknown = JSON.parse(hintsJson);`；`914|   const parsed: unknown = JSON.parse(optionsJson);`
- 风险：非法 JSON 的历史/导入数据使 SyntaxError 穿透为通用 500 而非业务错误码。
- 建议：包 try/catch，解析失败按空数组处理或抛带码 HttpError。
- 置信度：中

**[🟢|B05] apps/server/src/routes/assignments.test.ts:1214 — saveAnswer/submitAttempt 返回状态未断言，“作业作答不计入”场景可能空转通过**
- 证据：`1214|     await saveAnswer(env.app, env.aCookie, aAttempt.id as string, qid, {`；`1218|     await submitAttempt(env.app, env.aCookie, aAttempt.id as string);`
- 风险：两者静默失败时 attempt 停在 draft，`hints=[]` 断言依然通过，“作业作答不计入”分支可能未被构造。
- 建议：断言 200 / 消费返回体。
- 置信度：中

**[🟢|B06] apps/server/src/services/attempt-service.ts:849-850 — 快照 safeParse 失败静默丢题，错误被吞且无日志**
- 证据：`849|   const parsed = questionSchema.safeParse(jsonOf(snapshotJson));` `850|   if (!parsed.success) return null;`
- 风险：快照坏数据时整题从结果视图与 summary 无声消失，与交卷时写入的 scoreAuto 对不上，排查无入手点。
- 建议：失败时记录 attemptId/questionId/error。
- 置信度：中

**[🟢|B06] apps/server/src/routes/student-attempts.test.ts:459-463 — every() 断言在 units 为空时真空真，测不出分组丢题回归**
- 证据：`460|       data.units.every((unit) =>` `461|         unit.questions.every((q) => q.autoCorrect === true),`
- 风险：分组回归导致 units 空数组时断言恒真；summary 与 units 独立也测不出“题在 summary 不在 units”。
- 建议：flatten 后逐题断言（仿同文件 L495-508）。
- 置信度：中

**[🟢|B09] apps/server/src/services/ink-service.ts:187-199 — 限额只按压缩后字节计，gunzip 解压无上限，gzip 炸弹可放大内存**
- 证据：`188|     strokesBytes.byteLength + snapshotBytes.byteLength >`；`199|   const doc = parseStrokesDoc(strokesBytes);`
- 风险：≤2MiB 的 gzip 炸弹解压可达千倍放大，造成内存峰值/DoS（单机自部署、已登录学生可触发）。（验收注：parseStrokesDoc 主体在摘录外，编排者已核对函数真实存在且走 gunzip 路径。）
- 建议：解压后校验字节上限。
- 置信度：中

**[🟢|B01] packages/contract/src/assignment.ts:221 — deletedAt 用裸 `z.string().nullable()`，与同结构 createdAt/dueAt 口径不一**
- 证据：`221|   deletedAt: z.string().nullable(),`；对照 `223|   createdAt: z.string().min(1),`
- 风险：注释承诺 UTC ISO 但 schema 不校验；误写空串不被拦截，前端排序/展示得到静默坏数据。
- 建议：统一为 `min(1)` 或 `z.iso.datetime()`。
- 置信度：中

**[🟢|B01] packages/contract/src/assignment.ts:76-78 — defaultAssignmentTitle 空数组返回空串，与 title min(1) 契约相抵**
- 证据：`77|   const first = unitTitles[0] ?? "";` `78|   if (unitTitles.length <= 1) return first;`
- 风险：当前有 unitIds.min(1) 挡住；导出纯函数被无校验路径复用时静默产出空标题入库。
- 建议：空数组抛错或返回类型改 `string | null`。
- 置信度：中

**[🟢|B01] packages/contract/src/assignment.ts:114-121 — PATCH 契约缺 courseId：创建可挂课程、创建后无法改挂/摘除**
- 证据：`114| export const assignmentUpdateRequestSchema = z.object({` `115|   title: assignmentTitleSchema.optional(),`（无 courseId 字段）；对照 create 侧 `96|   courseId: z.uuid("courseId 必须是 UUID 格式").nullable().optional(),`
- 风险：需求若隐含“调整所属课程”则契约无入口；若有意不支持，JSDoc 未言明。
- 建议：确认需求；不支持则在注释写明“courseId 创建后不可改”。
- 置信度：低

**[🟢|B01] packages/contract/src/assignment.ts:348-349 — CONFIRM_REQUIRED 错误壳的 `_students` 无 schema 定义**
- 证据：`348|  * - CONFIRM_REQUIRED：移出已开始作答的学生未带 confirmStarted（409，D13/T2A.7；` `349|  *   错误壳附带 _students: [{studentId, displayName}]）；`
- 风险：错误壳若为 strip 语义，`_students` 可能被剥离，确认弹层拿不到名单（跨批验收注：B04 批测试 L827-831 在运行时断言 `_students` 存在，行为有测试锁定，缺口在契约层无 schema）。
- 建议：为该错误壳定义带 `_students` 的变体或补测试。
- 置信度：低

**[🟢|B03] apps/server/src/services/assignment-service.ts:252 — addedAt 空值回退为空串，违反契约 min(1)**
- 证据：`252|       addedAt: row.addedAt ?? "",`
- 风险：存在未回填 NULL 历史行时详情下发 `""`，与契约 `min(1)` 不符且排序被当最早。
- 建议：确认 D23-5 回填覆盖后收紧，或回退值改时间戳。
- 置信度：低

**[🟢|B05] apps/server/src/routes/assignments.test.ts:963 — “课程移出张三”的 DELETE 响应状态未断言**
- 证据：`963|     await request(` `964|       app,` `965|       \`/api/teacher/courses/${courseId}/members\`,` `966|       { studentIds: [aId] },` `967|       teacherCookie,` `968|       "DELETE",` `969|     );`
- 风险：关键前置步骤失败不会被发现；“移出课程”条件可能未被真正构造。
- 建议：断言 DELETE 返回 200。
- 置信度：低

**[🟢|B06] apps/server/src/services/attempt-service.ts:431-438 — assignment 开卷“先查后插”幂等未包事务（course 路径 D10 明示有事务）**
- 证据：`431|   const draft = existing.find((row) => row.status === "draft");` `432|   if (draft !== undefined) return attemptSummaryOf(draft);`；`438|   db.insert(attempts)`（直接用 db 而非 tx）
- 风险：并发双 POST 理论可各建一份 draft；当前同步 SQLite 单进程下不交织，多进程部署显现。
- 建议：与 course 路径一致包 db.transaction，或注明单进程假设。
- 置信度：低

**[🟢|B06] apps/server/src/services/attempt-service.ts:827-831 — 草稿回显 drafts 未按当前单元集合过滤**
- 证据：`827|   const drafts: Record<string, StudentAnswer> = {};` `828|   for (const row of draftRows) {` `829|     const answer = answerOf(row.answerJson);`
- 风险：题目/单元存草稿后被软删或移出，不可见题目的旧草稿仍按 questionId 回显，与 D16 草稿口径字面有出入（仅本人答案，无泄露）。
- 建议：组装 drafts 时按题集合过滤（另见 🟡|B09 同族问题）。
- 置信度：低

**[🟢|B09] apps/server/src/services/hint-service.ts:110-121 — 快照解析失败静默回退当前题行，偏离“已交卷冻结快照”口径且无日志**
- 证据：`114|     if (parsed.success) return parsed.data.hints;`（失败继续向下）；`121|   return hintsOfJson(questionRow?.hintsJson ?? null);`
- 风险：快照损坏时已交卷回看拿到编辑后的当前提示而非冻结版本，无错误信号。
- 建议：失败时至少记日志。
- 置信度：低

### 需跨批上下文（引用了批外文件/摘录外区域，计入待汇总，不算作废）

**[🔴|B03] apps/server/src/services/assignment-service.ts:1054-1055 与 887-891 — D16 软删单元口径：paper 整组过滤软删单元 + 学生列表题数剔除软删单元（同根因两条合并）**
- 证据：`1054|   const unitsOf = unitRows` `1055|     .filter((unit) => unit.deletedAt === null)`；`887|         // 题数只计未软删单元（与 paper/判分口径一致，D16）` `888|         questionCount: unitList.reduce(` `890|             unit.deleted ? sum : sum + (counts.get(unit.unitId) ?? 0),`
- 风险（原述）：子 Agent 依据批外契约/需求文档主张“单元软删不影响出卷、题目照常下发”，认为两处过滤使学生端少单元、两端题数不一致。**跨批验收核对**：本快照内 B01 契约注释（“live 题数为 0 的单元不出现”）、B04/B05 测试断言（软删后 paper 只剩其余单元、已删单元题目 404、学生 questionCount=2）与实现一致；B06 的 attemptUnitIds 同口径排除软删单元。即快照内自洽，子 Agent 引用的相反契约文本不在批输入中；且该子 Agent 自查仓库发现后续提交 c18d290 已按其主张反转修复——属口径演进争议，请人工对照最新契约与需求定论。
- 建议（原述）：与 HEAD 对齐或与需求方确认 D16 口径后统一契约注释、实现与测试。
- 置信度：高（就口径冲突存在而言）；处置：需跨批上下文

**[🔴|B09] apps/server/src/services/hint-service.ts:166-170+208 — 提示被删减后重开提示时 hintsRemaining 为负，违反契约 min(0)**
- 证据：`166|   const opened = openedIndexesOf(existing?.hintsOpenedJson ?? null);` `170|   const hintsUsed = nextOpened.length; // 去重口径：同条重复请求不涨`（此两行在摘录外，编排者已逐字核对真实存在于源文件）；`208|     hintsRemaining: hints.length - hintsUsed,`（批内）；契约侧 `hintsRemaining: z.number().int().min(0)`（B02 批输入可证）。
- 风险：草稿期解锁全部 N 条提示后教师删减提示至 M<N，再次请求任一提示即返回 hintsRemaining<0，违反自身 Zod 契约；前端契约解析会抛错或界面显示负数（原述另引用批外 routes/student.ts 未回验，一并待人工确认）。
- 建议：写回前将 nextOpened 按 `index < hints.length` 收敛，或对 hintsRemaining/hintsUsed 做 clamp。
- 置信度：中；处置：需跨批上下文

**[🟡|B07] apps/server/src/services/course-service.ts:969 — hasAttempts 语义已扩为「有作答或有作业」，契约注释与前端文案仍按旧口径**
- 证据：`969|     const hasAttempts = attempted.has(course.id) || assigned.has(course.id);`；`861|  * - ∃ assignments.courseId = 该课程（按课程布置的作业——多单元作业 attempt 的`（批内）；批外引用：契约 course-api.ts 的字段注释与前端 CoursesPage 两处文案（“有作答记录”）。
- 风险：只布置了作业、零作答的课程也显示 hasAttempts=true，教师看到与事实不符的文案；删除守卫本身正确（子 Agent 已核实三处消费方同源，无“列表可删详情拒删”不一致）。
- 建议：同步契约注释与前端文案（如“已有作答或作业”）。
- 置信度：中；处置：需跨批上下文

## 覆盖缺口

- **作废条目（3 条，防幻觉机制拦截）**：B01 🔴“文件末尾两个孤立 `});`”——引用行号（794/795）在批输入中不存在，真实文件尾部经编排者核对为正常的 it/describe 闭合，无语法问题；B02 🟡“attempt.test.ts:22 头注释过时”与 B02 🟢“hintCount 计数无约束”——引用行（L22、L263）不在该批摘录输入中（属未变更/区外行），证据引用不出来，按规则作废并记录。此两处对应代码区未被任何批审到。
- **快照边界**：按用户指示以会话开始时的 24 文件为准；会话中途工作区/分支继续演进（新出现 8 个前端文件与后续提交），**前端改动（apps/web 下 api.ts、AssignmentsPage.tsx/.test.tsx、assignment-queries.ts、AttemptSession.tsx、AttemptResultView.tsx、StudentAttemptPage.tsx、student-ui.tsx）零覆盖**。B03 批子 Agent 自述其两条 🔴 在更新的提交 c18d290 中已被修复，人工复核请以最新代码为准。
- **摘录边界**：审查材料为 diff 改动区 ±20 行，未变更区域不在范围内。已知区外引用：B04 指出 assignments.test.ts L202-208（loginStudent 尾部）未审；B09 的 L164-172（编排者已代为逐字核对存在）与 parseStrokesDoc 主体未入摘录。
- **抽检说明**：全部 35 条有效发现的证据均做了逐字核对（🔴 100%、🟡/🟢 实际 100%，超出 30% 抽检要求）；3 条作废未计入。9 批全部一次验收通过，无退回重做、无失败丢弃。

报告完毕，编排任务结束。后续如对某批次/某条目有追问，我只依据状态表与子 Agent 返回内容回答，不产生新发现。