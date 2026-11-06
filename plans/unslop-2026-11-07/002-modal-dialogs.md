# 002 让五组模态使用已有 Dialog

状态：已实现并完成本地验收；CI及合并以对应PR为准；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。无 `REQUIRES-APPROVAL`；无 `TOUCHES-DS`，复用现有基座，不需要修改其 API。

对应 UI-01；P1；judgement；本轮 canon 已经 MCP 获取并校验。检测器版本 1.0.3 / `12a35cc5f003ec08dcb6dd828ed0d059904902cd`；本问题由运行时焦点轨迹验证，不用 E-3 阴影候选代替证据。

## 问题与范围

以下缩写的 `pages/` 路径均从 `apps/web/src/` 起算，`e2e/` 从仓库根起算。

五个调用方均手写 `className="fixed inset-0 z-50 ..."`：

| 文件与行 | 原代码片段 | 实测 |
| --- | --- | --- |
| `apps/web/src/pages/teacher/ImportPage.tsx:1098` | `role="dialog"` / `aria-modal="true"` | 打开不迁移焦点；Tab 越界；Esc 不关闭 |
| `pages/teacher/SharedPage.tsx:296` | `role="alertdialog"` | Tab 越界；Esc 不关闭 |
| `pages/admin/AdminSharedFilesPage.tsx:235` | `role="alertdialog"` | 同上 |
| `pages/student/StudentCourseUnitPage.tsx:95` | `role="dialog"` | Tab 先进入背景历史记录；Esc 不关闭 |
| `pages/student/StudentLessonLandingPage.tsx:74` | `role="dialog"` | Tab 越界；Esc 不关闭 |

现有 `apps/web/src/components/ui/dialog.tsx` 已有 Radix FocusScope、Esc、关闭按钮、`max-h-[88vh]`、内部滚动、减少动画处理。参考 `pages/teacher/StudentsPage.tsx` 的受控 `Dialog` 用法。

## 目标与实施步骤

1. 先在既有导入/共享、`e2e/lesson.spec.ts` 与 `student-course-practice.spec.ts` 相关范围补失败测试：打开后焦点位于弹窗内；循环 Tab/Shift+Tab 不到背景；Esc 执行取消；关闭后回到实际触发者。五种调用都覆盖，不能只验证一个公共 Dialog。
2. 五处改用 `Dialog`、`DialogContent`、`DialogTitle`、`DialogDescription`、`DialogFooter`。删除各自遮罩和焦点管理替代品，保留原表单值、错误显示、删除/重开文案与回调。
3. 新建文件夹使用 `DialogTrigger asChild` 对接原按钮，打开时定位名称输入。删除确认保留 `role="alertdialog"`，初始焦点放在“取消”。循环列表里的删除按钮如无法直接放入 Trigger，捕获真实触发按钮 ref，并在 `onCloseAutoFocus` 显式恢复，不能回到任意页面按钮。
4. 单元重做/讲练重开初始焦点放“先不做”；保留两者不同的“保留历史 / 作废旧卷”业务文案，不把两条 mutation 合并。为原触发按钮接上 Trigger 或明确的 ref 恢复。
5. 请求 pending 时仍阻止关闭：`closeDisabled`、受控 `onOpenChange` 守卫，必要时在 Esc/外点事件阻止关闭；禁用按钮保持原语义。未 pending 的取消和 Esc 不得调用确认 mutation。
6. 视觉使用现有基座的边框、背景、圆角和滚动规则；学生手机原底部形态可通过现有 className 覆盖位置保留，仍使用同一 Radix Content。不得为迁移重新实现 FocusScope。

## 验证与边界

需求→证据：五个弹窗各自完成打开、Tab 正反向、Esc、焦点归还、取消零 mutation、成功仅一次 mutation、错误保留输入、pending 不误关闭。390×844、844×390、768×900，及文字放大时确认按钮能滚到且不遮挡。

保留创建/删除/重开权限及作废语义；不改接口、题目公布、草稿或冻结行。普通 Dialog 基座、其他弹窗和 BatchImportPreview 的手动复制降级窗不在本计划；后者有专门的聚焦/Esc 处理，需另测，不能本次顺手迁移。相关专题若需要记录行为，只更新 `界面与账号.md` 与 `学生作答与讲练.md`。

## 2026-11-07 MCP 补审元信息

固定 canon `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`，source UNSLOP；取得与校验详情见 `evidence/canon/retrieval.json`。相关规则：`US-004`；规则强度/类别以 `CANON-REVIEW.md` 与原始主题 JSON 为准，判断方式均为 judgement。US-004 只指导共享源修复位置；键盘焦点的具体预期来自报告列出的 WAI 对话框模式，并不声称 canon 有一条不存在的键盘规则。

本地检测器实际 detectorVersion 为 `sha256:210d57f5901ed2b4f3316bbeea467b2f6bfe45f659e9ad1753067132a815cc88`；文中 1.0.3 是插件版本。当前 canon 全部为 judgement，未建立或伪造自动绑定。
