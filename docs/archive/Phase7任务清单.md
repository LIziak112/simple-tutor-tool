# Phase 7 任务清单（能力面与教学包）

> 配套文档：`docs/组件渲染核心精进方案.md`（设计依据，冲突时以方案为准）、`docs/技术架构与实施方案.md`、`docs/进度表.md`（唯一打勾处）。
> 2026-10-09 修订：按个人项目的最小闭环补齐边界；用户确认辅助能力可以关闭，正式作答始终可用。本文是实施计划，不表示功能已经完成。
> 执行对象：普通模型，每次只下达一个任务。保留 T7.1–T7.10 编号，不新增阶段或平台。

---

## 0. 使用方法与固定边界

### 0.1 每个任务的下达提示词

```
阅读 AGENTS.md、docs/组件渲染核心精进方案.md、docs/技术架构与实施方案.md、docs/Phase7任务清单.md。
按 task-workflow 执行任务 <T7.x>，只做该任务范围内的事。
1. 先列出要新建/修改的文件、实现步骤、失败测试和验收点，等我回复“确认”。
2. 确认后建任务分支，按 TDD 实施；沿用现有技术栈和服务，不预造扩展框架。
3. 对完整 diff 按 AGENTS.md 跑 simplify、code-review；触及学生载荷或答案加 security-review，修复确认的问题。
4. 运行 pnpm lint、pnpm typecheck、pnpm test、pnpm build，贴真实结果；相关 E2E 本地验证，合并前既有 CI 的完整 E2E 必须通过。
5. 涉及契约、注册表、lint、CLI 时运行 schema:export / gen:spec 并提交产物，再生成一次检查无新增变化。
6. 逐条对照本任务验收，列出人工项；通过后先合并 v2，按发布闸门再发 main，进度只在进度表打勾。
7. 本文已确定的边界直接执行；只有影响功能设想且未覆盖的决策才询问用户。
```

### 0.2 执行规则

- 每个任务一个 `task/T7x` 分支，小步提交；不得把工作区的其他修改带进任务。具体实施仍先出计划等确认。
- 建议顺序：**T7.1 → T7.9 → T7.2 → T7.3 → T7.4 → T7.5 → T7.6 → T7.7 → T7.8 → T7.10**。T7.9 提前补回归门禁；各任务的硬依赖见下文。
- 默认串行。确需并行时 T7.5/T7.6 可在 T7.4 后推进，但须检查共享契约、生成产物；T7.7/T7.8 均涉及契约、迁移和 lint，不预设“无共享文件”。
- 带 🧑 的验收需用户本人检查，通过后才完成。任务完成只在 `docs/进度表.md` 打勾，不在本文重复记录进度。
- 新增指令走“注册表 → 组件 → 样例测试 → pnpm gen:spec”；类型来自 contract 的 Zod schema，禁止 any 和前后端手抄同形类型。
- 数据库变更先改 Drizzle schema，再 `pnpm db:generate` 生成迁移；不得手写迁移或手改线上库。
- 新产物必须加入提交；“gen:spec 后无变化”指已提交分支再生成无产物漂移，检查包括新文件。不要在有其他未提交修改的工作区以全仓 diff 是否为空判定幂等。
- 纯文档改动不写实现测试；本清单落地的功能任务执行 TDD 与质量闸门，不因个人项目省略既有兼容和泄露守卫。

### 0.3 本阶段只做这些

1. 注册表与渲染保持一致，全部既有指令使用类型化属性。
2. 统一指令会话 Context，保留原有作答与遥测行为。
3. 声明已经实现的能力，用一张契约题型表桥接七种题型与内置校验器；判分行为不变。
4. 生成完整能力清单，经公开规范接口、MCP 和 dsl-kit 分发。
5. 教师级设置只控制 `steps` / `ink` 辅助能力，正式输入始终可用。
6. 教学包是现有 DSL 文档与数据声明，能校验、保存、导出并重新导入。

**不做**：新题型、部分得分、第三方运行时代码、通用证据调度器、自定义 lint 规则语言、课程级配置覆盖、实时配置推送或教学包版本管理服务。新增全新交互未来仍需按实际需求适配解析/作答/投影/证据，不能仅靠声明自动生成实现。

---

## T7.1 渲染一致性基线：注册表 ↔ 组件映射 ↔ 清洗白名单

**依赖**：无。

**产出与步骤**：

- [ ] 新增 `apps/web/src/features/markdown/directive-registry-consistency.test.ts`；先写测试，再实现或补齐可测试的导出。
- [ ] 主名集合与 `directiveComponents` 键集合**完全相等**，同时检测缺失与多余映射；别名经 `getDirective(alias).name` 归一后命中主名，不把别名另塞进组件表。
- [ ] `sanitize.ts` 的 `DIRECTIVE_HOST_ATTRS` 由纯函数推导：注册表 attrs 键并集 ∪ `directive/dclass/index/dindex`；沿用当前 id/class 的宿主处理，不顺带重写锚点逻辑。
- [ ] `directives/index.tsx` 查表先确认注册表命中，再用 Map 或 Object.hasOwn 检查组件自有键，未知名称保留正文降级。
- [ ] 修复缺失映射/属性；不改编号计数器或新增指令。

**测试点**：

- [ ] 缺失一条映射和多出一条映射的 fixture 都触发一致性校验失败；最终测试应通过，不保留故意失败的用例。
- [ ] 纯函数接收构造的指令清单，增加/移除属性会对应改变白名单，不修改模块级真实注册表。
- [ ] 未知名称含 `constructor/toString/__proto__` 时仍走 UnknownDirective，正文保留、不抛错。
- [ ] 既有 RichMarkdown、遥测、样例解析与渲染相关测试通过，不把目录一致性测试称为完整渲染快照。

**验收**：

- [ ] 一致性、降级与既有回归测试通过；lint/typecheck/test/build 全绿。
- [ ] 新增业务属性无需再维护手抄白名单。

---

## T7.2 宿主消费 Zod 属性解析（类型化 props）

**依赖**：T7.1；建议先完成 T7.9。

**产出与步骤**：

- [ ] 查表后、传参前，对**业务 attrs** 运行注册表 schema 的 safeParse；宿主的 directive/dclass/index/dindex 不进入 strict schema。
- [ ] 一次性迁移既有全部组件，attrs 输出类型从对应注册定义推导；修改 `directives/types.ts` 和组件，删除组件内数值转换与重复默认值。不保留长期字符串过渡通道，不用 any 或强制断言掩盖类型问题。
- [ ] 样式类保持 `directiveClass` 通道；未知指令与非法属性渲染 UnknownDirective，保留正文，不抛异常。
- [ ] 别名仍在查表层归一；本任务不改 remark 宿主编号计数器，在 `docs/待处理的问题/` 留待办，新增别名涉及编号时再处理。

**测试点**：

- [ ] question 有合法 type 且缺 difficulty 时收到数字 2；step 缺 title 时收到空串；mark 缺 color 时收到 yellow。
- [ ] difficulty=abc 等非法属性明确走降级且正文完整，不只断言“不抛错”。
- [ ] 现有合法样例、样式类、图像/图形与折叠/揭晓行为不变。

**验收**：

- [ ] 既有组件统一收到 schema 输出与已有默认值，不自行解析字符串数字。
- [ ] lint/typecheck/test/build 全绿；样例门禁与实际渲染回归通过。

---

## T7.3 指令会话上下文收编（DirectiveSessionContext）

**依赖**：T7.2。

**产出与步骤**：

- [ ] 阅读真实调用点：填空 Provider 在 AttemptQuestionCard 外层，遥测 Provider 在 RichMarkdown 内层；不要按“两个 Provider 都在 RichMarkdown 内”实施。
- [ ] 新建 `directives/session-context.ts` 或需 JSX 时 `.tsx`，以填空/遥测子命名空间承载现有接口；只迁移已有功能。
- [ ] 内层 Provider 继承外层作答状态，只覆盖明确提供的字段；旧 hook、BlankAnswersProvider、blankAnswersContext 等保留必要适配，不删旧导入路径。
- [ ] 更新原始 useContext 调用点为兼容适配或新 hook；不能把值形状不同的 Context 直接 re-export 为同一个对象。
- [ ] 无作答状态保持 null，无遥测回调静默空操作；不预造 reportEvidence、提示请求或手写上传接口。

**测试点**：

- [ ] 无 Provider：填空仍显示下划线，教师预览折叠/逐步揭晓仍可操作。
- [ ] 填空 Provider 包 RichMarkdown 后输入值与 onChange 正常，内层遥测设置不覆盖外层填空状态。
- [ ] 填空与遥测同时工作，事件既有字段不变；结果视图禁用输入行为保持不变。

**验收**：

- [ ] `telemetry.test.tsx`、题卡/结果视图和新增组合测试通过。
- [ ] 一个 Context 承载会话状态，旧导入路径可用，未增加新的功能性顶层 Context。
- [ ] lint/typecheck/test/build 全绿。

---

## T7.4 能力契约与题型桥接表

**依赖**：T7.3。

**产出与步骤**：

- [ ] 契约先行：defineDirective 增可选 capability，三面均可选；inputType = choice/fill/steps/ink/none，evidence.format = snapshot/ink-strokes/none，validation.shape = exact/partial/rubric/unverifiable。
- [ ] 注册期校验形态和明确冲突：ink-strokes 必须配 ink；允许 none + snapshot 表达折叠遥测。没有声明的指令行为不变，不增加组合矩阵。
- [ ] 严格按方案 §4.3 标注表：blank=fill+snapshot；hint/fold/solution=none+snapshot；steps=steps+snapshot；这些指令均不标 validation。question/answer/example/step 与纯展示指令省略整个 capability。
- [ ] 在 contract 增 `questionCapabilityBindings`，Zod 定义表项形态，以现有 QuestionType 为键：judge/choice/multi 对应 choice+同名 validatorId+exact；fill 对应 fill+fill+rubric；solve/apply/find-error 对应 ink+同名 validatorId+exact。表项包含 evidence.format，客观/填空为 snapshot、手写为 ink-strokes；这是可采集形式，未书写不视为错误。
- [ ] 不把 choice 当成注册指令，不把 answer 当学生输入；blank 的判分取所在题型。partial 仅保留词表，本阶段没有 partial 实现或声明。
- [ ] snapshot 描述既有作答快照/交互事件，ink-strokes 描述既有笔迹；不修改证据格式、CAS、冻结流程，不新增通用证据调度。
- [ ] 运行 schema:export / gen:spec，提交产物并再次检查无漂移。

**测试点**：

- [ ] 非法 none+ink-strokes 注册失败；合法 none+snapshot、缺省 capability 成功。
- [ ] 标注与方案表一致：steps 无 partial、answer 无交互声明；七种题型均有桥接表项，名称与类型来自契约。
- [ ] 既有渲染/遥测/作答行为不变。

**验收**：

- [ ] 契约与注册期校验测试通过；能力描述对应真实已有行为。
- [ ] lint/typecheck/test/build 全绿；生成产物无漂移。

---

## T7.5 服务端校验器注册表（保留既有判分）

**依赖**：T7.4。

**产出与步骤**：

- [ ] 修改判分前先补等价性测试，覆盖全部七种题型和现有边界。
- [ ] `packages/grading/src/validator-registry.ts` 按题型表的 validatorId 注册纯函数；接受 Question 与可缺省 StudentAnswer，返回 `boolean | null`，使用现有契约类型。
- [ ] 提供 judge/choice/multi/fill/solve/apply/find-error 七个内置登记项；三个手写题型共享既有函数即可，不复制算法。
- [ ] `grade(question, answer)` 通过题型表查函数，外部签名与输出不变。无标准答案优先、fill 恒人工、客观题未作答判错、手写题无最终答案进人工等既有优先级不变。
- [ ] grade 消费题型表的 validation.shape：rubric/unverifiable 直接返回 null，exact 查现有函数；进入既有人工批改流程。不增加 reason 载荷、部分得分、自动步骤判分、题目级策略或学生校验 API。
- [ ] 未找到声明所引用的实现属于注册遗漏：启动/测试时检查并报开发错误，不能让正常题静默换成另一种判分；正常 grade 路径继续保持现有无异常行为。

**测试点**：

- [ ] 重复 validatorId 注册报错；契约表引用全部有服务端实现，服务端内置登记集合与契约引用一致。
- [ ] 等价性覆盖正确/错误、未作答、无答案优先、形态错位、越界、fill 恒 null、手写最终答案等既有用例。
- [ ] 交卷集成测试确认自动判定与人工待批仍走原流程。

**验收**：

- [ ] 既有判分测试与新增路由/交卷测试全绿，无产品判分变化。
- [ ] lint/typecheck/test/build 全绿；所需安全审查按 AGENTS 完成。

---

## T7.6 能力清单生成与分发（capabilities.json / MCP / dsl-kit）

**依赖**：T7.4；默认在 T7.5 后串行执行。

**产出与步骤**：

- [ ] 在 contract 定义清单 schema：formatVersion=1；directives 含所有已注册指令的 name/kind/属性表/capability，未声明为 null；questionTypes 含题型能力表。
- [ ] 修改 `packages/md-dsl/src/spec/gen.ts` 的生成函数与 `scripts/gen-spec.ts` 的写文件/同步流程，输出 `docs/dsl/schema/capabilities.json` 和 `dsl-kit/capabilities.json`。
- [ ] 只读取契约注册表和题型表，不导入服务端 grading 函数；CLI 引用检查同样使用契约元数据。
- [ ] 修改 `packages/contract/src/spec.ts`、`apps/server/src/spec-files.ts`，提供 GET /api/public/spec/capabilities.json。
- [ ] MCP 增 describe_capabilities，复用 readSpecFile 返回相同清单；补 MCP 契约声明与测试，工具数量从现有实际数量更新。
- [ ] 检查 server 构建的 dist/spec 包含新文件；现有 copy-spec 整目录复制可复用，补完整性检查或测试即可。
- [ ] 运行 schema:export / gen:spec，提交产物后再次生成检查无漂移。

**测试点**：

- [ ] 清单通过自身 schema，指令集合等于 listDirectives 主名集合（当前 17 个，不永久写死数量），题型表也完整。
- [ ] docs/dsl 与 dsl-kit 清单逐字节一致；HTTP 与 MCP 内容一致。
- [ ] 缺清单文件沿用既有规范文件错误；构建产物可提供新端点。
- [ ] 测试说明 snapshot 是现有证据描述，partial 非本阶段已实现能力，不给 AI 错误能力承诺。

**验收**：

- [ ] HTTP/MCP/生成测试通过；dsl-kit 和 dist/spec 文件齐全。
- [ ] lint/typecheck/test/build 全绿；gen:spec 无漂移。

---

## T7.7 教师级辅助能力启用集

**依赖**：T7.3、T7.4、T7.6。

**固定边界**：用户确认正式作答始终可用。本任务只提供 steps / ink 两项辅助开关，教师级，不做课程覆盖或实时推送。

**产出与步骤**：

- [ ] contract 定义 profile：enabledCapabilities 仅为 steps/ink 数组，缺省两者全启用，空数组合法；读取不到字段的旧数据/载荷也按全启用处理。
- [ ] 教师表增加一个配置字段，改 Drizzle schema 后 db:generate 生成迁移。
- [ ] GET/PUT /api/teacher/settings/capability-profile 读写当前教师配置；在已有教师设置界面增加两项勾选，不新建管理体系。
- [ ] 学生讲义与作答读取接口下发有效启用集，枚举本任务实际涉及的响应契约、页面与共享组件；不能只在学习包导出中加入字段而不接学生页面。
- [ ] steps 关闭：展示全部步骤、隐藏揭晓按钮、不伪造 reveal。ink 关闭：隐藏新建书写/草稿入口，保留最终答案文本输入及已有笔迹只读查看；填空、判断、单选、多选始终正常作答。
- [ ] DirectiveSessionContext 与题卡、HandwrittenControls、NoteLayer 等共用启用集；辅助开关不清空答案/笔迹、不改提交规则、不参与判分。
- [ ] 刷新或重新打开页面生效；不添加配置冻结、轮询或跨标签同步。
- [ ] lint 规则实际接入 `lint/lint.ts` 与对应规则模块，`lint/rules.ts` 登记 warning：使用 steps 或手写题型但对应辅助开关关闭时说明回退。无启用集上下文默认全启用，CLI 不依赖教师数据库。
- [ ] 更新契约/DSL 生成产物；所有改动仍走既有泄露守卫。

**测试点**：

- [ ] 默认全启用、空数组、非法开关名；未鉴权 401、两教师配置互不影响。
- [ ] 关闭全部辅助能力后，七种题型正式输入仍可用；steps 正文完整，已有答案与证据不丢，最终答案可提交。
- [ ] 相关学生响应 assertNoLeak 回归通过，启用集不改变投影。
- [ ] 显式传关闭上下文时 warning；未提供上下文时既有样例无新增 warning。
- [ ] E2E：教师关闭辅助能力 → 学生刷新 → 正常作答交卷；恢复后入口恢复。复用已有证据冻结测试，不另建配置状态机。

**验收**：

- [ ] 配置、控件、lint、泄露与 E2E 测试通过；lint/typecheck/test/build 全绿，生成产物无漂移。
- [ ] 🧑 教师勾选/取消一次，学生刷新验证全部步骤可读、无手写时仍能填写最终答案和提交。

---

## T7.8 教学包导入、保存与导出往返

**依赖**：T7.5、T7.6；默认在 T7.7 后执行，避免共享契约/迁移冲突。

**固定边界**：复用既有文档和资源模型，教学包只声明依赖，不改变判分、不新增执行代码或版本管理系统。

**产出与步骤**：

- [ ] contract 增 teaching-pack.ts，并把可选 teachingPack 接入既有 frontmatterSchema 与解析输出：formatVersion 缺省 1、name 非空、version 缺省字符串 "1"、directives/validators 引用数组缺省空数组；普通 MD 不受影响。
- [ ] directives 只引用已注册名称（别名归一），validators 引用题型能力表的内置 validatorId；能力定义从系统清单读取。无需声明所有正文指令，不做版本范围、依赖图或自定义 lint 规则。
- [ ] md-dsl 的实际 lint 模块校验显式引用，错误码在 rules.ts 登记：DIRECTIVE_REF_NOT_FOUND / VALIDATOR_REF_NOT_FOUND。使用契约元数据，不把 grading 函数引入 md-dsl 或 web。
- [ ] 在 content-service 的 analyzeImport 等共用入口接线，preview/commit/批量/ZIP/MCP 同规则；commit 重新分析，直接提交不能绕过引用校验。普通正文未知指令仍 warning + 降级。
- [ ] units/lectures 增可空 teachingPackJson（名字可沿仓库风格），形态来自契约；改 Drizzle schema 后 db:generate。一次导入拆出的资源共享同一声明；正文编辑保留，重新导入按新声明覆盖，普通 MD 重导清空。
- [ ] 在单元/讲义现有 MD 导出中保留声明，新增教师资源库「导出教学包」入口和 ZIP 接口。ZIP 含当前该资源的 content.md 与当前生成的 capabilities-snapshot.json；正文引用本地图片时收集并附带图片，复用现有 MD/媒体/ZIP 处理，不新增媒体协议。
- [ ] name/version 仅是分享标签；导入仍按既有资源键和教师域合并。多资源文档导入后可分别导出，不重建原混合文档；导出不含学生作答、笔迹、答案快照等学习记录。
- [ ] ZIP 重新导入取 content.md，复用现有媒体导入流程；能力快照仅归档，不注册能力、不覆盖运行配置。普通图片资源继续遵守既有本地媒体规则。
- [ ] 导出前检查声明引用仍可用；错误时不生成包。更新 gen:spec 产物、资源库页面说明与接口契约。

**测试点**：

- [ ] schema/frontmatter 解析保留声明；普通历史样例不变。
- [ ] 两种缺失引用均阻断 preview 和直接 commit；合法引用可导入，CLI 与 MCP 同口径。
- [ ] 导入 → 正文编辑 → 导出 ZIP → 再导入，正文语义与声明保留；含一张本地图片的用例验证随行媒体可恢复。能力快照不作为运行时权威。普通 MD 重导清空旧声明。
- [ ] 域隔离：不可读写或导出其他教师资源；ZIP 结构、随行媒体沿用既有校验，不扩展一套安全框架。
- [ ] E2E：教学包导入 → 学生正式作答 → 既有证据采集/冻结 → 交卷判分 → 教师导出并重新导入。关闭辅助能力时正式作答仍可走通，不强制产生笔迹。

**验收**：

- [ ] 引用校验、元数据保存、MD/ZIP 往返测试与全链 E2E 通过。
- [ ] lint/typecheck/test/build 全绿；生成产物无漂移。
- [ ] 🧑 从资源库导出一份包，重新导入确认材料与声明可用。

---

## T7.9 样例自动发现与回归门禁

**依赖**：T7.1；建议紧接 T7.1 执行。

**产出与步骤**：

- [ ] 自动读取 samples/v2 下所有 .md（测试用 Node fs 即可），稳定排序，共用发现逻辑。
- [ ] 每份文件进入解析回归；讲义继续运行 outline-consistency 的目录/编号断言；练习和混合文档的题目进入真实题面渲染测试，不只遍历 parsed.lectures。
- [ ] 渲染题目使用既有学生投影，检查题面/空位/选项等必要语义和内容完整，不创建庞大 HTML 快照。
- [ ] 完整样例的实际 Markdown 代码块经现有 processor/blank 转换收集 AST 指令名，归一主名后覆盖 listDirectives；不匹配说明文字或 step/steps、col/columns 的子串。
- [ ] 测试放在既有 Vitest 范围，无需新 CI job；新增测试文件必须列在实施计划中。

**测试点**：

- [ ] 讲义与纯练习临时 fixture 均自动纳入，验证后清理；测试文件数量不能随新样例静默归零。
- [ ] 删除实际 step 节点但保留 steps 的样例 fixture 会使覆盖断言失败；blank 语法糖被识别。
- [ ] samples/v2 与完整样例现有语义全部通过，新增文件无需手改文件名清单。

**验收**：

- [ ] 三种文档均有实际解析/渲染用例，样例自动发现和精确指令覆盖通过。
- [ ] lint/typecheck/test/build 全绿；若完整样例有意修改则 gen:spec 同步 dsl-kit。

---

## T7.10 文档、技能与决策收尾

**依赖**：T7.1–T7.9 全部完成。

**产出与步骤**：

- [ ] 技术架构 §5.1.1 / §5.9 / §10 同步实际实现：能力标注、题型桥接表、辅助开关、教学包保存与往返；不把保留的 partial 或未来扩展写成已实现。
- [ ] 精进方案 §八更新落地状态；记录实际文件/符号与验证结果，保留 2026-10-09 用户确认的正式作答边界，不再次写“禁用填空”。
- [ ] 页面功能清单补辅助勾选、能力 API/MCP、教学包资源库导出入口。
- [ ] 更新原 `.claude/skills/add-directive/SKILL.md` 即可，不必另造 add-capability 技能：交互类填写实际能力，展示类省略；涉及新作答需适配对应接口；保持四步纪律。
- [ ] docs/进度表.md 增 Phase7 任务行并按实际完成情况打勾，未通过人工项不宣称阶段全完成。
- [ ] 已有归档文档不更新；未实施的未来路径不得写成当前存在。检查文档路径/符号，与实际导出一致。
- [ ] 生成产物提交后再跑 gen:spec 检查无漂移；完整分支质量闸门与既有 CI 通过。

**验收**：

- [ ] 文档与实际实现一致，无悬空的当前实现引用；lint/typecheck/test/build、CI E2E 和生成同步通过。
- [ ] 🧑 通读架构增补与本阶段边界，确认教师开关和教学包用法符合设想。

---

## 阶段完成标志

1. 注册表主名与组件映射集合相等，别名归一、未知名称降级与自动白名单有测试。
2. 全部既有组件使用 Zod 解析后的属性，Context 合并不丢作答或遥测。
3. 能力清单包含全部指令和七种题型桥接表，HTTP/MCP/dsl-kit 一致，声明只描述实际能力。
4. 交卷经服务端校验器查表，判分结果与既有七种题型等价，人工批改和证据冻结链不变。
5. 教师能关闭 steps/ink；学生仍能完成正式作答，全部步骤可读，已有证据不丢。
6. 教学包能校验、保存、导出和重新导入，声明与当前资源正文语义保留，不改变判分或执行第三方代码。
7. 新样例自动纳入真实解析和渲染回归，纯练习不被漏过。
8. 合并前质量闸门、构建、单测、既有 CI E2E 和人工项通过；未来扩展有明确接线位置，未预造复杂平台。
