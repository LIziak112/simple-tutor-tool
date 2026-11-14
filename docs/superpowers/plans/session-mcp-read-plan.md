# Phase 2.2 A1：MCP 公开读工具

起点 `987db0353c16b9c019bc29690257f86d5f516eb1`，内容树 `0afc07d6ddde95f1d3d7d2c88bd821dc92eb9191`，草稿 PR #166。实施范围已经主会话确认，后续不另等 owner 技术默认批准。

## 范围

新增 `list_my_practices`、`get_practice`、`get_practice_question`，班级与个人共用注册，17→20工具。取数复用学生记录、公开取卷/详情、AI策略、真实笔记头和冻结材料；不是领取任务的答案授权例外。旧 current 四态、旧提交壳与随笔行为不变。不做 A2/A3/B，不改提交、事件、设备、结算、用时或迁移。

2.3 canonical 尚待主会话提供冻结模块、签名、题序 helper、SHA/tree。此前只做契约、失败测试、注册拆分及读适配准备；不读另一工作树在途代码，不复制 canonical，不造临时上下文宣称接通。

## 实施顺序

1. 契约失败测试与旧17工具兼容测试；新输出 strict 白名单，内容 id 沿用合法 DSL 长标识，不合成 phase/canPartial。
2. 按职责拆796行 `student-server.ts`：AI逐题任务、整卷复盘、错题组卷分别独立注册，旧工具定义只搬不改；主入口保留身份、名单与编排。每块控制400行内，共享4MiB图片常量保持旧导出兼容。
3. 新读工具与服务适配。目录所有题当前AI门任一拒绝则整体拒绝；单题只带本题材料/本人答案；笔记凭据使用真实公开 head.note.currentVersionId + head.note.revision，绝不默认missing。数据库 notes.currentRevision 在 noteRecordMetaOf 映射为公开 revision；原设计把 API 字段也写成 currentRevision 已更正，不造字段兼容。metadata列表不授予读题权限。
4. 冻结canonical到位后合入指定提交并完成接线；按公开题序核对id/revision，收尾后从真实行取settlementSeq，不拿过期RETURNING对象。此前不提交半成品验收。
5. 泄露/权限/版本/旧协议与图片真实字节4MiB边界测试；新独立E2E spec登记SPEC_TAGS，实际grep收集必须非空。重types/E2E前向主会话报告，单worker，避免同机Vite/端口争用。
6. 完整 `pnpm gen:spec`（含bundle）、重复无漂移与CLI smoke；真实I16/尺寸门不放宽；按工程验证说明收口，日志与完整范围回卡。

## 验收与证据

契约先行/TDD；学生载荷必须简化→正确性→安全独审。完整d02目标范围与本包增量分开，四份diff含新增文件。未审不Ready，不push/远程merge/外发/派子。所有提交末行 `Krow-Task: session-mcp-read`。证据目录 `/workspace/channels/f76423cc/work/session-mcp-read/`，记录首失败、命令、非零用例、exit、HEAD/tree及未覆盖项。

## 2026-11-14 集成与实现自验收记录

此前「canonical尚待」为开工历史。已合入已审公开 canonical `c70ca0dda107e5f97329ea38fb2d0ca3f417c11e`，随后以 `6eb199a0` 保存接线、以 `a033898f` 真实 merge 设备/UI 综合公开头 `2f8819f34b72e0c1379f10f1f821e11977746a44`（tree `2d391dc83aa25a42abc32473108bec1bade5ef34`，已含完整2.3 UI），零冲突；生成物只用官方命令重建，没有手写 minified 或删除上游功能。

新读定位输入继续传完整 strict object schema，保留 refine/metadata；由同一 `questionLocatorFields` 同时生成运行时「id/no至少一个」检查和 JSON Schema anyOf，实际SDK tools/list/runtime红绿锁定无定位/未知字段均拒绝，两定位矛盾仍由服务核对真实题，不静默偏选。未引入A2版本包装或放宽旧提交。

两次完整 `pnpm gen:spec` 均 exit 0，25个生成文件第二次零漂移。新增公开 `student-mcp-practice.json`；combined bundle SHA256 `73b9f29933ca2b401f82bc7a78dbd585616dbdfdcab2afd5acc108826d587800`，1029584 bytes。源码/分发CLI正例exit0、反例exit1，stdout/stderr逐字一致；分发与源码CLI共6个unit冒烟通过。

集成后23文件260例单worker定点回归通过，覆盖旧17兼容、新SDK27例、真实note head、隐私/图像字节预算、材料闭包、当前策略、canonical、真实I16 AST/host及选测决策。五子包类型按contract→md-dsl→grading→server→web串行，另跑E2E tsc；最终共享契约修正后重验五子包。尺寸/治理/完整lint通过，历史尺寸基线保持上游下降。quick/default unit及实际目标origin/v2选测均触发全量；默认E2E因本地无v2引用exit1，按工程约定显式使用真实origin/v2后正常判为全量，未擅建或移动v2分支。主会话明确安排全量由CI承担；本地定点不冒称完整选测通过。

新E2E实际 `--list --grep @mcp` 收集2例；Chromium workers=1/retries=0首轮2/2通过、exit0（16.6s）。两端真实浏览器打开题卡、显式workflow1/per_question、正确MCP端点注册20个学生工具、错误端点401、新读准备→缺key拒绝→补显式key原提交→原壳同键重放、重读无秘密、来源隐藏拒绝。finally关闭SDK/浏览器上下文；5199/8898/8899前后全部无监听。未实测WebKit、本地物理iPad或第三方MCP客户端，不作此类通过声明。

完整日志、首失败与修复、最终clean HEAD/tree、d02四份diff/新增清单、自身相对2f881增量、mode/blob父归属证明集中在树外 `session-mcp-read/final/`。这里只记实现自验收，仍须编排者独立简化→正确性→mandatory学生出口安全审查，未审不Ready。

媒体授权核验事实：普通 `/blobs/media/*` 现有入口只要求有效会话，内容寻址媒体没有逐blob owner记录（`saveMedia`也不接owner）；本包没有可复用的逐blob owner guard，不能宣称foreign-owner ref已经按上传者隔离。A1先按本人卷/当前AI/真实来源检查公开引用，再复用`extractMediaImageSrcs`、`statMediaSrc`/`resolveWithinRootOrNull`和同既有伺服文件名/MIME白名单的异步读取；仅`blobs/media/<64hex>.<图片扩展>`可附图。memo/notes/ink/annotations/附件的私有路径或fileId不匹配，不抓外链、不借读取整个snapshot取图。跨owner全局媒体引用未专测，现行共享语义交安全独审明确核验，不在A1虚构媒体归属或改造别的媒体系统；错误不透传路径/私有标题，只允许预算数字extra。

进程证据区分：三个端口确为零监听；本轮Playwright退出后有4个PPID1的Z状态记录（tsx/vite包装及Chromium zygote），不把僵尸PID误记成仍运行服务或宣称PID全部消失，不操作容器PID1及其他任务进程。

媒体补测7例通过（主260例之后，只补该文件）：真实私有notes文件在场，memo/notes/ink/annotations/附件URL均不匹配且`readMediaBlobAsync`调用为零；全局media正例及4MiB真实边界继续通过。没有因此重复浏览器、生成或完整回归。

## 2026-11-14 独审三项 P2 修复记录

原冻结 `3cf71397de229457cc57d0169a8e42b3b7599332` 的独审确认三项 P2，原264路径、独立探针与首次红灯保留，不能用旧自验收替代修复复审。本次只修 A1：

1. 图片输入消费已经公开的 matching/ordering 全部文本，包含可见干扰选项；不读取答案布尔标记、私有解析/提示或邻题。两身份×两题型真实 DSL/SDK 图片哨兵覆盖。
2. `studentMcpPublicQuestions` 先复用 owner/usable 与合法 legacy lazy 补全，再复用完整 snapshot validator 校验全部冻结成员及公开身份集合，目录和按 ID/No 单题统一 fail closed。原 publicpaper/canonical/UI 排序不改，不另造题序；异步图片后再验整卷成员。ref 复用既有 `questionRevisionIdSchema`，不强加 UUID 或全局 revision 唯一约束。
3. 新 `student-mcp-practice-metadata.ts` 从完整公开响应扣除闭合的类型正文键，其余字段（含重复 id、context、准备参数/证据、材料/图片元信息及未来元字段）完整累计。选择编号、排序/匹配 id 保留计量；64 KiB 精确边界与 >64 KiB 合法题干/材料/essay 正例并存。图片 src 预检与真实 stat 元信息检查均在 raw 读取前，4 MiB 图片字节门独立保留。新生产模块小于400行，未抬历史尺寸基线。

red 证据需区分：首轮26例有24失败，其中合法 legacy 的2个失败来自夹具鉴权/导入参数错误，已先修夹具并验证原实现正路；另2个所谓「bad revision」用了实际合法 opaque ref，属于错误预期，不能计作产品红→绿。真正无效 ref 改为既有 trim 规则拒绝的带首尾空白值。独立原5条有效红例与完整元数据观测（输入30095 B/context30372 B/完整响应121292 B）均不覆写。

opaque ref 另有真实契约不一致：既有 ref schema 允许非空、无首尾空白、最多512字符；本包目录误收窄 UUID 已改复用该 SSOT，class/personal 目录2个合法 opaque 反例独立 red→green。父 `LearningContext.session.questionRevisionId` 同类收窄由 PR160 作者修复，待其经父167实际合入后再验本包 single/canonical/SDK 正例。本包未改父契约、DDL 或生产 writer；现有 writer 生成 UUID 不等于对 wire ref 增加限制，也没有读取生产库声称已有 opaque 存量。

修复后25文件312例单worker通过（含旧SDK27、旧17兼容、I16、CLI与选测决策），contract/server类型通过。官方完整 gen 两次 exit0、25文件第二次零漂移；新 bundle SHA256 `7195b605635e5b38330163e622e3830a0118ef91a5d1d591b3346c2ef222c283`，源码/分发CLI正0反1且诊断一致。原2例 Chromium workers1/retries0 再跑2/2通过（18.1s），无跳过/重试；5199/8898/8899退出后无监听，本树活 runtime0，2个PPID1 Z状态如实保留。浏览器未改用例或弱化断言。

树外新证据位于 `session-mcp-read/fix/`，旧 `final/` 与独审记录保留。该记录只说明实现者验证；新的冻结 SHA 仍交原独立审核者按简化→正确性→学生出口安全补审，不宣称独审已通过。父160/167最终集成、opaque 单题实际正例和后续 CI 为后续项；未运行第三方客户端、真机或生产应用。
