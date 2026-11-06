# 010 给“更多问法”补折叠指示

状态：已实现并完成本地验收；CI及合并以对应PR为准；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。无 `REQUIRES-APPROVAL`、无 `TOUCHES-DS`；复用 Lucide 与原生 details。

UI-11；P2；canon `J-12`（hard / slop / judgement，source UNSLOP）；版本 `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`。

## 问题

`apps/web/src/features/student-ai/AiCompanionSession.tsx:212`：

```tsx
<summary className="flex min-h-11 cursor-pointer items-center rounded-lg border border-border px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring">
  更多问法
</summary>
```

display:flex 使原生列表 marker 不呈现；没有 SVG 或伪元素。开合时 list-style 计算值变化，但没有可见指示。`more-presets-closed.png`、`more-presets-open.png` 显示两态都是同一无箭头按钮；完整 DOM 见 `canon-interaction-probes.json`。

## 目标与步骤

1. 读学生 AI 三份权威文档及界面约定；保持“选择问法只填草稿、最终发送才出站”语义。先用当前实现补失败测试：summary 有可见、aria-hidden 的折叠图标，键盘可切换，开合不新增求助任务。
2. details 增加 group；summary 增加 gap-1.5，内部保留“更多问法”span，尾部使用 Lucide `ChevronDown`、`size-4 shrink-0 group-open:rotate-180`。正常偏好旋转 150ms，reduce 无旋转动画；不要在同形箭头间 crossfade 或 morph。
3. 复用 `pages/student/StudentSettingsPage.tsx` summary 图标模式；继续 min-height44px，文字和图标同属于一个 summary，不能嵌套 button。
4. 不另建展开状态，保留原生 details.open 和按题草稿；不改变按钮数、快捷问法内容或任何 API。

## 验证

390/768/1440、键盘 Enter/Space、reduce；箭头与真实 open 同步，“更多问法”的完整命中区至少44×44，展开选项不遮住发送区。检查无网络外发、输入内容不丢，收起不清空草稿。此项没有答案/策略/载荷变化，不能顺手重写发送流程。
