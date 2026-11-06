# 011 普通登录名标签沿用界面正文字体

状态：本地验收通过，待CI及合并；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。无 `REQUIRES-APPROVAL`、无 `TOUCHES-DS`，消费既有 font-sans。

UI-12；P3（规则偏好，不是可用性故障）；canon `KR-19`（hard / slop / judgement，source UNSLOP）；版本 `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`。

## 问题与目标

`apps/web/src/pages/teacher/StudentsPage.tsx:314` 登录名说明使用 `font-mono`。浏览器的实际字体栈为 ui-monospace 等；这不是代码、终端命令或 diff。截图 `login-name-monospace.png`，DOM/CSS 见 `canon-ui-probes.json`。

同类非代码倒计时：`features/attempt/PendingReleaseBanner.tsx:117` 为 `font-mono text-2xl font-bold tabular-nums`。普通界面数字不需要整段切到代码字体。既有项目专题/验收明确要求进度与题量计数使用 tabular-nums；依 US-001 保留该已记录决定，不把 TY-1 机械用于删除它。

## 步骤与验证

1. 只移除上述两个非技术内容角色的 `font-mono`，继承 font-sans；字号、数字对齐特性、复制行为、标签文字与倒计时格式保持。
2. 不改 `<pre>`、`<code>`、DSL/Markdown 编辑器、MCP 配置、Token、可复制密码、文件路径诊断等技术内容。另有文件名使用 mono 的情况逐一判断其代码/路径角色，本计划不全局搜索替换。
3. 中文、拉丁登录名、长登录名和 00/11/59 倒计时截图对比；控件和卡片不增加溢出，数值不跳动。

纯字体样式移除可免新增单测，以真实 computed fontFamily、原截图和 390/1440 渲染复核。保留倒计时每秒更新和自动刷新，字体变更不成为改变公布口径的理由。此项是 canon 的项目风格建议，不应宣传为“等宽字体本身有安全/无障碍缺陷”。
