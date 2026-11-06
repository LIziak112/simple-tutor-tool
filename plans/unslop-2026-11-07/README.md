# OwnClass UI 审查与 MCP 规则补审（2026-11-07）

> 审查历史快照（基线0732aefe）。用户随后已授权修复14项问题，两项取舍均选B；当前实现、验收及提交状态见[实施记录](IMPLEMENTATION.md)。下文“没有改代码/未实施/等待选择”等描述仅保留审查当时的事实，不能覆盖后续明确授权。

**已通过 MCP 获取并校验完整适用规则，56 条均有逐项复核记录。** 当前确认 **14 项修复问题、2 项产品/风格取舍**，共 **15 份计划**。这是存在问题及明确覆盖边界的审查结果，不是“全站通过”。没有改应用源码、测试、依赖、数据库结构或业务文档；本轮仅更新 `plans/` 下的报告、计划、审查脚本与证据。

## 两项待决定事项

- [007 手机学情](007-mobile-analytics.md)：A 保持筛选常显并压紧，或 B 摘要＋按需展开（建议）。
- [014 按压手感](014-press-feedback-choice.md)：A 保留现有 1px 按压并记录项目例外，或 B 采用 canon 偏好的 0.96 缩放。现有按钮已经有反馈，不把这项风格差异当作“无反馈”缺陷。

两者标记 `REQUIRES-APPROVAL`；没有决定前不实施。`TOUCHES-DS` 独立记录共享源修改，不因此额外要求重复批准。其余计划也均**未执行**，本次没有取得修改应用代码的授权。

## MCP 获取、固定与校验

| 项目 | 实际结果 |
| --- | --- |
| 传输 | MCP Streamable HTTP，`https://oleg.design/unslop/mcp` |
| 客户端 | 项目已有官方 MCP SDK；当前工具注册表未挂载 unslop，故用 SDK 直连同一已授权服务。未安装依赖 |
| 固定版本 | `public-2026.11.06-1`，publishedAt `2026-11-06T00:00:00Z` |
| 索引 SHA-256 | `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f` |
| 路由 | 本地扫描 5215 个项目文件，依服务器索引 globs 选择主题，并加入 always 的 process；不向服务器上传源码 |
| 适用主题 | copy 9 条、interface 37 条、process 10 条，合计 **56 条**；未请求主题为空 |
| 完整性 | 接收 **62,724 bytes / 完整 canon 62,724 bytes**；索引和三个主题均验证 schema、版本、SHA-256、精确字节数、规则 ID 集合/标题、mode/strength/class/source/license |
| 独立复核 | Python hashlib 对同一规范化 payload 另算 SHA-256，四个摘要一致；篡改一个 statement 后校验拒绝 |
| 固定原则 | latest 索引读取一次，主题全部用上述显式版本；没有本地 canon 回退、没有混用旧规则 |
| 判断方式 | 本版 56 条**全部是 judgement**。本轮逐条人工评估；没有把旧检测器的同名 ID 当成远程规则绑定，机器认证规则数为 0 |

主题校验和：copy=`eec7da27ed58b98e34c2b6c975091e99637d303d751d80d37bc904c9f7be0d5a`；interface=`602ce866c9eb622cd5c559ad77c2ce512b63154c82d917509062a7e7faf0eb76`；process=`157b327696a694fe1b7d7b4c2be5893f70cfe0a41fa9e9c36b9fb719cc9198a9`。

原始 MCP 内容在 [索引](evidence/canon/index.json.txt)、[interface](evidence/canon/interface.json)、[copy](evidence/canon/copy.json)、[process](evidence/canon/process.json)；[获取清单](evidence/canon/retrieval.json)、[独立完整性验证](evidence/canon/independent-integrity.json)、[当前状态](evidence/canon-status.json) 可复核。checksum 证明数据完整性，不等于独立认证发布者身份。

首次 SDK 连接未使用环境代理而 fetch failed；启用现有 `NODE_USE_ENV_PROXY=1` 后 MCP 全部读取成功。`canon-retrieval-failure.json` 仅保留首次失败历史，不代表当前状态。没有以 health 接口或 README 代替规则获取。

### 本次继续补审的再核验

2026-11-07 02:45（北京时间），再次通过 MCP `initialize` / `resources/read` 读取**已固定版本**的索引及 copy、interface、process 三个主题，没有再次解析 latest。四份远程资源与保存快照逐字一致，仍为 62,724 bytes；原版 schema/版本/校验和/精确字节数检查通过，另用 Node crypto 独立计算规范化 payload 的 SHA-256，四项一致。56 个远程规则 ID 与台账一一对应，逐项比对标题、主题、mode、strength、class、source、版本和主题校验和；没有遗漏、重复或额外台账项。篡改 statement 后验证器拒绝。实际结果见 [远程再核验](evidence/canon/remote-revalidation.json)，可复跑脚本为 [revalidate-remote-canon.mjs](evidence/revalidate-remote-canon.mjs)。

新增脚本首次将带缩进的资源序列化误当作校验和的规范化输入而断言失败；依据原版校验算法改为按键排序的紧凑 payload JSON 后复跑成功。该次失败来自复核脚本的输入格式，不是远程内容变化；没有修改规则或放宽校验。

本次还重新核对了五组自制模态、状态映射、进度动效、共享弹层、普通字体及 AI 图标的当前源码位置，复看关键截图。15 份计划均未执行，报告相对链接无缺失，`git diff HEAD -- apps/web/src apps/server/src packages` 为空，见 [审查产物再核验](evidence/audit-revalidation.json)。既有125个渲染状态和浏览器测量沿用原证据，本次未把它们伪称全部重跑。当前工具注册表仍未挂载 unslop；本轮的成功获取是已有官方 SDK 直接执行 MCP 协议的结果，不等于桌面客户端已经原生挂载该服务器。

## 逐条规则复核与项目约定

完整 56 行评估见 [CANON-REVIEW.md](CANON-REVIEW.md)，机器可读版为 [canon-rule-review.json](evidence/canon-rule-review.json)。每条保留 ID、mode、strength、class、source、版本、索引/主题校验和、适用判断与证据。

规则分类包含 slop、bad-tone、instruction；**hard/soft 是该规则原有强度，不等于本项目缺陷的严重程度**。例如 KR-10 的精确缩放偏好属于待选择风格，不能与模态焦点失效混为同一严重程度。

需求及来源：

| 要求 / 决策 | 来源与状态 | 补审处理 |
| --- | --- | --- |
| 获取规则、补审、更新计划，不改代码 | 当前用户请求，accepted | 只写 plans；应用代码无 diff |
| OwnClass 品牌及广告词、教师靛蓝 / 学生蓝 | AGENTS.md、界面与账号专题，inherited | 保留，不机械执行其他 skill 的颜色禁用表 |
| 学生彩色类型图标、卡片、练习状态层级 | `docs/约定/界面与账号.md`「嵌套课程目录与密度」，inherited | 属真实类型语义，不按 DEC-8 的营销三格模板误报 |
| 题量、结果、填写计数使用 tabular-nums | 已落地的学生记录/结果回看/桌面布局计划及验收，inherited | 依 US-001 保留，不能因 TY-1 反向清理已定稿计数 |
| AI 助教、AI 复盘名称与三个呈现方式 | AI 需求规格 §7.1 及专题，inherited | 仅提出用途图标，保留词表、布局、唯一活动输入与出站守卫 |
| 44px 热区、暂存保存、保稿、公布及隔离 | 页面功能清单、界面/学生作答/手写专题，inherited | 热区按真实 label 核查；计划不改变业务数据或手写坐标 |
| 手动去框、用途图标、0.96 按压 | 本轮 canon + 审查判断，proposed | 不把建议写成已批准的产品决定；0.96 单独列 A/B |

项目仍为 React 19 / Router / Query / Tailwind v4，Radix/shadcn 的 Button、Input、Dialog、Sheet 为仓库内基座，Lucide 为界面图标集；主题与页面轴线在 `apps/web/src/index.css`。本轮不引入新组件库、字体、网络资源或视觉模板。

## 问题与修复计划

本地 UI 编号用于去重和追踪，不伪装成 canon ID。一个问题簇可关联多条规则，但只计一项。

| 编号 | 优先级 | 问题与确认依据 | 对应规则 / 计划 |
| --- | --- | --- | --- |
| UI-01 | P1 | 导入新建文件夹、教师/管理共享删除、单元重做、讲练重开五组模态，Tab 可进入背景、Esc 不关闭。 | 共享源 US-004；具体键盘预期来自 WAI；[002](002-modal-dialogs.md) |
| UI-02 | P2 | 资源库逐项 checkbox 20×20、无关联 label；姓名入口24px、部分筛选36px。新增 coarse pointer 场景仍重现。 | KR-3 / 项目44px约定；[003](003-touch-targets.md) |
| UI-03 | P2 | “进行中”12px 白字约2.71:1；浅琥珀次级状态文字约4.48:1。 | DEC-6 与 WCAG 对比度；[001](001-learning-status.md) |
| UI-04 | P2 | 作业卡与记录/矩阵的“已交卷 / 已批改”颜色互换，侧色条也反向。 | US-004；[001](001-learning-status.md) |
| UI-05 | P3 | 学生首页只有 h2、没有页面 h1。 | 项目附加语义检查，不捏造 canon ID；[004](004-home-heading.md) |
| UI-06 | P3 | reduce 下课程进度仍为 width / 0.15s。 | 项目动态效果约定 / 本地检测候选，不假冒已绑定 canon；[005](005-course-progress-motion.md) |
| UI-07 | P2·取舍 | 手机学情“下节课重点”约 y=885.5，首屏之外。 | 信息层次判断；[007](007-mobile-analytics.md)，REQUIRES-APPROVAL |
| UI-08 | P2 | 单元三列表现承载长句，手机多行挤压且下方重复。 | 项目表现口径 / 布局检查；[006](006-unit-results-layout.md) |
| UI-09 | P2·新增 | 保存 pending 只插入 Loader，就使宽度98→120px、左移22px。 | ST-4；[008](008-stable-busy-buttons.md) |
| UI-10 | P2·新增 | 抽屉打开中关闭，22.4ms内从−306px跳到−2px再退出；reduce 菜单仍200ms缩放。 | KR-13、项目减少动态效果约定；[009](009-interruptible-overlays.md) |
| UI-11 | P2·新增 | “更多问法”summary display:flex、无可见marker/图标，开合状态无视觉指示。 | J-12；[010](010-more-presets-disclosure.md) |
| UI-12 | P3·新增 | 普通登录名标签、非代码倒计时使用font-mono。 | KR-19；[011](011-ordinary-text-font.md) |
| UI-13 | P3·新增 | 交卷标题及锁定提示使用庆祝/锁emoji作界面图标，三处真实位置。 | ST-11；[012](012-status-icons.md) |
| UI-14 | P3·新增 | 提问、批量复盘、报告、出题、导出共用Sparkles泛指AI，没有提示实际用途。 | ST-2；[013](013-action-icons-for-ai.md) |
| UI-15 | P3·取舍 | Button 现有按压为1px平移，区别于canon固定0.96缩放；它已有反馈，不是失效。 | KR-10 / US-001；[014](014-press-feedback-choice.md)，REQUIRES-APPROVAL |
| UI-16 | P3·新增 | 待公布摘要外容器内有10个带框div；去框对照后标题、网格与间距仍能表达分组。 | DEC-1/2/3/4，同一簇只计一次；[015](015-pending-summary-frames.md) |

[WAI 模态模式](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)与 [WCAG 对比度说明](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)是附加依据。44px 是本项目和 KR-3 的触屏要求，不误称所有桌面控件的通用 WCAG 门槛。

## 建议执行顺序

先修 P1 模态：002 复用已有 Dialog，没有等待其他共享改动的前置依赖。随后在各问题簇中先修共享源，再修调用方。所有计划未执行、提交戳均为“—”。

| 顺序 | 计划 | 标记 / 前置关系 |
| --- | --- | --- |
| 1 | [002 模态焦点](002-modal-dialogs.md) | P1；五组调用方，复用已有 Dialog |
| 2 | [001 状态视觉](001-learning-status.md) | TOUCHES-DS |
| 3 | [003 触控范围](003-touch-targets.md) | 三类入口与同类调用 |
| 4 | [008 忙碌按钮](008-stable-busy-buttons.md) | TOUCHES-DS |
| 5 | [009 可中断弹层](009-interruptible-overlays.md) | TOUCHES-DS；保留 Radix 生命周期 |
| 6 | [010 问法折叠指示](010-more-presets-disclosure.md) | AI呈现，不发送 |
| 7 | [006 单元表现](006-unit-results-layout.md) | 保留服务端口径 |
| 8 | [013 AI用途图标](013-action-icons-for-ai.md) | TOUCHES-DS，保留名称和行为 |
| 9 | [004 首页标题](004-home-heading.md) | 语义小修 |
| 10 | [005 课程动效](005-course-progress-motion.md) | 静态呈现小修 |
| 11 | [011 普通字体](011-ordinary-text-font.md) | 不删除已约定的等宽数字 |
| 12 | [012 状态图标](012-status-icons.md) | 与015、011协调同文件 |
| 13 | [015 去重复框线](015-pending-summary-frames.md) | 合并011/012后验收 |
| 14 | [007 手机学情](007-mobile-analytics.md) | 等待A/B选择 |
| 15 | [014 按压反馈](014-press-feedback-choice.md) | 等待A/B选择；选B才改DS |

每份计划已列文件、现状原文、目标、步骤、范围和验证。不执行任何源码阶段；后续获准实施仍按根 AGENTS.md 先失败测试、选测、完整diff审查与合并闸门。仅样式/图标的豁免理由在计划内说明。

## 实际验证、反证与限制

继承初审125个页面×宽度状态与五组模态证据：主批次113（教师60、学生53），另12个讲练/单元状态。完整清单 [render-inventory.json](evidence/render-inventory.json)；初审历史报告保留于 [INITIAL-REVIEW.md](INITIAL-REVIEW.md)。详情页并非全部在三个宽度都访问过，不能把125理解为125个独立页面。

本轮新增实际验证：

1. MCP `initialize`＋`resources/read` 获取一次latest索引及三个固定版本主题；官方skill校验器和独立hashlib验证，另做篡改负向检查。
2. 保存请求保持pending的页面拦截，测量98→120px并截图；未写真实设置。
3. 同一抽屉在打开50–100ms后Esc、连续帧坐标；另测reduce下菜单动画与实际scale。
4. “更多问法”开/合两态：核查display、伪元素、SVG和实际截图；核查AI入口实际DOM，展开本身不点击发送。
5. 触屏上下文：四个学生页面、coarse pointer资源库勾选框；记录页双倍根字号，无整页横向溢出。CSS双倍字号不等于原生200%浏览器缩放。
6. 教师出题面板、导出内容第二步、学生AI设置折叠、未公布结果分支；在同一未公布呈现上做只在DOM生效的去框对照，未写源码。

`probe-canon-ui.mjs` 最初菜单探测的模糊role查询选中了可排序行，导致该条probeError；已在 `probe-canon-interactions.mjs` 用精确原生button定位重测成功。它是审查脚本选错目标，不是产品菜单失效。保留原错误并明确更正，不将其计入问题。

未公布截图使用已交卷演示响应的页面拦截，仅修改呈现字段，不是服务端真实未公布投影，也未验证其载荷安全。所有这些截图只能证明UI状态，不能宣称公布权限/泄露回归通过。实施012/015时须真实未公布服务端夹具复验。

仍未验证：真实iPad/Pencil、WebKit、原生系统缩放/软键盘、所有题型与长内容、全部离线/冲突/PWA/设置失败/AI连接状态。品牌帽子图形的最终批准链未独立确认（ST-13）；stage与真实生产站未逐屏比较（XP-34）。这些在56条台账中记为unknown/not-verified，而非通过。

四个结果分别记录：需求保真＝保留项目契约，只有计划；DS消费＝找到并定位共享源绕过和视觉映射问题；运行检查＝上列浏览器探测，不是项目测试套件；视觉比较＝关键状态截图与去框对照，不等于用户对候选修订的视觉验收。US-003要求的候选修订独立审阅在实施后执行，本次没有候选源码修订。

没有运行单测、E2E套件、lint、typecheck或build，因为没有应用代码变更；不声称项目回归全绿。原本831条本地检测器候选不是831个问题，也不是本版56条规则的自动执行结果。插件版本1.0.3；实际detectorVersion为 `sha256:210d57f5901ed2b4f3316bbeea467b2f6bfe45f659e9ad1753067132a815cc88`，精确绑定缺失且本版全为judgement，不伪造机器覆盖。

## 证据入口

- 规则与校验：[完整获取清单](evidence/canon/retrieval.json)、[独立摘要](evidence/canon/independent-integrity.json)、[56条复核](CANON-REVIEW.md)。
- 保存前后：[闲置](evidence/save-idle.png)、[pending](evidence/save-pending.png)。
- 动画：[打开途中](evidence/drawer-opening.png)、[关闭首段](evidence/drawer-closing.png)、[精确帧测量与减少动画菜单](evidence/canon-interaction-probes.json)。
- 问法：[收起](evidence/more-presets-closed.png)、[展开](evidence/more-presets-open.png)。
- 待公布：[原状态](evidence/nested-frames-before.png)、[临时去框预览](evidence/nested-frames-preview.png)。预览不是已修复页面。
- 字体：[登录名](evidence/login-name-monospace.png)；其余关键截图：[记录](evidence/records-phone.png)、[资源库](evidence/library-phone.png)、[单元表现](evidence/unit-phone.png)、[学情首屏](evidence/analytics-phone.png)。

所有source/license/credits原样保留于MCP主题文件；没有修改远程规则、没有把本项目判断写回canon。

原始索引以 `evidence/canon/index.json.txt` 保存精确响应字节，避免JSON格式化器改变字节数；主题文件仍保持原始格式。

规则文本署名：**UNSLOP by [Oleg.Design](https://oleg.design)**，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)；保存的规则文本未修改，项目判断与修复方案单独记录。各规则的原始署名、许可与第三方credit仍保留在主题JSON中。
