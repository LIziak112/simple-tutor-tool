# OwnClass UI 审查（2026-11-07）

本次确认 **7 项可修复问题，另有 1 项需要产品选择的手机布局问题**，整理为 7 份实施计划。没有修改应用源码、测试、依赖或业务文档；新文件均在 `plans/`。用户原有工作区改动保持原样。

## 待决定事项

只有 [007 手机学情首屏](007-mobile-analytics.md) 标记 `REQUIRES-APPROVAL`：手机筛选是继续常显、压紧布局（A），还是默认收为摘要、按需展开（B，建议）。两条路线都保留所有筛选与 URL 状态。没有选择前不执行该计划。

`TOUCHES-DS` 与上述标记独立：[001 状态视觉单源](001-learning-status.md) 会建立共享状态视觉映射，属于设计系统源变化；它本身没有未决产品选择。

## 审查依据与限制

- 项目：当前工作树，分支 `codex/fix-scratch-toolbar-72`，HEAD `0732aefe1c54eb9000e833b57b61d22d2e97aa5f`。不是对 GitHub 最新 v2 的审查。
- 工作流：[unslop SKILL.md](https://github.com/0design/unslop-skill/blob/12a35cc5f003ec08dcb6dd828ed0d059904902cd/skills/audit/SKILL.md) 及其 `references/design-system-integrity.md`。
- 检测器：unslop `1.0.3`，仓库提交 `12a35cc5f003ec08dcb6dd828ed0d059904902cd`。
- **Canon 未验证**：当前会话没有连接的 `unslop` MCP，未读取 index，canon version/checksum 均为 `null`，也没有精确 checksum 的 detector bindings。用户已授权并成功配置 `codex mcp add unslop --url https://oleg.design/unslop/mcp`，待新会话补齐。没有使用本地 canon 文件冒充远程规则，也不给出 canon-based pass。
- 本文 `UI-01` 至 `UI-08` 是本次项目内的证据编号，**不是**远程 canon ID。除明确标出的检测器候选外，均为 `judgement`；不能据此宣称完成了 canon 全量规则覆盖。
- 仓库列出的 `writing-plans`、`code-review`、`verification-before-completion` 等专用工作流技能未在本会话提供。本次按问题重现、反证复核、需求到证据映射进行等效检查，不声称运行了这些技能。

## 需求与设计系统核对

| 要求 | 来源与状态 | 实际组件或源 | 本次核对结果 |
| --- | --- | --- | --- |
| 先输出问题和计划，不改代码 | 当前用户消息，accepted | `plans/` | 仅写报告、计划与审查证据；无应用源码 diff |
| OwnClass 品牌；教师靛蓝、学生蓝色 | `docs/约定/界面与账号.md`，inherited | `index.css` 的 `.teacher-theme` / `.student-theme`，`Brand` | 保留；不把靛蓝本身列为问题 |
| 触控目标至少 44px | `docs/页面功能清单.md`「通用约定」，inherited | Button 调用方 `min-h-11`、Input `h-11`、关联 label | 逐项选择框和部分入口未落实，见 UI-02；小输入框有足够大的关联 label 时不报错 |
| 设置暂存保存、后台重取不覆盖草稿 | `docs/约定/界面与账号.md`，inherited | 师生设置控制器、分类导航 | 本次计划不改变保存模型；未验证全部冲突及失败状态 |
| 保留作答、公布、原稿与保稿语义 | `docs/约定/学生作答与讲练.md`、`手写与同步.md`，inherited | 练习、讲练、结果页与共享作答组件 | 计划不修改数据载荷、判分、提交或手写坐标 |
| 表现展示使用真实题数，待批与待自评分开 | `docs/约定/学生作答与讲练.md`，inherited | `formatResultCounts`、单元落地页 | 保留全部结果口径，仅建议改变承载布局，见 UI-08 |
| 状态视觉一致；手机学情主要内容尽早出现 | 本次审查建议，proposed | 共享状态映射、学情筛选布局 | 前者由现存多数消费者的配色约定支持；后者保留 A/B 选择 |

技术与结构：React 19、React Router、TanStack Query、Tailwind v4；Radix/shadcn 的 Button、Input、Dialog、Sheet 均为仓库内组件；图标使用 Lucide。颜色与教师页面轴线在 `apps/web/src/index.css`；`StudentPageHeader` 等在 `features/student/student-ui.tsx`；数学正文通过 RichMarkdown/KaTeX 呈现。现有公共组件数量不大，主要问题是若干调用方绕过它们，不需要引入新 UI 库或重做整体视觉。

## 问题清单

| 编号 | 优先级 / 判断方式 | 问题、证据与影响 | 修复计划 |
| --- | --- | --- | --- |
| UI-01 | P1 / judgement | 五处自写模态没有完整焦点管理：导入新建文件夹、教师/管理端共享删除、学生单元重做、讲练重开。均实测 Tab 进入背景，Esc 后弹层仍存在；导入弹层打开后焦点还在触发按钮。破坏键盘和读屏的模态预期。 | [002 复用 Dialog](002-modal-dialogs.md) |
| UI-02 | P2 / judgement | 资源库逐项 checkbox 20×20px，`labels=[]`，外围没有扩大命中区域；学生列表姓名链接实测 48×24px；教师学生主页三档筛选实测 36px 高。与项目 44px 约定不符。 | [003 触控范围](003-touch-targets.md) |
| UI-03 | P2 / judgement | 学习记录“进行中”12px 白字配 `bg-sky-500`，实测对比度约 **2.71:1**；同样的颜色组合也在教师记录和完成矩阵出现。与作业卡的浅底深字风格不一致。琥珀半透明“已交卷”在该卡上约 4.48:1，属于临界值，随共享修复一起处理。 | [001 状态视觉单源](001-learning-status.md) |
| UI-04 | P2 / judgement | 同样的“已交卷 / 已批改”，学生作业卡为绿色 / 琥珀，记录列表、教师记录、矩阵及作业名单为琥珀 / 绿色；作业卡侧色条也反向。造成跨页颜色意义漂移。 | [001 状态视觉单源](001-learning-status.md) |
| UI-05 | P3 / judgement | 学生首页只有三组 h2，问候是 p，整个主区没有 h1。其他受测主要列表页有页面 h1；首页文档大纲缺少页面级标题。 | [004 首页标题](004-home-heading.md) |
| UI-06 | P3 / detector 候选 G-6，经人工限定 | 课程进度条 `transition-[width]` 在 `prefers-reduced-motion: reduce` 下仍是 `width / 0.15s`。实际问题是忽略减少动画偏好；没有把“使用 width”直接推断为已发生性能故障。 | [005 进度条动效](005-course-progress-motion.md) |
| UI-07 | P2 / judgement，需选择 | 390×844 下学情页头部导航多行排列、筛选常显，再接四张计数卡，“下节课重点”标题约位于 **y=885.5px**，首屏完全看不到。属于信息优先级取舍，不是功能缺失。 | [007 手机学情](007-mobile-analytics.md)，`REQUIRES-APPROVAL` |
| UI-08 | P2 / judgement | 单元落地页仍按三张窄数字卡承载已增长为完整句子的表现信息。“做对 4 / 5 题 · 待批 1 题”在手机上断成多行，随后又以可见整句重复三次。屏幕阅读负担增大；大字号下会更拥挤。 | [006 单元表现布局](006-unit-results-layout.md) |

原始检测器共输出 **831 条候选**，其中 151 条来自测试文件，其余仍含画布色值、DSL 样式、语义主题定义和模态阴影等合法情形。没有将候选总数当成实际问题数；未确认项不进入修复计划。

交互与可读性参照：[WAI 模态对话框模式](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)规定打开后的内部焦点、Tab 循环与 Esc 行为；[WCAG 2.2 对比度说明](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)给出普通文本 4.5:1 门槛，临界值不得四舍五入放行。44px 来自本项目约定，不把它误称为 WCAG 2.2 的统一最小尺寸。

## 执行顺序与状态

| 顺序 | 计划 | 范围 | 状态 | 执行提交 |
| --- | --- | --- | --- | --- |
| 1 | [001 状态视觉单源](001-learning-status.md) | 共享状态映射及真实消费者；`TOUCHES-DS` | 待实施 | — |
| 2 | [002 模态](002-modal-dialogs.md) | 现有 Dialog 的五组调用方 | 待实施 | — |
| 3 | [003 触控](003-touch-targets.md) | 资源库、学生入口、教师筛选 | 待实施 | — |
| 4 | [004 首页标题](004-home-heading.md) | 首页问候标题语义 | 待实施 | — |
| 5 | [005 进度条动效](005-course-progress-motion.md) | 共享课程卡 | 待实施 | — |
| 6 | [006 单元表现布局](006-unit-results-layout.md) | 单元落地页表现摘要 | 待实施 | — |
| 7 | [007 手机学情](007-mobile-analytics.md) | 学情导航与筛选；A/B 未定 | 等待产品选择 | — |

## 实际验证与覆盖边界

已实际运行：

1. `node <临时 unslop 克隆>/skills/audit/scripts/detect.mjs apps/web/src --json`：831 条候选；存在 red，未给出检测通过结论。
2. 在独立临时 DATA_DIR 启动服务（8899）与 Vite（5199），使用既有 demo seed 与临时讲练夹具；没有读取或修改本地开发数据库。浏览器使用已安装的 Edge/Chromium。
3. 主批次 **113 个页面×宽度状态**：教师 60、学生 53；1440×900、768×900、390×844。教师含资源库、课程、作业、学生及学生主页、作答记录、学情两视图、导出、共享、连接与各设置分类、管理三页；学生含首页、作业、课程与目录、错题本、记录、设置三页、作答、结果回看及讲义。详情页并非每个都覆盖三个宽度，完整清单见 `evidence/render-inventory.json`。
4. 另做 **12 个渲染状态**：讲练空题状态 6、含两题的讲练作答 3、课程单元落地 3。合计 **125 个渲染状态**。五组模态另外执行 Tab / Esc 探测；没有确认删除、作废或交卷。
5. 主批次 document scrollWidth 未超过视口，主批次没有 pageerror，受测可见 button 未发现缺少名称。这里仅指测量范围，不等于全项目无障碍通过。
6. 人工查看了代表性的师生首页、资源库、设置、学情、管理概览、记录、作答、讲练和单元落地截图；并非逐一人工验收全部 125 张截图。对比度只抽查指定学生页面，未做全站颜色认证。

明确未覆盖：真实 iPad/Pencil、WebKit 与原生系统缩放、真机键盘和软键盘、200% 字号实际渲染、所有题型、长课程目录、多语言、所有弹层、设置未保存/网络故障/离线/冲突/PWA 更新各状态、全部 AI 凭据与求助视图、真正屏幕阅读器。没有跑单测、E2E 套件、lint、typecheck 或 build：本次没有修改代码，125 个状态是审查探测，不能称为项目回归全绿。

四项结果分开记录：需求保真＝计划保留现有品牌、数据与作答契约；DS 消费＝找到五组模态绕过和状态映射分散；运行检查＝上述浏览器测量，非构建认证；视觉比较＝同项目当前界面间比较，没有外部定稿参考图，也不替代用户视觉验收。

后续实施按根 AGENTS.md：先为行为问题补失败测试，再修改实现，执行选测脚本实际决策；完整 diff 做简化、正确性审查。若实施期间触及学生载荷/答案，另做安全审查并补泄露测试。纯语义/样式调整的豁免写在对应计划中。合并与全量 CI 属于获准实施阶段。

## 审查证据

- [记录状态与对比度](evidence/records-phone.png)
- [资源库手机布局](evidence/library-phone.png)
- [讲练重开时焦点落入背景](evidence/lesson-modal-focus.png)
- [手机学情首屏](evidence/analytics-phone.png)
- [单元表现窄列](evidence/unit-phone.png)
- [学生首页](evidence/home-desktop.png)
- `evidence/browser-probes.json`、`extra-probes.json`、`final-probes.json`：焦点、motion、位置与文档大纲等原始测量。其中 `final-probes.json` 的 `questionCount=0` 来自探测器使用了不存在的 `[data-question-card]` 属性；同记录的可见文本实际含“第 1 题”“第 2 题”，不能据该计数判断无题。证据保留原始值并在此说明。
- `evidence/canon-status.json`：本轮工具版本与未验证状态。

没有把墨色、画布白底、DSL 的教学语义色、明确约定的彩色课程图标、教师靛蓝主题、正常浮层的阴影，或有完整大 label 的小 radio/checkbox 列为问题。它们不应被通用反模板规则机械清除。
