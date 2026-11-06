# 014 按压反馈与 canon 的固定缩放偏好

当前实施决定：用户已明确选择 **B**；原 A/B 比较保留为审查历史，以下等待选择的描述已被本决定替代。状态：本地验收通过，待CI及合并；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。
**REQUIRES-APPROVAL：这是风格取舍，先选 A 或 B。** 状态：等待产品选择；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。若选 B，`TOUCHES-DS`：Button 共享按压反馈。

UI-15；P3；canon `KR-10`（hard / slop / judgement，source UNSLOP），同时受 `US-001` 约束。版本 `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`。

## 现状与选择

`apps/web/src/components/ui/button.tsx:7` 是 `motion-safe:active:not-aria-[haspopup]:translate-y-px`。实测按下时 `translate: 0px 1px`、`scale: none`，存在反馈，不能称为“无反馈”。canon 偏好精确 scale(0.96)，但这不是 WCAG 或运行故障。

| 选项 | 结果 | 取舍 |
| --- | --- | --- |
| A：保留现有 1px 按压 | 不改 UI；把项目决定记录为 US-001 对 KR-10 的明确例外 | 保持既有手感；不满足该项通用视觉偏好 |
| B：普通按钮改为 0.96 | 正常偏好时以 scale(0.96) 代替 translate-y-px，100ms ease-out，释放时返回1 | 符合 canon 偏好；长按钮和图标按钮的视觉变化更大，须看实物效果 |

## 选 B 后的步骤与验证

1. 先测普通 Button 在 pointerdown/up、键盘 Space、disabled、reduce 下的反馈；补失败浏览器样式检查。不通过改变事件回调实现视觉缩放。
2. 只改共享 Button 的普通按压规则，保留 focus、disabled 和 aria-haspopup 的现有例外；reduce 无位移/缩放，仅保留静态颜色反馈。画布、题面、冻结原稿、输入控件与拖拽把手不套用缩放。
3. 检查 44px 图标按钮是否仍有稳定热区；必要时由不缩放的外层保留命中框，视觉子内容缩放，不把几何命中范围压到44px以下。
4. 比较长主按钮、题卡工具、确认/取消、菜单触发、保存按钮；不会移动笔迹坐标或页面布局。记录选定决定到 `界面与账号.md`。

没有选择前不执行。不能为了给 canon 打勾而给所有 DOM button、手写区域和第三方编辑器全局增加 transform。
