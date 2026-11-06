# 007 改善手机学情页的信息优先级

当前实施决定：用户已明确选择 **B**；原 A/B 比较保留为审查历史，以下等待选择的描述已被本决定替代。状态：本地验收通过，待CI及合并；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。
**REQUIRES-APPROVAL：先选 A 或 B，再实施。** 状态：等待产品选择；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。无 `TOUCHES-DS`，仅调整页面与现有筛选组件的消费方式。

对应 UI-07；P2；judgement；本轮 canon 已经 MCP 获取并校验。检测器 1.0.3 / `12a35cc5f003ec08dcb6dd828ed0d059904902cd`。这是产品布局建议，不是检测器硬错误。

## 需选择的路线

| 路线 | 具体表现 | 取舍 |
| --- | --- | --- |
| A：筛选继续常显 | 手机将时间范围四个按钮改为有 label 的 44px select；课程与重点周期各自一行；两个视图组独立标注，保持全展开 | 所有筛选持续可见，改变筛选最直接；重点内容仍需滚动，改善较有限 |
| B：摘要＋按需展开（建议） | 手机默认一行摘要“最近30天 · 全部课程 · 重点14天”，44px“筛选”按钮展开现有 Sheet；桌面保持常显 | 更快看到计数与下节课重点；编辑筛选增加一次打开动作 |

无选择时不实施，不自行把建议视为用户批准。

## 问题与已有约定

`apps/web/src/pages/teacher/InsightsOverviewPage.tsx:96` 起，页头、`StatsViewSwitcher`、`InsightsViewSwitcher` 和导出动作使用同一行可换行按钮；`features/insights/analytics-filters.tsx` 的 `AnalyticsFilterBar` 同时常显时间快捷项和两个 select。

原代码：`<div className="flex flex-wrap items-center gap-2">`，以及筛选条 `<div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-3">`。

390×844 下页头底部 y≈268.5，“下节课重点”标题 y≈885.5；手机首屏只看到导航、筛选和四个计数。总览与题目视角已有 URL 驱动筛选，时间范围 days 与重点周期 focusDays 相互独立，必须保留。不能通过删除指标或改统计口径压高度。

## 文件与实施步骤

以下页面文件均位于 `apps/web/src/pages/teacher/`，`features/`、`components/` 均从 `apps/web/src/` 起算。

涉及 `InsightsOverviewPage.tsx`、`InsightsQuestionsPage.tsx`、`StatsViewSwitcher.tsx`、`features/insights/analytics-filters.tsx`；复用 `components/ui/sheet.tsx` 与现有 Button。

1. 确认路线后，先补所选交互的失败测试，扩展 `analytics-filters.test.ts`、相关页面测试和 `e2e/insights-pages.spec.ts`。用非默认 days/courseId/focusDays 检验刷新、返回、视图切换值不丢。
2. 两级视图在手机区分为“数据视图”和“学情视图”两个有名称的组；维持全部入口和 44px 热区，次级视图用已有 `secondary`/`outline`，避免多个同等实心选中项难辨层级。桌面标题与内容轴线不改。
3. A：只在 <640px 将时间快捷项换成 select，选项仍来自 `ANALYTICS_DAYS_QUICK`，onPatch 与 URL 序列化不变；两组 select 可分行，禁止截断当前课程名。
4. B：<640px 渲染现有状态推导的摘要按钮，使用受控 Sheet 包裹同一套筛选控件；筛选即时写原 URL，不新增另一份草稿/保存模型。已选课程名过长时摘要可两行，实际按钮 min-height44px。提供“完成”关闭和原“清除筛选”，关闭回焦到实际按钮。≥640px 保留当前常显控件，不同时挂两套重复 id 的表单。
5. 页头说明可收为“查看完成情况与薄弱点”，完整统计窗口/矩阵不受时间范围影响的说明继续可见。不得删除显示统计口径的必要说明。
6. 在 `docs/约定/界面与账号.md` 记录已选择的手机策略，不把 A/B 两条都当作已实现行为。

## 验证与边界

在同一演示数据上比较 390×844、768×900、1440×900；B 的目标是让“下节课重点”标题在默认手机视图 y≤760px，且能看见第一条内容开头；A 不承诺该目标，验收以所有筛选清晰可达为准。报告实测坐标，不用构建通过替代视觉验收。

验证长课程名、无课程、筛选无结果、加载失败、键盘 Tab/Esc、背景点击与焦点恢复、统计窗口提示、总览↔题目视角状态传递。保持服务端统计、数据列表、矩阵局部横滚、导出路径、权限与作答详情链接。该计划不涉及学生页面、AI 出站内容或后台接口；没有产品选择前不执行。

## 2026-11-07 MCP 补审元信息

固定 canon `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`，source UNSLOP；取得与校验详情见 `evidence/canon/retrieval.json`。相关规则：`DEC-1`；规则强度/类别以 `CANON-REVIEW.md` 与原始主题 JSON 为准，判断方式均为 judgement。DEC-1 仅支持信息层次的审视，手机布局 A/B 仍是产品取舍，不能当作硬性 canon 判错。

本地检测器实际 detectorVersion 为 `sha256:210d57f5901ed2b4f3316bbeea467b2f6bfe45f659e9ad1753067132a815cc88`；文中 1.0.3 是插件版本。当前 canon 全部为 judgement，未建立或伪造自动绑定。
