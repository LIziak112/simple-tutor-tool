# 001 统一学习状态的颜色意义与可读性

状态：已实现并完成本地验收；CI及合并以对应PR为准；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。`TOUCHES-DS`：新增共享状态视觉映射并迁移实际消费者。无 `REQUIRES-APPROVAL`。

对应 UI-03、UI-04；P2；judgement。本轮 canon 已经 MCP 获取并校验；规则与本地发现的对应关系见下方补审元信息。检测器版本为 1.0.3 / `12a35cc5f003ec08dcb6dd828ed0d059904902cd`，这两项来自源码比较与浏览器颜色测量。

## 问题与证据

以下缩写的 `features/` 路径均从 `apps/web/src/` 起算，`e2e/` 从仓库根起算。

- `apps/web/src/features/student/records-views.tsx:37`、`features/teacher-attempts/attempt-views.tsx:38`、`features/insights/InsightsMatrix.tsx:25`：`"bg-sky-500 font-medium text-white"`。12px 文本实测约 2.71:1。
- `features/student/student-ui.tsx:37` 的 submitted 使用 `"bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"`；graded 使用琥珀，`STATUS_ACCENT`（117 行起）同样反向。
- 记录、矩阵和 `features/assignments/AssignmentEditDialog.tsx:57` 的约定为“进行中蓝、已交卷琥珀、已批改绿”。采用已有多数消费者的意义，保持状态文案及契约不变。

## 目标与文件

新增 `apps/web/src/components/learning-status.ts`，仅导出使用既有 contract `AssignmentStatus` 的视觉映射，不另造业务状态类型：

| 状态 | 浅色 class | 暗色延续值 |
| --- | --- | --- |
| not_started | `bg-muted text-muted-foreground` | 继承语义 token |
| in_progress | `bg-sky-100 text-sky-800` | `dark:bg-sky-500/20 dark:text-sky-300` |
| submitted | `bg-amber-100 text-amber-800` | `dark:bg-amber-500/15 dark:text-amber-300` |
| graded | `bg-emerald-100 text-emerald-800` | `dark:bg-emerald-500/15 dark:text-emerald-300` |

共享侧色条映射沿既有强度：not_started primary、in_progress sky-500、submitted amber-400、graded emerald-400。这里只统一同一状态的意义，不统一所有提示色或题目对错色。

消费者：上述五个文件。AttemptStatus 的 draft 显式映射 in_progress；AnalyticsCellStatus 的 not-assigned 保留破折号，not-started 映射 not_started，in-progress 映射 in_progress。不要修改契约枚举。

## 实施步骤

1. 阅读 `docs/约定/界面与账号.md`、`学生作答与讲练.md`。在隔离数据库分别准备未开始、进行中、已交卷待批、已批改四态；记录当前截图与实际 CSS 颜色。先加入会在当前实现失败的浏览器对比度/跨页状态色一致性断言，不写只比较 class 字符串的镜像测试。
2. 建立上述一个共享映射。迁移五个真实消费者及学生作业侧条；保留各处字号、外形、路由和真实中文状态名。不可仅新增映射而让页面继续使用旧常量。
3. 在 `docs/约定/界面与账号.md` 记录颜色语义来源；不改根 AGENTS.md。
4. 执行仓库选测命令，审查完整 diff。该变更没有 API、schema 或结果口径改动，不需要生成 schema。

## 验证与边界

需求→证据：四态 label 不变且有文字而非仅颜色区分；作业卡、学生记录、教师记录、矩阵、作业名单的 submitted 都为琥珀、graded 都为绿；12px 文本在实际主题/背景上达到 4.5:1，使用浏览器解析实际色值并处理透明度，不四舍五入后擦边放行。

在 390、768、1440 宽下比较五个消费者；矩阵可局部横滚，页面不能溢出；未公布答案的条目继续只显示允许的状态和进度。`e2e/student-records.spec.ts`、`insights-pages.spec.ts`、作业名单相关测试是现有验证入口，按选测脚本执行。范围不含暗色主题产品上线、全站颜色重做或题目判分数据；本次仅浅色线上形态发现问题，暗色类保留兼容但不声称暗色视觉已验收。

## 2026-11-07 MCP 补审元信息

固定 canon `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`，source UNSLOP；取得与校验详情见 `evidence/canon/retrieval.json`。相关规则：`DEC-6`、`US-004`；规则强度/类别以 `CANON-REVIEW.md` 与原始主题 JSON 为准，判断方式均为 judgement。

本地检测器实际 detectorVersion 为 `sha256:210d57f5901ed2b4f3316bbeea467b2f6bfe45f659e9ad1753067132a815cc88`；文中 1.0.3 是插件版本。当前 canon 全部为 judgement，未建立或伪造自动绑定。
