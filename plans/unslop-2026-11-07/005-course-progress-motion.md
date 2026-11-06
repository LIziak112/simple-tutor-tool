# 005 取消课程卡被动进度刷新动画

状态：本地验收通过，待CI及合并；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。无 `REQUIRES-APPROVAL`；无 `TOUCHES-DS`。

对应 UI-06；P3；本地 detector G-6 候选＋judgement；本轮 canon 已经 MCP 获取并校验。检测器 1.0.3 / `12a35cc5f003ec08dcb6dd828ed0d059904902cd`。

## 问题与目标

`apps/web/src/features/student/student-ui.tsx:408`：

```tsx
className="h-full rounded-full bg-primary transition-[width]"
```

StudentCourseCard 在普通偏好与 `prefers-reduced-motion: reduce` 下均实际计算为 `transition-property: width`、`transition-duration: 0.15s`。不把检测器的 width 警告夸大为已测出的卡顿；本计划解决减少动画偏好未生效。

课程完成进度是服务端数据被动刷新，不需要进场动画。目标为 `className="h-full rounded-full bg-primary"`，原 `style={{ width: ... }}` 与 progressbar 的 aria 值保持。已有 `features/attempt/AttemptBottomBar.tsx` 使用 motion-safe 是其他场景的参考，不属于此次修改范围。

## 步骤与验证

1. 记录受测课程在 0%、部分完成、100% 下的原 width、aria-valuenow 和视觉长度。
2. 只移除这个 transition 类，不改进度计算、组件生命周期或渲染时机。
3. 在浏览器分别模拟 reduce / no-preference，并触发课程数据更新，确认该子节点计算的 transition duration 为 0s，宽度与 aria 值仍准确。首页和课程列表都是真实消费者，两个入口都看。

纯样式移除可豁免新增单测，原因是没有新增状态或业务逻辑；以实际 computed style 和两种偏好的渲染验证为准。不修改作答进度条、全站动画、手写或滚动控制，也不宣称已测量性能提升。

## 2026-11-07 MCP 补审元信息

固定 canon `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`，source UNSLOP；取得与校验详情见 `evidence/canon/retrieval.json`。本项仍为项目附加检查，不强行编造远程 canon 对应规则；完整规则获取不会使已确认的项目问题失效。

本地检测器实际 detectorVersion 为 `sha256:210d57f5901ed2b4f3316bbeea467b2f6bfe45f659e9ad1753067132a815cc88`；文中 1.0.3 是插件版本。当前 canon 全部为 judgement，未建立或伪造自动绑定。
