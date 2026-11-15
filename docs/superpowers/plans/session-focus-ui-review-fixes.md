# PR165 完整UI独审 P2 修复计划与记录

基点：45ccd2fe80b0520fd5997f41ed48934f728025c4（UI源码仍4bf58f95）；独立树session-focus。只修已确认三项P2，不改已审canonical/contract/生成物/后端服务与harness五文件，不push/派子/外发。

1. 题卡动作的闭包携带原页面publisher的opaque host lease，明确该卡surface与已知revision；不在click时从全局current重借宿主。只读宿主边界透传已有lease，不增加第二份current或每题composer。复用真实host viewId标记DOM归属；pointer/focus/显式memo动作通过同一store身份门，失效动作不改新仓、不打开新composer。合法非当前题仍可明确捕获并冻结；未知legacy revision省略而非伪造，不阻断本机入队。
2. 可见资格按正尺寸卡片和viewport二维交集面积 / 卡片面积 ≥ 10%；保留真实DOM焦点、编辑及打开弹层例外，不加TTL。正式回归覆盖完全/部分横向、10%边界、零尺寸、纵向、旧surface/revision/view/lease与迟到canonical。
3. ResultAiActions宽屏整卷按钮明确unanchored，与已有窄屏一致。宽窄真实控件测试要求none且无question context/reference/view/display；讲义/题卡正路保留，不清全局焦点或AI绑定。

TDD先在本树运行独审原探针（仅复制测试文件，不改断言），然后补正式语义回归。首次跨根config出现Vite /@fs路径错误、0项测试，此结果不算复现；原文临时副本正常执行的红绿另存ui-review-fix/。临时probe不提交。

规模：宿主输入在已有workspace/讲练内容边界透传；题卡本体、元信息菜单与publisher模块继续各守职责，不能把lease绑定放进InkPad/工具条。AttemptSession历史1465基线不增长；其他>400文件仅增加确认修复所需真实identity/边界接线，职责理由沿既有计划，不机械切行。I16原kind分支不搬移、不新增白名单。

修后：单worker定点正式回归+原probe、web/e2e类型、真实I16、lint/规模/治理/diff；浏览器排窗后只复测受影响列表/布局/讲练动作及宽屏整卷，最多1worker/0retry。后端/生成/harness有效证据复用。保留原4bf/45 scope和日志，另存修复提交、完整新HEAD/tree及实际d02全PR四scope，交原reviewer补审；执行端不写独审通过。


落地边界：LearningHostContext只传publisher已经持有的HostLease引用；它没有current/source或写接口，不注册新host。作答/结果在已有AttemptWorkspace边界、讲练在LessonBody边界各传一次；菜单Portal沿React上下文携带原host。store.captureQuestion统一核opaque lease、route、qid、surface和调用方确知的revision，DOM交互也调用该门。viewId只标记DOM属于哪一个真实host，不作为权限凭证。服务端canonical和memo权限仍独立校验。

真实版本接线：AttemptDraftData.units.questions和LessonStartData.questions本来就是attemptQuestionPublicSchema的冻结投影，原对象经AttemptQuestionRow/LessonQuestionCard交给AttemptQuestionCard，无重新parse为基础题型或剥字段。共享卡输入显式接受QuestionPublic及该契约的可选questionRevisionId扩展，Meta收到单独可选值。真正没有字段时省略。列表、讲练浏览器断言DOM版本等于真实接口DTO；结果兼容case仍刻意删除可选DTO版本并验证canonical补齐真实版本。

软线职责评估：AttemptQuestionCard只增加宿主DOM身份和菜单来源同变接线，原有标注/导出职责可后续单独拆；AttemptResultView/StudentLessonPage只在已有布局装配边界持有并透传publisher lease，不搬导航、工具条或渲染切片。LessonBody内容先构造成节点再包一层无DOM的只读边界，保留原JSX结构和缩进。此修复不另起抽象转发链；AttemptSession仍1465，28项历史规模基线无需改变。

验证记录（完整命令与stdout/首失败在树外 session-focus/ui-review-fix/）：

- 独审原probe原文复制hash相同：正常本树命令先2files/5cases，3失败2通过exit1；同原文后6files合跑包含这5例，全48通过exit0。最初跨根config路径失败且0例单列，绝不作为红灯证据。临时probe已移出仓库，不提交也不进入类型范围。
- 正式首轮3files31cases，10失败21通过exit1；修复后正式4files43例通过。追加旧卡不能替换新host已开草稿/合法非当前q/缺版本旧引用入队，以及焦点、编辑、弹层的二维离屏例外。旧/新canonical回执与新草稿同时保留，迟到旧lease不改新snapshot，composer仍保存打开时的reference。
- 相关15files210cases（含真实i16-ast-guard整文件）单worker通过exit0，无I16白名单/原片段/数量变更。最终受影响capture/card/layout 3files32cases通过；该轮首次既有Escape焦点断言早于Radix卸载autoFocus回调失败1例，依赖源码证实异步生命周期，测试改为默认waitFor等待同一toHaveFocus断言，无产品延时、超时放宽或skip。浏览器真实键盘/Escape已通过。
- web tsc首轮发现Meta基础QuestionPublic没有版本字段、新测试fixture断言/TestingLibrary选项类型不符，均保留首次exit1。真实契约扩展接线与fixture修正后web/e2e tsc通过；只影响web和e2e，无需重跑其他四包有效类型证据。
- 新spec现有8例全部--list非零，Chromium workers1/retries0首轮8通过exit0，59.1s；CI=1、既有browser cache与LD_LIBRARY_PATH实测有效。覆盖列表/单题/共享材料/离线图片/整卷无题/未公布结果/讲练三态/明确B课讲义。结果case在第二题记录后从宽屏和窄屏整卷真实保存，anchor均none且完整context均null；保留原泄漏monitor、受限结果精确null和canonical严格白名单。qm per-browser端口隔离与finally保持不变。
- 全部使用端口5199/8898/8899/15191/15192/18891/18892收口0listener、本树活node/nativepnpm/chrome/esbuild为0，浏览器窗口已交还。
- changed lint、全仓size/governance和diff检查通过；新增E2E文件为0，原SPEC_TAGS登记仍@student。后端/contract/生成物/harness五文件对45ccd树差异为空，复用既有已审证据，不重新生成或手改产物。

选择与未覆盖：脚本dry-run只是选择日志，不记通过。origin/main受影响单测因既有0054迁移选择full，origin/v2因既有0065迁移选择Chromium full；本轮修复增量HEAD45单测为changed，E2E因未映射learning-context源码仍选择full。按明确资源安排，本机只执行上述必要局部及新spec8例；完整full/双浏览器由同步后的CI承担。没有iPad真机/Pencil验收。本文件是实施者自查与证据交接，独立补审由主会话安排，不宣称二期/上线完成。
