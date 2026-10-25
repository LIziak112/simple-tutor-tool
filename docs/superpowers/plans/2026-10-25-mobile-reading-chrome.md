# 手机练习与讲义阅读空间优化

用户已确认前一轮方案并授权实施、提交 PR；本次目标分支为 v2，不合并或部署。

## 文件与步骤

1. 新增 `features/student/use-reading-toolbar.ts` 及单测，复用滚动方向迟滞、用户滚动判定、交互锁定与焦点恢复；练习 `AttemptHeader`、纯讲义 `StudentLectureViewPage`、讲练 `StudentLessonPage` 接入。仅窄屏自动收起，桌面保留导航；动效不改变文档流及题面坐标。
2. 修改 `AttemptBottomBar`、`PracticeWorkspace`、`AttemptSession` 及对应测试：手机列表把进度合并到答题卡入口；单题在一行内组合题号入口与主动作，详细进度与提前交卷进入答题卡及更多菜单。保留错误提示、离线保护、提交锁定和真实入口焦点。
3. 历史版本提醒移到正文，标题手机单行；同步 AGENTS.md 和现有学生工作区 E2E，检查窄屏尺寸、上下滚动、菜单/目录、跳题、单题主动作与异常状态。

## 测试与质量闸门

- 先补失败测试，再实现；纯样式通过真实浏览器尺寸验证。
- 开发循环：test:quick、typecheck:affected、lint:changed。最终验证：test:affected、e2e:affected；全量构建及双浏览器回归交 PR CI。
- 对完整 diff 依次进行复用/简化审查、正确性审查；不改学生接口、答案投影、数据库、契约或判分，不增加依赖。
- 自动验证不能替代手机 Safari/Android 与 Pencil 真机手感；PR 明确列出人工步骤和未验证项。

## 交付

小步提交，推送独立 codex 分支，创建到 v2 的 PR 并附到当前聊天；记录真实检查输出。
