# 006 让单元表现摘要适配完整题数文案

状态：已实现并完成本地验收；CI及合并以对应PR为准；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。无 `REQUIRES-APPROVAL`；无 `TOUCHES-DS`，先修本页真实布局，不提取只有一个消费者的通用指标库。

对应 UI-08；P2；judgement；本轮 canon 已经 MCP 获取并校验。检测器 1.0.3 / `12a35cc5f003ec08dcb6dd828ed0d059904902cd`；证据为实际单元落地页截图与源代码。

## 问题

`apps/web/src/pages/student/StudentCourseUnitPage.tsx:325`：

```tsx
<div aria-hidden className="grid grid-cols-3 gap-2">
```

336 行每个窄格渲染 `formatResultCounts(tile.value)`；349 行开始又把首次、最近、最佳三条完整结果渲染为可见文本。390px 下“做对 4 / 5 题 · 待批 1 题”在每格断成三行，随后整句重复。原三格为 aria-hidden，后文承担读屏信息，不能只删后文造成辅助技术信息丢失。

## 目标

保持 `firstResultCounts`、`latestResultCounts`、`bestResultCounts`、`summary.count` 和待批提示的服务端语义。窄屏用单列 `<dl>` 三行，640px 起三列：`grid grid-cols-1 gap-2 sm:grid-cols-3`。每组 dt 为“首次表现 / 最近表现 / 最佳表现”，dd 继续用 `formatResultCounts`，正文 14px、行高 20px，数字使用 tabular-nums；不把 N 题缩写为百分制得分。

手机每组使用 `flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-xl bg-muted/60 px-3 py-2.5`；dt `text-xs text-muted-foreground`，dd `m-0 text-sm font-semibold tabular-nums`。长结果允许整个 dd 换到下一行，不把数字和“题”裁掉。大屏可通过 `sm:flex-col sm:items-start` 排成三列，仍使用同一份有语义的 DOM。

## 实施步骤

1. 读 `docs/约定/学生作答与讲练.md` 的作答表现规则。先在 `StudentCourseUnitPage.test.tsx` 加首次/最近/最佳结果分别可访问且只渲染一次的断言；覆盖待批、待自评、未公布和没有已交卷轮次，不能只断言 class。
2. 将原 aria-hidden 三格替换为上述唯一 dl；移除后面重复的首次/最近/最佳 span。保留“已做 X 次”和全局待批提示，且不把待批与待自评合并。
3. 使用原 `formatResultCounts`，不新写字符串拼接或客户端反推题数。不改变布局/反馈节奏选择器、开始/重做动作、历史记录区及其权限。
4. 如专题要补充显示规则，在 `学生作答与讲练.md` 的表现展示段记录窄屏单列；不修改根 AGENTS.md。

## 验证

参照 `evidence/unit-phone.png`，在 390、768、1440 和 200% 字号下对比。用 4/5＋待批1、123/200＋待自评20、全零、结果待公布、无历史测试：标签对应准确、各结果只朗读一次、无断词裁切或页面横向溢出。首次/最近/最佳仍指向原有整轮，数值与接口保持一致，重做与继续入口位置可达。

本计划的 200%/长数字尚未在本次审查实测，必须在实施验收时执行。纯布局 CSS 可免单测，但删除重复 DOM 与语义迁移需要上述先失败测试。

## 2026-11-07 MCP 补审元信息

固定 canon `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`，source UNSLOP；取得与校验详情见 `evidence/canon/retrieval.json`。本项仍为项目附加检查，不强行编造远程 canon 对应规则；完整规则获取不会使已确认的项目问题失效。

本地检测器实际 detectorVersion 为 `sha256:210d57f5901ed2b4f3316bbeea467b2f6bfe45f659e9ad1753067132a815cc88`；文中 1.0.3 是插件版本。当前 canon 全部为 judgement，未建立或伪造自动绑定。
