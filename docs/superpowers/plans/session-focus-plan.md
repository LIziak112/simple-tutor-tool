# session-focus 实施计划与验证记录

本计划按已授权的 2.3 设计实施；下文为确认范围，实施结果在末尾逐项记录。

- 独立工作树：/workspace/repos/simple-tutor-tool-wt-session-focus；PR #165；不 push/merge PR/派子。
- 挂牌起点：907fb50dbba930587306e7354af7126e3fda8ae4，parent de90dce72130a4b8f25cacacfdce9c084bc82d65。
- 前端集成：b8c865e47743dec928f95a9dd61ce444f00ba6e6；parents 907fb50d + c8acd73b；tree b84791c916f397a47762fb0a44313d056fe5d39c。
- 门户集成及产品基点：32431e8b410ae5d404c7c5224d20bfa285a139df；parents b8c865e4 + 76e1cefe；tree 6d387fd4f5ec0143b2fb2414ce235b39eea17c24。
- 唯一集成冲突是 file-size baseline：删除已拆为 91 行的 attempt-service 历史项，content-service 保留真实 2118 行，其余两方有效代码/身份行为/结算生成物均保留。
- 合并后的真实基座已包含通过独审的 1.3、1.4、1.2、1.0；新 task 的计划中 S 不再是未审依赖。真实 device 协议用 devices.deviceId 查询（不是内部 row id）。
- 验证用私有 offline node_modules、单 worker；types/E2E 先向主会话排窗，根包排除/递归并发 1；局部浏览器至多 2 workers/0 retries。自动全量选择如实留日志，由 root 同步后 CI 执行完整 full/双浏览器。

# 2.3 上下文仓合一与题卡随笔入口：已确认设计（原只读阶段记录）

以下保留获授权前的只读设计事实与建议；不代表实施当前状态。当前集成基点见开头，分阶段实施证据见末章。

## 1. 结论与真实依赖

2.3 可以作为独立交付包推进，真正依赖已稳定的 1.4 LearningContext / memo canonical / device 契约，以及 2.0 前端拆分后的代码。它不需要先决定 D1、不需要激活、批次或新用时；不将这项独立前端包通过说成完整 Phase 2 或上线前置已完成。

现有前端不能在所有来源中自行拼出完整 LearningContext。因此建议加一个受学生读权限保护的纯坐标投影入口，和新式 memo 校验、未来 MCP 2.2 共用同一服务端规范坐标构造器。只读入口不创建 attempt，不提交、不激活、不计算结算，不拿 memo 历史兼容的吞错路径当读题权限。已审的 submit 主路径不在写集内。

默认技术决策：

1. 单一模块级内存 store + useSyncExternalStore；按 origin / student principal / epoch 隔离，不加依赖，不持久化或跨标签同步实时焦点。
2. 页面拥有发布权；AI Dock 改为消费者。learning-focus-store 和 mcp-live-focus 可以保留文件名，但只做兼容选择器/传输适配，不能各存一份 current question。
3. 从题卡打开 composer 时显式传入该题的来源快照，固定到本次记录完成/取消；后续滚动、全局焦点或布局变化均不能换来源。
4. 需要完整版本时取服务端 canonical；缺少真实版本时只保存可核对的旧 anchor 引用，不编 UUID、题号 0 或虚构阶段。已有离线记录入口和媒体保稿照常可用。
5. 新式讲义 context 尊重明确的 courseId，并经过“该讲义在该课对本人可见”的既有门。旧 anchor 的默认选课、已存 memo 快照、clientId 幂等重放不变。
6. settlementSeq 只读取 canonical 已有的真实行值。1.4 无结算行时是真实 null；1.3 合入后由同一构造器返回真实 row.settlementSeq。不在客户端用 draft/submitted、题号或批次按钮猜测它。
7. 保留整卷菜单的无题随笔入口；不做 3.4 的序号/来源列表重排、标签 UI、设备 UI，也不做 MCP 后台工具。

## 2. 本次只读固定的证据树

| 代号 | 工作树与完整 HEAD | 证据地位 |
| --- | --- | --- |
| F | /workspace/repos/simple-tutor-tool-wt-session-front，46d3d6186c4697552c73f4995de4d01e2a0271db | 稳定前端；生产代码仍是 16f126ef，后续仅 I16 白名单及记录补修 |
| C | /workspace/repos/simple-tutor-tool-wt-session-context，01d4f861fe35ea40f35fed895f8b0a93a9007f7d | 稳定 1.4；产品截止 ec4548985，末两项为测试补充；没有新 UI |
| S | /workspace/repos/simple-tutor-tool-wt-session-settle，8d456032b4dea5ca26c85d78369e08b4e588f6e0 | 仅作接口事实参考，正在独审，不能当已完成基座 |
| 原计划 | /workspace/inbox/hall/32335/2026-11-14-作答会话与上下文协议迭代计划.md | §2.2.1/2.2.2、§3.2、D1；整体依赖与可独立实施子包分开 |
| 2.2 设计 | /workspace/channels/f76423cc/work/session-mcp-design/plan.md | 共享接口、候选和隐私政策参考，不代表本包实现后台工具 |

开头重读了 F 的 AGENTS.md、文件规模/工程验证约定及相关作答、AI、随笔约定，并读取 C 的真实契约和实现；没有用旧文档中“浏览器 anchor 原样存”的文字覆盖 1.4 已实现的 canonical 校验事实。

下文缩写路径中，features/pages/lib 相对 apps/web/src，services/routes 相对 apps/server/src。收尾时 C 的 HEAD 已由其他工作推进到 9f96937db4aed56c55623356c43908ffcba4b167；已核对它相对 01d4f861 仅修改 dsl-kit/tutor-lint.mjs 生成产物，没有改变本设计所读的契约、应用代码、AGENTS 或专题约定。证据仍固定按表中 01d4f861 的应用事实引用。

### 2.1 已确认现状

| 事实 | 代码出处 |
| --- | --- |
| LearningContext v1 的 session 若非 null，必须有真实 attemptId、questionRevisionId、正整数 questionNo/count、nullable settlementSeq；不能给部分 session | C packages/contract/src/learning-context.ts:21 |
| create memo 的 context 是 optional、不是 nullable；读侧 context 是 optional + nullable；旧缓存缺字段合法 | C packages/contract/src/memo-api.ts，memoCreateBaseSchema / memoSchema |
| 浏览器仍以 MemoAnchor 作为模块级 current，clear 按值比较；两个 host 发布相同值时，旧 host cleanup 仍可能清掉新 host | F features/memos/learning-focus-store.ts:15-79 |
| MCP reporter 另存 questionId、active、published；Dock 同时调用旧焦点发布及 MCP hook | F features/student-ai/mcp-live-focus.ts:10-122；AiCompanionDock.tsx:124-143 |
| Composer 直接随 useLearningFocus 重算 anchor，打开期间滚动即可换锚；未冻结本次来源 | F features/memos/MemoComposer.tsx:48-60 |
| outbox 目前没有 context/deviceId 字段，上传 common 只带 anchor/tags/device/recordedAt | C features/memos/memo-outbox.ts:29-43、239-263 |
| 1.4 JSON 和 multipart API/服务已经接收 context/deviceId；本地 UI 未接线 | C lib/memo-api.ts:77-84；routes/student-memos.ts；services/memo-service.ts:112-160 |
| 草稿题目必带 questionRevisionId；结果题的该字段及 publicQuestion 可缺省 | C packages/contract/src/attempt.ts:296、415-425 |
| wrong 的 units 分组 id 可以是 attemptId；不可拿它当内容 unitId | C packages/contract/src/attempt.ts:322；attempt-summary.ts |
| 讲练显示顺序是 blocks 首现题 + 孤儿冻结题；不是 data.questions 的数组下标保证 | F pages/student/StudentLessonPage.tsx:261-289 |
| 1.4 memo 坐标目前用 frozenRowsInDisplayOrder 的全行 index/count；公开投影会跳过坏/缺快照，讲练又有 blocks 顺序，存在需要统一的边界 | C services/memo-context.ts:98、175-183；attempt-service.ts:951、3276；lesson-service.ts:218-264 |
| 明确传 courseId 的讲义详情尊重该课；memo 的 lecture canonical 当前未传 courseId，可能选择另一门可见课并拒绝真实输入坐标 | C services/student-course-service.ts:834；memo-context.ts:63-83、242-257 |
| S 仅把 canonical settlementSeq 改为真实 row 值，且不再要求客户端声称 null；仍只比较实际题目身份/题序 | S 相对 C 的 services/memo-context.ts 差异 |
| 创建 memo 先按 student/clientId 命中已有行，才重建 context；这是重放不可改旧快照的保证 | C services/memo-service.ts:107-116、237-244 |
| draft 讲练复用 AttemptQuestionCard；released 讲练独立渲染 article，当前没有同款更多菜单 | F features/lesson/LessonQuestionCard.tsx:223-352 |
| 结果页更多是 ResultQuestionTools 的材料面板，不是题头 DropdownMenu | F AttemptResultView.tsx:253-320；ResultQuestionTools.tsx:14-107 |
| 讲义 outline id 是标题文本/出现次数生成的显示键；现有 focus 只给 headingIndex，不能把它直接宣称成稳定内容 sectionId | F markdown/outline.ts:24-65；use-lecture-section-focus.ts:75；StudentLectureViewPage.tsx:67-76 |
| 现有 outbox 已有账号捕获、异步回执隔离、clientId 重试、本机失败媒体保留；需复用 | C memo-outbox.ts:109-218、284-335；F MemoComposer.tsx:68-144 |

## 3. 服务端 canonical：共享 SSOT 与最小读侧接线

### 3.1 建议入口

建议新增一个小路由模块，以现有 createStudentAttemptRoutes 的小装配文件挂载，继续位于 requireStudent 的保护树下：

    POST /api/student/learning-context/resolve
    Cache-Control: private, no-store

严格联合入参建议：

- question：kind、attemptId、questionId、surface（attempt/result/lesson）；可选 expectedQuestionRevisionId，仅在宿主真实拥有该字段时传。
- lecture：kind、lectureId；可选 courseId（页面有明确课程时传真实值）；sectionId 本包只接受 null/省略。
- 不接收 studentId/teacherId、整份客户端 titles、任意 phase、能力或结算授权。
- 内容 id 复用 learningContentIdSchema，不另用 UUID/512 字符限制误拒 DSL id。attempt/revision UUID 沿原契约。
- 成功壳 data 为 LearningContext，view/deviceId 默认 null；客户端只填真实 view/layout/device，不改服务器给的内容/会话身份。
- 表面 surface 只选择对应公开展示序，不授予结果、答案或提交权限。请求声称 result 绝不绕过真实 attempt 状态与公布门。
- 合法旧数据确实无法投影为完整 session 时明确返回不可解析来源；不返回伪 session。正文笔记仍可按旧 anchor 引用离线入队。
- 错误建议：语法错误 400、未认证 401；未归属/不可见/不存在统一不暴露来源的 404。只有先确认本人当前可见题之后，真实 expected revision 不符才返回来源过期 409；错误 extra 不附私有快照或他人标题。

不把现有 GET /attempts/:id/context 改成另一种响应：它是材料/组快照接口。也不把坐标塞进全量题面 response 并忽略其 ETag/旧缓存：这会牵动 attempt-detail-cache 的输入与 304 语义。单独小型投影可避开 submit 热点和缓存重构。客户端按 principal/attempt/question/真实 revision/表面缓存坐标，只对实际选中或显式打开的题请求，不做全卷 500 题逐项预取。

lecture 原 DTO 已有真实 id/courseId/courseName/title，可直接构造 session:null 的内容上下文；需要服务端校准时使用同一个 resolve 入口。sectionId 默认真实“未定位到稳定节”的 null，不从 headingIndex 或 outline 显示键猜造。

### 3.2 共享构造器职责

建议服务端独立 learning-context-projection.ts 提供规范构造/核对能力，供下列调用方共同消费：

    浏览器 resolve 路由 -> 普通学生可见性门 -> 公共坐标构造器
    新式 memo 写入    -> memo 写入/来源核对门 -> 同一构造器
    未来 MCP 2.2      -> Bearer + AI门 + 普通投影门 -> 同一构造器

允许抽取 C memo-context.ts 中已有的确定性坐标与名称组装，旧文件保留兼容适配。禁止把其 input 缺省时 catch HttpError -> null 的“保留本人历史笔记”分支用于新读 API 或 MCP 授权。构造器输出不含题干、答案、解析、提示正文、判定、任务 lease、教师私注或内部学生账号。

question 读侧：

1. 先复用 requireUsableAttempt / getStudentAttemptPaper 的本人归属、作废与课程分态可见性；不调用 start/restart，也不经过提交服务。
2. qid 必须在当前表面的公开冻结题集合中；版本为该 qid 的真实 responses.id。只有 query 到另一行、当前题库 question.version 或输入看起来像 UUID 都不算验证。
3. 普通作答/结果题序由公开 units.flatMap 顺序给出；坏/缺快照不挪用另一题的版本，count 与真实公开集合一致。
4. lesson 表面复用 blocks 首现 + 真实孤儿冻结题的顺序。把现有 lessonQuestionOrder 的纯 ID 排列规则提到可共享的纯模块；页面与服务端用同一规则，不重排现有页面、不手写两套排序。若同一 lesson attempt 经通用结果页显示，则按那个合法表面的公开序构造。跨表面定位始终用 qid + revision，不能假定两种展示题号天然相等。
5. 新式 memo full context 的题序核对必须与上述公开投影一致，否则“读 API 返回一个坐标，memo 校验另一套”仍是假接线。旧 memo 行的 contextJson/anchorJson 不回写，clientId 先命中已有行的次序不变。
6. 若当前 lecture blocks 与请求时真实显示身份已变化而导致 expected revision/目录对应不一致，按来源过期处理，不静默换题或重新绑定；本地笔记内容保留。
7. 用时、activatedAt、可分批等与坐标无关，不加到此接口。settlementSeq 只由最终稳定的服务端 canonical 读真实行；S 未通过独审前不能依赖它已可用。

前端拿回坐标后还要对照正在显示的真实 ID 序列：普通页面来自已授权 units，讲练来自相同 blocks/孤儿题规则。仅在 qid 确实在该序列中时可计算展示 index+1/count 作一致性核对；这不是假定 DTO 自带 questionNo/count。返回值与当前真实序列或已知 revision 不符时不发布为完整 context，保留原引用与正文。空集合、找不到题、旧请求晚到不能用 index=-1 再加 1 伪造题号 0。

上述只读含义是不增加学习业务动作；现有鉴权/session触达/device登记簿记仍保留，不宣称整个HTTP读请求绝对零写表；既有公开读路径对遗留数据的懒冻结语义仍复用，不能为了坐标查询另造开卷、激活或结算写入。未来 1.1 改动读路径时需按其真实实现复核，而不是在本包代选 D1。

带 session 的内容 courseId 是服务端 attempt 来源事实；不能用“这次从哪门课进入讲练”的 URL 覆写 attempt 的课程来源。纯 lecture 阅读没有 attempt，则按详情实际选中课程以及其可见门构造。两者不能混为同一条选课规则。

lecture 读侧/新式写入：

- 明确 courseId 时调用 requireVisibleStudentLecture(db, studentId, lectureId, courseId, now)。
- 不得只验证“本人能在另一门课看见此讲义”后接受输入的任意 courseId。
- input.context 的 lecture 分支按其明确 content.courseId 规范化；旧 anchor-only 无显式课程时继续原来的默认可见课程选择。
- 新 UI 只发布 sectionId:null，不改变已有 memo/外部合法输入携带 sectionId 的兼容语义，也不回写历史 sectionId。
- 隐藏、未发布、课程失权、软删、非成员、教师域不符不泄露标题/存在性。推断到的关联讲义不可见时仍按 1.4 既有规则隐藏该推断信息，不扩大授权。
- 现有历史 memo 读取和命中 clientId 的重放不重新做来源访问，不能因此改旧记录、删除旧笔记或给它新增原题访问权。

### 3.3 真实依赖与冲突边界

硬依赖是 C 的契约/预算/设备与 canonical 代码，以及 F 的拆分接口。若两树尚未按实际目标 v2 合并，实施前先按合并后 SHA 复核字段，不把独立 HEAD 说成已经上线。

需要的细微后端接线是共享 canonical 构造、展示序统一、新式讲义选课和只读 route；它们可以在独立新模块、memo-context.ts、student-attempt-routes.ts 完成，不编辑 attempt-service.ts 或其他 1.3 submit 主路径。S 正在修改 memo-context.ts 的两行结算事实，因此该小文件也需在 S 冻结/补审后顺序衔接，不能在同一文件同时写。此为文件排队，不是本包依赖结算业务验收。

原计划把整个 Phase 2 放在 1.1/1.2/1.3/1.4 上线之后；但它也明确 2.3 的技术依赖是 1.4。这里仅拆出不涉及激活/结算的可独立子包，D1 继续未决，未取消阶段级上线条件。

## 4. 发布方字段与来源构造矩阵

| 发布方 | 当前真实可用信息 | 不允许假定的信息 | 本包接线 |
| --- | --- | --- | --- |
| 普通 draft | attempt summary、公开平铺 qid、必有 revision；页面展示 index/count | wrong 分组 id 是 unit；可见的关联 lecture；真实结算序号 | 真实 qid/revision 传 selector；canonical 补真实内容坐标/名称和核对后的展示序 |
| 普通 result | attempt、questionId、真实展示序；revision/publicQuestion 可选 | 可选 revision 总存在；从 answer/summary 推阶段/结算 | 有真实 revision 就作 expected 条件；没有则由服务器核对该 attempt/qid 冻结行，未取得前不造 session |
| lesson draft/released/completed | attempt、data.questions 的真实 revision、lecture 元数据、blocks、孤儿题、released | data.questions 下标就是题卡号；completed 的首题常量就是当前阅读题 | 公共排序规则 + 页面交互/阅读候选；released 题和完成回看也发布真实题卡身份，禁止常量首题冒充当前题 |
| lecture | 详情返回的实际 lecture/course id、名称、updatedAt | headingIndex/outline.id 是稳定 sectionId；存在题目冻结 UUID | session:null；sectionId:null；lectureUpdatedAt 继续原事件语义，不私塞进 v1 假装冻结版本 |
| 零题/整卷无题随笔 | 页面来源真实，但没有某道题 | session.questionCount=0、假 questionRevisionId、把上一页题当当前题 | active question 为空；整卷随笔 anchor:none、context 省略，不构造无效 session |

客户端不能从路由参数 alone 把“这个 id 存在”升级为已核验权限。页面已授权 DTO 给 target 引用；异步 canonical 回执仍须检查 principalEpoch、routeEpoch、owner lease、target/revision 代次后才能写回 store。

## 5. 单仓状态、租约与优先级

建议内部模型（内部 loading 状态不冒充业务 attemptPhase）：

    Principal = { origin, role: student, studentId, epoch }
    HostLease = { opaqueToken, principalEpoch, routeEpoch, viewId }
    SourceTarget = 真实 question/lecture 引用 + 可选真实 expected revision
    Candidate = { target, context: 已核验 LearningContext 或缺省,
                  reason: explicit/observed, serial, eligibility }
    Snapshot = { activeHost, selectedCandidate, canonicalState }

只有这一个 store 拥有实时 selection。已固定的 composer/outbox source 是一条记录的不可变输入快照，不参与实时选题，不是第二份焦点仓。AI 已打开会话的 boundQuestionId 同样保留原会话绑定，不随着阅读焦点重绑。

### 5.1 注册与清理

- 一页/一个活动阅读宿主注册一个 lease，不按每张虚拟题卡注册全局 host。
- registerHost 每次实际注册生成新的 viewId UUID 和 opaqueToken；它们是客户端真实显示实例身份，不是题目版本 UUID。StrictMode 的旧 cleanup 只释放旧 token/view；相同题值也不能删新 lease。
- 页面只接受当前 principalEpoch/routeEpoch 的 lease 写入；unregister、异步 query resolve、blur 和定时任务均携原 lease 校验。
- 新页面成为 activeHost 后，旧 host 的候选不能靠“explicit 优先”反抢页面，也不能由旧 cleanup 清新 host。
- route identity 以表面 + 实体 id + 明确课程语境识别。单题 q、reviewQuestion、AI 浮层等同页参数不当成离开页面；切 attempt、切 lecture、同讲义切课程则开新 routeEpoch。
- 变更账号先递增 principalEpoch、清 selection、取消旧 query/transport、使所有旧 lease 无效，再绑定新账号。复用现有 clearAccountQueries、StudentLayout 与 outbox 的账号保护；不重写认证流水线。
- selector/action 同时核对调用方当前 principal，不能只等 StudentLayout 的 effect 清理：若 me 已变而旧 store 尚未绑定完成，读取为空且旧动作拒绝。现有账号切换保护能满足时只复用它；只有测试证明有空窗才在已有同步 apply/clear 时点补一条失效接线。
- 登出/主体变更只撤回焦点，不删除旧账号本机未传笔记。旧 outbox 捕获的账号键和 source 都保持原归属，新账号绝不能重发它们。

### 5.2 显式与滚动的确定顺序

1. 同一 activeHost 中，题卡菜单、答案操作、落笔/纸面操作、有效的键盘/导航跳题、AI 题卡入口为 explicit；恢复位置和 IntersectionObserver 为 observed。
2. explicit 在其仍可见（建议沿既有 >=10% 口径）、持有 DOM 焦点、编辑器正在该题或该题来源弹层正在打开期间优先于 observed；普通渲染/effect、后台保存回执、笔迹补传不升级为用户显式动作。
3. 显式题离开视口且不持有焦点/编辑/弹层时，释放其优先权，采用既有阅读观察器的真实候选。不是永远钉住上一道点击过的题，也不靠任意固定几秒失效。
4. 单题布局只接受真实当前展示题的 observed；被 hidden 的其他题和材料列滚动不能成为另一道当前题。
5. 点击下一题只有受保护导航成功后才发布目标；本机落盘失败、继续书写取消、AI 收起失败均保持原题。不改变原编辑器 -> 落盘 -> AI 收起 -> 切题顺序。
6. focusout 进入同题、题卡菜单 portal、composer 或 AI 控件时不清来源；切到另一张题的真实 focusin 才发布另一题。点击工具栏导致 blur 不等于离开当前可见题。
7. window blur 本身不当作 hidden：两个仍可见窗口可分别上报，在服务器形成真实候选；visibility hidden/pagehide 才立即撤回 MCP。返回 pageshow/visible 时只恢复当前有效 lease 的候选，不复活旧账号/旧路由。
8. 题卡卸载只撤销其观测资格；父 host lease 不注销。若持有编辑/弹层，先遵循现有保稿/强制挂载规则，不改 InkPad 或虚拟列表卸载语义。

这些定义与学习事件的有效用时分开。useAttemptEvents 可以继续拥有现有时序采集状态，但不能再成为另一份供 memo/MCP/AI 选题的共享仓；本包不改其计时、事件协议或算账。

## 6. UI 发布与题卡入口

### 6.1 页面接线

- AttemptSession：复用已拆分的 question-location/navigation；阅读位置作为 observed，成功跳题及题卡事件作为 explicit。现有 UI currentQuestionId 可留作“阅读/布局候选”，AI/MCP/memo 不再各自直接消费它作为最终真相。
- AttemptQuestionRow：复用现有稳定回调、纸面事件和答案提交链做事件接线，不把后台 flush 当显式动作。根部 pointer/focus capture 只增加发布，不 preventDefault、不 stopPropagation、不替换既有收笔逻辑，排除 portal 外部节点误归属。
- AttemptResultView：复用 useResultReviewLocation 的 jump/恢复及 ResultQuestionRow；导航/明确卡内操作为 explicit，滚动为 observed。未公布时同样可记本人笔记，但坐标不含判分/答案信息。
- StudentLessonPage：草稿、released、完成视图都用同一个 publisher；复用阅读恢复，只补候选发布，不把现有 completed 的 data.questions[0] 常量当当前题。讲义 md 段本身可发布 lecture 内容位置，不虚造某道题。
- StudentLectureViewPage：用真实详情 courseId，不信任未核对的 query 字符串；章节先 null。现有目录/滚动 observer 不复制一套。

### 6.2 题卡与整卷菜单

- AttemptQuestionCard 的 QuestionMeta 目前已承载更多菜单，且文件 795 行。建议先按“题头元信息与菜单”抽出 AttemptQuestionMeta.tsx，再通过显式 onCaptureMemo/source 回调加“记随笔”。不在题面采集/圈画层里插入 composer。
- draft lesson 已复用 AttemptQuestionCard，直接消费同一入口；released lesson 是独立 article，应加同视觉规范的最小更多入口，只承载这次来源动作，不强行把作答态头部/工具栏搬到结果卡。
- 普通结果卡已有 ResultQuestionTools 的更多材料面板，在该面板增加本题“记随笔”动作，保留现有草稿/订正实例和 DOM/key；不另造整套结果菜单。
- 用小型 QuestionMemoAction/公共 capture handler 共享“从已给定题卡引用打开”的行为。host 级浮层承载 MemoComposer，不为长卷每张卡挂一个常驻 composer/媒体录制器。
- 入口触控与键盘沿既有 44px/菜单语义；关闭回实际触发题卡按钮；题卡被虚拟卸载时复用原定位链找回入口，不让旧 ref 抢新页面焦点。
- AttemptHeader 的整卷随手记显式打开 anchor:none 的快照；不借滚动推断绑题。讲义工具栏仍绑本篇讲义，普通页面浮动入口按当时有效仓快照或无来源打开。

## 7. 消费方与离线保稿

### 7.1 Composer 与 outbox

MemoQuickCaptureDialog 增加 opening source snapshot；MemoComposer 只在本次打开初始化时取它，不能持续 useLearningFocus 重算 anchor。用户主动“去掉来源”后，本条同时去掉 anchor/context，不因仓变化又加回来。关闭重开才取新快照；多媒体录制/手写完成期间同样不换来源。

outbox 新记录增加可选 context/deviceId，必要时另保留真实 sourceRef（不是伪 LearningContext）：

- 完整 canonical 已取得：深拷贝该 context，补真实 viewId/layout/currentDevice 的 UUID 后入队，JSON 与 multipart 均原样传 context/deviceId。
- 离线或旧页面缺完整 metadata：立即按现有保证把正文/媒体、真实旧 anchor 引用、recordedAt/clientId 和已有的真实 revision 提示保存在本机；context 字段省略，绝不填 null、假 UUID 或 0 通过类型。
- 联网后优先复用服务端 canonical 核对补齐；已知 expected revision 若不一致不能静默换新版本。未知版本仍是待核对引用，不能在客户端提前声称当时有完整 session。
- 沿用 1.4 anchor-only 兼容写入时，服务端可生成真实 context；来源已失权/不存在时按原兼容策略保留本人笔记并允许 context:null。这只是笔记保存结果，不是原题读取/AI/提交许可。
- 不用 canonical 网络请求阻塞本机入队；旧 outbox 没有新字段照常补传，不升级数据库结构、不批量重写旧条目。
- 网络重试不从“现在的全局焦点”重建 source；失败的媒体重试仍复用同一 clientId、Blob 和固定来源。
- 现有主体校验头、账号 key、异步回执隔离与 64KiB UTF-8 元数据预算全部复用。新增 context 后更容易超预算，应如实报错并保留本机条目，不能裁剪真实 ID/标题或扩大预算换成功。
- server canonical 回执可用于显示这条已创建 memo；不能把回执里历史来源重新发布成当前阅读焦点。
- 已有同 clientId 行先命中再返回原行，不因后来的读权限/结算/名称变化重算其快照；本包不改变既有幂等摘要或旧 outbox 重放语义。

### 7.2 MCP 心跳适配器

mcp-live-focus 只保留传输生命周期：序号、timer、最后已发/撤回状态和 generation；每次从单仓读取当前 target，不再拥有独立 questionId 选择状态。每个 host 用仓的真实 viewId；同一 view 的序号单调，旧 lease 的撤回不能发到新 view。

- 保留自愿开启、默认关闭、20 秒心跳、60 秒服务端 TTL、generation、撤回墓碑、keepalive 与迟到包保护。
- eligibility 来源于真实宿主 attempt.status 和现有服务能力；现有服务仅允许 draft，不能因为 view 名叫 result/lesson 就伪造一个可定位阶段。结果/完成态仍可供 memo/AI 正常消费，但旧 MCP 定位不越权扩展。
- capability/generation 或 principal 变更时销毁旧 transport 的捕获身份；不能用新的 generationRef 给旧账号旧题发送心跳。
- hidden/pagehide/卸载立即撤回；offline 停止无意义周期出站、保留当前本机候选，online 重新核对 capability 后续报；失败时服务端 TTL 自然过期。
- 保留不同浏览器窗口各自的 view，不做 localStorage/BroadcastChannel “最后一个页面胜出”。现有旧工具冲突返回空的行为仍由后台维持；2.2 未来候选输出另实施，不在本包顺手改。
- 当前 requestSchema 对 qid 有 512 长度限制，而 1.4 内容 ID 无该限制；建议在本包的契约接线中改为共享 learningContentIdSchema，保留请求总字节上限并补边界用例，不截断/伪造 qid，也不扩大其他出口预算。该小契约文件需与未来 2.2 排队。

### 7.3 AI 消费

移除 Dock 的两个“发布者”副作用；打开瞬间从仓/题卡显式 source 取得身份。已打开对话的 boundQuestionId、材料、输入与旧任务 lease 保持原样，滚动不能重绑。

卡内明确点击 q2 不取全局猜到的 q1。旧任务跨题仍先走原 ensureAtQuestion/goToQuestion 受保护导航，失败则保留现场且不发布虚假目标。服务端原有 AI 当前教学策略、任务授权、受控答案出口规则不变；LearningContext 只是未经信任输入，不是 AI、submit 或 lease 票据。

## 8. 建议写集与规模方案

以下为具体候选写集；实施时按固定合并树验证实际文件名和必要性，不先改热点再找边界。

| 层/目的 | 新增或修改路径 |
| --- | --- |
| 新读契约/共享排序 | packages/contract/src/learning-context-api.ts（新）；lesson-question-order.ts（新纯函数）；index.ts；必要的 student-mcp-live-focus.ts；对应契约测试和真实生成 schema |
| 服务端共享 canonical | apps/server/src/services/learning-context-projection.ts（新）；memo-context.ts（兼容适配及新式明确课程校验）；必要的严格读侧测试 |
| 新只读 route | apps/server/src/routes/student-learning-context.ts（新）；student-attempt-routes.ts 仅挂载；student-learning-context.test.ts（新） |
| 单仓/发布 hook | apps/web/src/features/learning-context/learning-context-store.ts、use-learning-context-publisher.ts、learning-context-queries.ts（新）；按职责控制约 200-350 行，别造万能 context |
| 旧适配器 | features/memos/learning-focus-store.ts；features/student-ai/mcp-live-focus.ts 及既有测试；前者删除 current 状态，后者只做传输 |
| Memo 冻结与上传 | features/memos/MemoQuickCapture.tsx、MemoComposer.tsx、memo-outbox.ts；必要的 lib/memo-api.ts 接线（1.4 已有 context/multipart 支持优先复用）；对应既有测试 |
| 卡菜单 | features/attempt/AttemptQuestionMeta.tsx（从现有职责抽取）；AttemptQuestionCard.tsx、AttemptQuestionRow.tsx；小型题卡 Memo action；lesson/LessonQuestionCard.tsx 的 released 最小入口 |
| 页面发布 | features/attempt/AttemptSession.tsx 与已拆导航/位置的最小事件接口；AttemptResultView.tsx、ResultQuestionRow.tsx、ResultAiActions.tsx；pages/student/StudentLessonPage.tsx、StudentLectureViewPage.tsx |
| AI 订阅 | features/student-ai/AiCompanionDock.tsx 删除旧发布，接单仓读取；不动 send/CAS/lease 主路径 |
| 主体绑定 | pages/student/StudentLayout.tsx 的绑定处和已有清理测试；仅必要时在已存在 apply/clear 的同步时点接入一个 clear，不盲重构 auth |
| 文档/守门 | docs/约定/界面与账号.md、学生作答与讲练.md、学生AI伴学.md、页面功能清单.md；必要的 scripts/file-size-baseline.json 只降；I16 白名单仅随真实搬移更新路径/理由、原片段/次数不变 |
| 浏览器 | e2e/learning-context-memos.spec.ts（建议独立），新增时同步 scripts/e2e-affected.mjs 的 SPEC_TAGS；不把未登记 spec 当窄选测 |

规模切点：

- AttemptQuestionCard 795：先抽 QuestionMeta，保留题面/编辑/圈画本体，不改 InkPad；已登记的 response 取值若留原文件则不迁 I16。
- AiCompanionDock 858：本包删发布、副作用接单仓；能减量就不为本包重做 AI 结构。若还需新增大块消费者逻辑，抽 host-context adapter，不能等价套壳。
- AttemptResultView 913：优先抽现有 ResultQuestionCard 的实际题卡/材料呈现职责后接 publisher，保持 DOM/key。相关公共导出保留路径兼容。
- StudentLessonPage 1102：先抽现有 lessonQuestionOrder 及题卡/讲义正文装配职责，基线必须下降；不以 part2 或纯转发凑规模。
- memo-outbox 386：增加来源字段前将“上传信封组装”按一个真实职责提成 memo-outbox-upload.ts；账号队列与重试所有权留原模块，不复制队列状态。
- memo-context 331：构造器提取后应下降；student-attempt-routes 很小可局部接线。禁止增长/编辑 attempt-service.ts、student.ts 的 submit 主文件。
- I16 先跑真实守门取红灯；任何文件搬移都核对以“路径+片段+次数”为键的双向表。不得再用局部语句 AST 对照代替全仓路径守门，不增加整文件豁免。

不在写集：db 迁移、结算接口、attempt-submit 服务/幂等摘要、时间落账、MCP 工具注册、memo 标签列表 UI、InkPad、纸面工具条、全仓 features 公共层搬迁。

## 9. 实施顺序与最小 TDD/浏览器矩阵（未执行）

建议按可独立验收的小提交推进：

A. 固定含 C/F 的合并基线；确认 S 的 memo-context 小文件冻结后再衔接。先为已确认的同值 cleanup、composer 变锚、讲义 B 课 canonical、公开序错位写失败测试。
B. 契约先行，做共享 canonical/排序与只读路由；严守普通投影/AI 权限不同的调用入口，新增读出口先补泄露测试。
C. 单仓生命周期与旧适配器迁移；把 MCP/AI 改为消费者，保留传输与对话状态。
D. 各页面 publisher 与题卡明确来源入口，最后接 composer/outbox 固定来源。
E. 复用有效已有证据、运行受影响检查、完整 diff 的简化/正确性/安全审查；不把设计阶段当实现/上线。

最小有效用例：

| 层 | 必须验证的行为 |
| --- | --- |
| store 单测 | explicit 优先、离屏释放、同页 q 不重置；相同题值的新 lease 不被旧 cleanup 清；旧 principal/route 的晚到 canonical 不发布；StrictMode 注册/清理；虚拟卡卸载不清父 host |
| capture/outbox | 打开 q2 后滚动 q1、切布局或全局焦点，文字/语音/图/手写仍是 q2；主动去来源后不回填；媒体失败同 clientId/Blob/source；离线无完整 canonical 仍能本机入队旧 anchor；联网服务补齐真实 context；旧无字段条目可传；换账号不串源 |
| canonical/契约 | draft/result/lesson、wrong/multi-unit、缺可选 revision、坏快照、blocks 重排/孤儿题；qid/revision/No/count 精确对应；零题无伪 session；selected course B 可见/不可见；null/optional；超长合法 DSL id；真实 settlement/null 与客户端伪值覆盖 |
| MCP adapter | 单仓目标即上报目标；20s/60s、hidden/pageshow/online；generation/principal 改变；旧 withdraw 不清新 view；不同可见窗口各自保留；默认关闭；结果/完成态不冒充 draft |
| AI/导航 | 卡内 q2 明确目标；已开对话不随滚动重绑；旧任务受保护切题成功才换源，落盘失败/继续书写取消保留当前现场 |
| I16/规模 | 真 I16 整文件；路径迁移双向差集为零；文件基线只降；不 skip/降断言/放宽超时 |

建议新增浏览器场景，均以真实创建后读取的服务端 memo/context 断言，不能只看页面“已保存”：

1. 列表布局：q2 更多记随笔，滚到 q1 后保存，服务端 qid/revision 仍与 q2 卡一致。
2. 单题布局：q2 打开记录端后全局导航/焦点变化不换锚；保留本机失败切题保护。
3. 材料分栏：材料列滚动和主列切换不误绑其他题，菜单来源与冻结版本一致。
4. 讲练：未交、released、完成回看各一条；blocks 重排/孤儿题序准确；不以常量第一题替代当前阅读。
5. 普通结果：含旧响应缺可选 revision 和待公布结果；坐标可用但没有新增答案/判定泄露。
6. 讲义多课程：从 B 课打开，记录的 courseId 为 B；不能借 A 可见绕过 B 不可见。sectionId 仍诚实为 null。
7. 离线与主体：离线记媒体保稿后换账号不串源，回原账号只补原条；旧 host 晚 cleanup/new host 同值、两个标签不同题的本机选择与上报身份正确。
8. 整卷入口：有题/零题均可写无题随笔，不借上一次焦点填入 session。

采用项目工程验证入口。契约/schema/scripts 触发自动全量时记录真实决策，不以以上定点矩阵冒充完整选测；实施期按编排的资源窗口运行，完整双浏览器/构建/最终 CI 按实际授权执行。新增 spec 必须登记 SPEC_TAGS。真实 iPad/Pencil/Safari 另验，浏览器模拟不等于真机。

## 10. 权限、泄露与兼容矩阵

| 输入/场景 | 预期 |
| --- | --- |
| 未登录、教师 Cookie、他人 attempt/qid/revision、同教师但不属于本人 | 新读接口拒绝，无可区分存在性/标题/错误 extra 泄露 |
| 本人 course draft 失去可见性、软删/作废、课内讲义未发布 | 复用各自现行可见门；不能用 memo 历史兼容允许记私笔记的逻辑给读接口放行 |
| 已交卷但答案待公布 | 只给允许的身份/公开名称，不新增 answer/solution/hints/verdict；AI 门仍独立重验 |
| 隐藏的推断 lecture 或外部课程 | 规范化不暴露其 id/title；明确讲义/courseId 必须本课可见 |
| 客户端伪 title、unit、course、revision、No/count、settlement、device | 标题用服务器；身份不一致拒绝；settlement 用真实行不作授权；device 用本人已登记/别名解析，不能跨人引用 |
| canonical 响应与日志 | 白名单身份字段；禁题干、未公布答案、解析、未解锁提示、邻题内容、教师私注、其他学生资料、凭证与内部账号 |
| MCP 定位默认关闭/代次重置 | 不发送或不能被服务器采纳；context/viewId 不是连接/任务/提交票据 |
| 旧 memo/旧 outbox/clientId 重放 | 不重写旧快照，不回填假版本，不改变旧默认选课；返回原行/seq，来源失权不等于本人笔记丢失 |
| metadata UTF-8 超限 | 真实失败且保留本机内容；不裁剪源 ID、无静默 context:null 伪成功、不扩大 1.4 预算 |

每个新读响应都有明确允许字段断言和敏感哨兵断言；对可见/不可见讲义、同题/邻题、班级/个人账号分别覆盖。允许场景必须确实返回目标坐标，禁止空集合假绿。

## 11. owner 事项、默认假设与边界

本包按上述默认方案没有必须 owner 再选择的事项：D1 不被本设计代选；无新付款、部署、删数据或权限放宽；现有离线记录和无题随笔保持可用。若后来要求“从未取得真实版本的离线页面也必须在本机声称一个完整冻结版本”，技术上不能诚实满足，须先提供服务端原子公开元数据；本设计不会以占位值达成。

实施前需要技术复核而不是 owner 产品决策的事项：

- C/F 实际合入目标 v2 的 SHA、接口导出和文件行数；S 的 canonical 两行与最终审查结果。
- 页面公开序与新 strict memo 校验同源，特别是 lesson 两个合法表面和坏快照；历史快照/幂等重放没有被新排序重写。
- 学生布局现有账号绑定时点能否直接复用；若短暂旧子树仍挂载，必须以 epoch 测试证明隔离。
- 构造器抽取是否与 2.2 写集重叠，先约定服务端一个 SSOT，不在两项工作中各复制一次。
- 契约生成物实际输出清单、I16 条目真实落点与所有新增 E2E 标签登记。

本次只创建此设计文件，未向三棵证据工作树写入，没有运行应用或重型测试。收尾 F/S 仍为表中 HEAD，C 的生成物提交变化见 §2；三树当时均无工作区改动。既有 84 单测基线、22 项 E2E、类型/I16 补修等属于前一份纯重构证据，不拿来宣称本 2.3 新设计已实现或已验证。



## 10. canonical 小包冻结记录（前端仍在实施）

本阶段只提交后端、公共契约、完整生成物和本计划，前端 dirty 不随此小包提交。此阶段通过不代表 2.3 完成，也不代表二期或上线完成；D1 仍未决。

### 实际公开接口与权限分层

- 契约 `packages/contract/src/learning-context-api.ts` 导出 `LearningContextRequest`、`learningContextRequestSchema`、`learningContextOkSchema` 和 `LEARNING_CONTEXT_BODY_MAX_BYTES`（复用 64 KiB metadata 字节预算）。新 lecture selector 的 sectionId 只接受省略/null，旧 memo/历史 sectionId 语义未变。
- `POST /api/student/learning-context/resolve` 位于现有 requireStudent 子树；question 先经 `requireUsableAttempt`，lecture 经指定课程的 `requireVisibleStudentLecture`；不存在、非本人、作废和不可见统一 404。已核验可见题的 expected revision 不符为 409。流式 JSON 无 Content-Length 仍累计限额；名称展开后的输出也经 metadata 总预算检查。
- `services/learning-context-projection.ts` 是坐标构造 SSOT，实际导出 `contextFromMemoAnchor(db: Db, studentId: string, anchor: MemoAnchor, now?: Date, historical?: boolean, options?: LearningProjectionOptions): LearningContext | null`；options 为 `{surface?: "attempt"|"result"|"lesson"; courseId?: string}`。旧 memo 适配文件 re-export 同一实现，backfill 沿旧入口不新增第二套构造。
- 构造器不是 AI/MCP 授权入口。未来 MCP 必须先做 Bearer、AI/opt-in 和当前作答可用门，再用 `surface` 选择公开投影；不能调用 memo `input === undefined` 的吞 HttpError 历史保笔记分支获得读权限，不能把 `historical=true` 用于当前题读取。
- `surface` 只决定公开展示序，不改变公布/提交权限。attempt/result 复用 `getStudentAttemptPaper().units.flatMap` 的分组平铺/坏快照过滤；lesson 复用 `lessonQuestionIdsInDisplayOrder`（公共纯 helper）按正文首现/去重/孤儿题追加。版本恒取目标 qid 的真实 responses.id，seq 每次实读当前 responses.settlementSeq，未结算是真实 null。
- 新式 full memo context 使用相同 surface 序校验且明确 lecture courseId；无 context 的旧 anchor 默认选课/兼容吞错、已有 clientId 原快照优先和历史 backfill 行为保留。无 submit/activate/start/restart 服务写入改动，没有 schema/迁移。

### 本阶段实际验证

日志均在 `/workspace/channels/f76423cc/work/session-focus/logs/`。

| 命令/证据 | 实际结果 |
| --- | --- |
| 首轮 canonical endpoint TDD（`canonical-red.log`） | exit 1，6 项中 5 fail/1 pass，路由尚不存在 |
| lecture 未知 section 的契约 TDD（`principal-schema-red.log`） | exit 1；3 个契约测试中 1 fail/2 pass；另有独立前端 principal 回归首轮失败，本小包未含其实现 |
| `pnpm exec vitest run apps/server/src/routes/student-learning-context.test.ts apps/server/src/routes/student-memo-context.test.ts packages/contract/src/learning-context-api.test.ts packages/md-dsl/src/cli/standalone.test.ts packages/md-dsl/src/cli/bin.test.ts --maxWorkers=1` | exit 0，5 文件 43 项（14 新 API + 20 旧 memo + 3 公契约 + 6 CLI），无 skip |
| `pnpm gen:spec` 首轮 | exit 1；新契约相对导入缺 .ts，Node 原生执行失败；修复后重跑完整命令 |
| `pnpm gen:spec` 第 2/3 轮 | 均 exit 0；完整 schema、spec 与 standalone 生成；24 个生成/分发文件 SHA256 对照，重复后 0 漂移。实际差集仅新增 learning-context-api.json 和 tutor-lint.mjs（未手改 minified） |
| `pnpm --workspace-concurrency=1 --filter '!simple-tutor-tool' -r run typecheck` | exit 0，5 子包全部；包含在途前端当前树；前序类型首失败与定点修复日志保留，不以最终绿掩盖首轮错误 |
| `pnpm exec tsc -p e2e/tsconfig.json` | exit 0；当前未新增浏览器 spec，后续前端矩阵新增后另验 |

API 实证覆盖：未认证、跨人/不存在同 404、真实 expected revision 拒绝、未知字段、结果声称不泄露答案、流式 UTF8 总量、名称展开预算、长合法 DSL id、跨单元页面平铺、lesson 正文/孤儿题、坏快照不挪用版本、已冻结读取不写学习业务表/作废拒绝、真实 deviceId 保存及跨人设备拒绝、明确 B 课可见性、收尾后 seq=1 与旧同 clientId 快照仍 null。现有 20 项 memo 兼容回归复用，没有重算结算业务矩阵。

简化自查：只抽 canonical 组装，不抽 submit 主路径；页面排序 helper 为两端实际共同规则。正确性自查：新 full context 与 public No/count 使用同一投影，legacy/历史重放路径保留；无虚构 UUID/0/阶段。安全自查：新入口只返回契约白名单坐标/名称，明确当前可见门先行；前端输入不授权，server 再校验。

剩余：前端状态/来源冻结/outbox/AI/MCP 适配、菜单浏览器与泄漏矩阵、I16/规模/治理/完整选测决策和最终自查尚待完整包收口；本小包不声称已覆盖 UI。独立审查由主会话安排稳定 detached 树，不读取在途 UI。


### 10.1 独审两项 P2 补修（仅后端）

审查指出：(1) lesson 公开响应 view:null 的真实题序不能原样作为 memo context，旧测试手补 view.surface 才通过；(2) lesson 排序直接读取当前 lecture markdown，会在讲义隐藏后用私有当前正文生成顺序。正式首轮失败日志和原探针均保留，不用前一轮 43 绿覆盖这些遗漏。

已批准的最小修复不扩契约、不编造 host/viewId：新 full memo 在真实 view 明确 attempt/result/lesson 时只验证对应公开序；view:null 先验证 attempt 的真实 revision/No/count，精确不匹配才通过同一 projector 验证合法 lesson 候选，保存仍为 view:null。其他明确 view 不增加 lesson 猜测。候选校验不是授权，lesson projector 在读取任何当前正文前必须 `requireVisibleStudentLecture`，attempt.courseId 非空时明确传真实来源课；讲义在另一课可见不能绕过本课隐藏、未发布或失去成员权。attempt/result 冻结投影维持既有权限。

| 验证 | 结果 |
| --- | --- |
| 独审原 probe（仅把绝对 import 路径映射到本树，同一代码） | 红输出 lesson resolve200 / 原样 memo404、隐藏 lesson200；绿输出 lesson resolve200 / 原样 memo201 且 view:null、隐藏 lesson404。probe 本身只打印观测，进程 exit0 不算断言测试通过 |
| 新 API 整文件红轮 | exit1，19 项中 5 fail/14 pass：原样往返两例、B课 hidden/unpublished/lost-membership 三例确实复现；随后扩展软删/课程归档两例 |
| API+既有memo+契约最终绿轮 | exit0，3 文件44项全过（21+20+3），无skip；包含无host原样往返、显式surface严格、旧clientId原快照、两课可见门（隐藏/未发布/成员丢失/软删/课程归档）、无host/真实view原样写入、完成卷历史attempt/result、真实seq/null回归 |
| device HTTP真实路径 | 真实device头仍按已有 requireStudent 登记1台设备并绑定session；已冻结 attempts/responses 前后完全相同。只读承诺限于不新增学习业务动作，不改/绕过通用auth/session/device簿记 |

`pnpm --filter server run typecheck` exit0；3 个相关源文件 Biome 与 `git diff --check` exit0。无契约变更，完整 gen 的有效证据复用，不重开生成。

此补修只触 shared projector、memo 适配、API测试与本记录。前端 dirty 暂留工作区，不纳本后端修复 commit；无契约/生成/数据库结构变化。

## 11. 前端实施与最终验证

本节为当前实现记录；§10/10.1 是当时仅冻结 canonical 的阶段事实，前端 dirty 描述不泛化到最终冻结状态。独立审核和完整 PR CI 仍由主会话安排，本包不代写独审通过，不宣称二期/上线完成。

### 实际状态与来源流转

- `learning-context-store.ts` 是唯一当前来源仓：principal epoch、route epoch、opaque host lease、viewId 与 selected source；旧 host cleanup、旧 principal 与迟到 canonical 无发布权。同值新 lease 也独立。隐藏页保留本机来源但撤回实时上报，恢复从当前仓派生；不加 TTL 或第二份 current。
- `LearningContextEnvironment` 在原学生学习布局绑定已有 me.id；`LearningPrincipalContext` 仅透传调用者的已认证主体输入，不存焦点或新授权。旧主体还挂载时不能在新主体 epoch 重新注册旧卷，也不能捕获新人的来源。原 PortalGuard/个人视角/教师学生身份处理不改。
- 四类 publisher 的 reference 来自实际授权页面 DTO。attempt 用真实 flatQuestions/revision；result 的可选 revision 缺失时不补造；lesson 用同一公共题序 helper；lecture 用详情返回的真实 lectureId/courseId，sectionId:null。仅对实际观察或显式选择的题请求 canonical，缓存按 principal/reference/真实展示序区分；晚回执必须仍属同 host/reference。
- 显式题卡交互/输入/显式切题优先于已有阅读观察。仍可见、实际输入聚焦/编辑、打开弹层时保持显式源；零尺寸或离屏且失去资格后允许阅读接管，blur 后在事件焦点稳定的 microtask 重新核对，不加任意延时。单题/列表、结果恢复、讲练节/题阅读继续使用原观察器；纯标题不造 question/session/section。
- 原 learning-focus 文件只保留兼容选择器/发布租约适配，没有独立 current；MCP reporter 只存传输序号/发布状态，每次派生当前题，继续受原 capability generation 与 opt-in/AI 门控制；离线、后台、卸载撤回旧 view。Dock 只消费仓，已绑定会话、输入、材料和任务 lease 不随滚动重绑。讲练未被 Dock 消费的旧 AI currentQuestionId state/包裹 onAnswer 已清掉，宿主兼容字段只传原阅读观察值。
- 题卡记录端每学习布局一份。卡片按自身 route/qid 捕获 source 快照，原真实 revision/No/count/reference/view 固定到本条完成或取消；整卷菜单显式 none，讲义工具栏保留真实讲义源。Radix portal 与触控/键盘复用；`onOpenAutoFocus` 同步落到 textarea，Escape 归还实际触发器。每次打开有独立记录身份/key，旧记录迟到入队回执不能关闭新记录或解除其保护。
- outbox 不升级存储结构；旧条目缺新字段继续上传。新条目保存真实 context 或可验证 reference、source display/view/principal 与现有真实 deviceId。入队先落本机，canonical 请求不阻塞本机保存；缺版本时省略完整 context，404 兼容退回旧 anchor，409 expected revision/展示序不符保稿拒绝静默重绑。文本与 multipart 同一信封；队列与回执沿原账号保护，服务端仍重新 canonical，旧 clientId 原快照优先。

### 规模与职责

| 文件（产品基点→本包） | 实际处理与剩余共同变化职责 |
| --- | --- |
| AttemptQuestionCard 795→535 | 题头/更多菜单抽为独立 QuestionMeta 280；本体保留题面、书写/圈画与回答装配。response kind 收窄仍在原路径，真实 I16 无需迁移白名单 |
| AttemptResultView 913→537 | 结果题卡/材料块为 ResultQuestionCard 357，解答折叠为 ResultSolutionFold 62；视图保留卷级结果导航/总结/动作装配，公共旧导出兼容 |
| AttemptSession 1470→1465 | 答题卡与提交遗漏统计的真实完成度派生抽为 attempt-navigation-items 54；继续保留原答题/同步/提交装配历史基线，不做机械 JSX 切片。后续可按编辑/材料装配真正共同变化进一步分包 |
| StudentLessonPage 1102→910 | 讲练序、组锚点请求、页头分别抽为实际共享职责模块，低于硬线移除基线；保留讲练生命周期/答题与完成视图装配 |
| AiCompanionDock 858→847 | 删旧发布/心跳宿主副作用，保留已绑定发送/CAS/租约与布局编排；新增源选择在共享仓，未塞入另一份 current |
| StudentLectureViewPage 438→440 | 发布规则提到共享 publisher，页面只传实际详情 descriptor；现有正文/目录/阅读痕迹是同一阅读页共同变化边界，后续可按阅读痕迹职责拆，未为2行增长机械切片 |
| MemoComposer 397→416 | 先把来源信封组装提为 memo-source-fields；记录端保留四形态输入、失败媒体/原键重试等同一保稿表单职责。软线保留并解释，不为400凑行；队列上传另已按真实职责拆分 |

新模块均低于400，历史硬线只降不升（29→28基线项）；未动 InkPad/纸面工具条、submit 主路径、计时/激活/分批/模板/标签列表 UI/MCP工具注册，没有本包新增迁移。文档约定只更新真实来源、入口和消费规则。

### 最终验证证据与首失败

完整日志/范围工件位于 `/workspace/channels/f76423cc/work/session-focus/`，命令详细清单与 SHA 在树外冻结卡；不能把下列局部结果说成全量。

| 范围 | 结果与边界 |
| --- | --- |
| 前端最终定点单 worker | `ui-final-targeted-unit.log`：20文件272项 exit0，含 store/publisher/composer/outbox/MCP/Dock/题卡/讲练/结果/身份布局、真实 I16 全扫、SPEC_TAGS选择器。其后仅清掉讲练未消费的旧 state/包装及测试非空断言，`ui-dead-focus-unit.log` 3文件31项 exit0；其他有效结果复用 |
| TDD红绿 | composer打开后变锚红1fail/5pass→绿；旧principal publisher/未知section契约红2fail/2pass→绿；关闭纸面显式优先红1fail/1pass→绿；隐藏零尺寸/blur红2fail/5pass→绿7/7；旧记录迟到入队回执红1fail/3pass→绿4/4。初始store红为模块尚不存在，未冒充状态行为失败 |
| 新浏览器首轮 | Chromium1 worker/0 retry，8项中1pass/7fail exit1，完整trace/screenshot保留。真实产品缺陷为带锚Dialog未聚焦textarea；通过控件生命周期同步修复。夹具问题为页面尚未稳定即断网、材料缺新内容专用环境、课程文本节点精确匹配错误、用draft禁键monitor误判受限result契约的null字段；原monitor不改，受限结果严格所有参考/解析/判分null与canonical原始白名单均保留 |
| 新浏览器修后 | 第二轮聚焦/就绪相关5项4pass/1fail，剩余是讲义文本span的尾空格locator错误；最终同一生产代码的有效绿为该轮4项加下一轮4个新场景。第三轮新剩余4项+既有AI三布局1+随笔2，7/7 exit0（1.1m），共覆盖8个新case与3个既有case，不合并计为一次11项运行 |
| 最终讲练死状态清理后 | `e2e-lesson-final-hash.log`：只重跑受影响讲练一项，Chromium1 worker/0 retry，1/1 exit0，15.2s；清理后端口0 listener，无本树应用残留 |
| 浏览器配置/资源 | `CI=1` + 缓存 Chromium headless shell1243 + 实测 LD_LIBRARY_PATH；仅iPad模拟，非真机。workers1/retries0，未触发 student-workspace PERF_GATE。材料使用既有qm隔离对，Chromium18891/15191、WebKit18892/15192，finally teardown；实际两浏览器并发留给CI。首次8、实际@student grep清单90项含新8、最终窄选7均有非零 --list日志；不是dry-run冒充测试 |
| 类型 | 五子包串行排根曾 exit0；canonical补修 server tsc exit0；最终仅web与e2e分别串行 exit0，其余无变源有效复用。首轮server测试unknown/nullable、前端exact optional/import类型错误及修复日志保留；新增fixture一轮browserName未用 TS6133 exit1，按project隔离端口接线后重跑exit0 |
| 生成/后端复用 | canonical最终3文件44项、CLI2文件6项既有有效证据；完整gen第2/3轮exit0且24生成文件0漂移；本UI/后端补修未再改公契约/生成源，不重跑后端/生成来凑验证 |
| lint/规模/治理 | 43个变动代码/JSON文件Biome exit0无warning；全仓1036代码规模 exit0，staged33代码（7软线，1历史硬线）exit0；基线28条。治理与diff/check exit0。I16原片段/次数/路径表未增加豁免 |
| 全量选择 | origin/main=89fab4c43772d4588f74b4ddf5ef32dd5faf8ef4；origin/v2=d02f90ab3bf9aec2af9fe011fe7e5d9376ee87a0。本地无v2分支，使用明确origin/v2。test:affected 与 e2e:affected dry-run 都实际选全量（上游迁移兜底），日志保留；未执行本机全量/双浏览器，交主会话最终CI，不以小集冒充 |

覆盖矩阵：真实题卡qid/版本/题序、列表/单题/材料、结果可选revision/未公布、讲练草稿/当题释放/完成/正文孤儿序、讲义B课、whole none、主体变化/旧host/StrictMode/隐藏/blur/旧回执、离线图片/旧outbox/已知版本冲突/真实deviceId、AI已绑定不随滚动与MCP前后台传输均有定点证据。语音真实麦克风、Pencil手感/原生缩放、真机Safari、最终双浏览器与全量CI仍未本机覆盖，不由iPad模拟替代。

本 UI 冻结时，主会话提供的新公开 canonical c70 全量 CI 有一项上游原 settlement-race harness 超时（8319/8320通过并有Unhandled Rejection），正在独立诊断；该文件与已审1.3 blob相同，未因 canonical 或 UI 修改。不能据此称本PR完整CI通过，也不先归因为产品竞争或资源抖动。若确认测试启动/清理缺陷，将另独立提交测试修复及证据，不混入本UI提交。
