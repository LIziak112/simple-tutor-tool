# 015 简化待公布摘要中的重复框线

状态：已实现并完成本地验收；CI及合并以对应PR为准；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。无 `REQUIRES-APPROVAL`、无 `TOUCHES-DS`；仅收敛一个明确的重复框线簇，不重做全站卡片。

UI-16；P3；canon `DEC-1`、`DEC-2`、`DEC-3`、`DEC-4`（hard / slop / judgement，source UNSLOP），保留现有提交状态视觉。版本 `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`。

## 问题与手动反证

`apps/web/src/features/attempt/PendingReleaseBanner.tsx:65` 倒计时块使用 `rounded-xl border ... bg-background/80 ... shadow-xs backdrop-blur-xs`，内部四个数字格再次 `rounded-lg border ... bg-muted/40`（115行）；131行起四个只读凭证格又各自带框和背景。它们不代表独立交互或独立对象。

`canon-layout-probes.json` 记录 outer 里面 **10 个带框 div**，含提示区。按 DEC-2 在浏览器临时移除内层边框颜色、背景、阴影和模糊后，倒计时标签、四个凭证字段和说明仍由原来的标题、grid 与间距区分，且没有丢失任何内容。对照为 `nested-frames-before.png` / `nested-frames-preview.png`。这是临时 DOM 视觉实验，不是已实施修复。

## 目标与步骤

1. 仅处理倒计时容器、四个数字格、四个凭证格；保留最外层“已交卷待公布”状态容器与状态色。提示说明的语义/文字保留，不将其删除或折叠。
2. 上述九个内层 div 移除 border、独立背景、shadow/backdrop-blur 类；保留原布局 padding/gap、标题、数值、日期与刷新入口。移除边框时用等量 padding 补足原1px占位，保持基线几何，避免借去框引入整体跳动。
3. 数字格维持四列、凭证维持手机两列/桌面四列。不要把边框换成 ring、伪元素、另一层 tint 或新 token。
4. 与012共改此文件时先合并两份计划的 diff，防止覆盖 emoji 修正；与011的字体调整也须保留，避免重复返工。

## 验证与边界

未公布且有倒计时、dueAt缺失、到期重试、长交卷时间、保存状态说明；390/768/1440、200%文字。各字段的分组仍清楚、按钮焦点可见；倒计时准确，答案公布 gate 不变。原截图来自页面呈现夹具，实施时需真实未公布服务端夹具补验证，不据模拟截图宣称数据安全通过。

纯样式可免新增单测，现有倒计时/公布回归保持。其他静态卡片、课程类型图标、输入边框、选择框、焦点圈及真正浮层阴影不在范围。
