# 学生端做题方式与反馈节奏升级 · 执行追踪

- 日期：2026-10-22。
- 状态：用户已批准完整计划（docs/superpowers/plans/2026-10-22-student-practice-feedback-upgrade.md）；M0 进行中，分批验收。
- 执行者：GLM-5.3（独立工作树 codex/practice-feedback-design，编排者 Codex 验收合并）。

## 工作区事实

- 原分支工作区 HEAD 为 813ef1a0；本工作树不包含用户三份 AI 未提交修改，后续集成必须保留它们。
- task-workflow / simplify / code-review / security-review 技能本机未找到，不得假称调用；由编排者以完整 diff 的实际简化、正确性、安全审查替代。
- 已找到 ~/.claude/skills/test-driven-development/SKILL.md 与 verification-before-completion/SKILL.md，M1 起实现须按其纪律。

## 基线检查真实结果（2026-10-22，本工作树）

| 命令 | 结果 |
| --- | --- |
| pnpm install --frozen-lockfile | exit 0 |
| pnpm lint | exit 0（2 warning + 1 info，均为旧代码） |
| pnpm typecheck | exit 0 |
| pnpm test | 453 文件 / 5312 用例，5311 通过、1 失败：apps/web/src/features/student-ai/route-integration.test.tsx beforeEach 初始化 10 秒超时；当时尚未改动业务代码，资源争用仅为待证实推测 |
| pnpm test apps/web/src/features/student-ai/route-integration.test.tsx --maxWorkers=2 | 5/5 通过，exit 0 |
| pnpm test --maxWorkers=4 | 453 文件、5312 用例全部通过，exit 0，312.09 秒 |
| pnpm build | exit 0；有既有大分包与动态导入警告 |

- 首次全量不是全绿；单文件复核及限制并发的全量复核均通过，未修改测试或扩大超时掩盖失败。
- 日志：C:/Users/HUAYU/.claude/orchestration/practice-feedback-20261022/。

## 已核对风险（M0 源码核对结论，详见同目录 2026-10-22-student-practice-feedback-baseline.md）

1. `submitLessonQuestion` 在事务外读取 row.answerJson 并判分，事务内仅检查状态；M2 必须把版本核对与实际答案读取/判分移入事务（计划 §10.2 已确认此窗口）。
2. `useAttemptAnswers.flush()` 为全局接口，M3 须扩展按题 flush。
3. 数据库当前无 workflow / 反馈相关新字段；backup-service 为整库 VACUUM/ZIP 恢复，新增列需迁移兼容与备份往返测试，不新造 JSON 备份系统。
4. 教师设置实际页面为 apps/web/src/pages/teacher/SettingsPage.tsx，教师能力配置仅 steps/ink，反馈默认须独立配置项；计划中 packages/contract/src/teacher-settings.ts、lesson.ts 不存在，讲练契约实际在 lesson-api.ts，计划文件路径仅为建议，落地须实际定位。
5. AttemptSession 为通用会话（课程/作业/错题共用）；QuestionSurface/FinalAnswerInput 同源输入；PaperPresentation 为同稿全屏。phaseOfRows 普通来源仅整卷完成，lesson 看题 submittedAt，M4 需统一完成态 helper。AI compare 常量 1060px。
6. pending-mark 已按响应行 submittedAt 纳入 draft 卷待批（注释过时）；teacherMark / attempt draft 状态收尾须保护（计划 §13）。

## 批次清单 M0–M6

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| M0 设计确认与交互基线 | 执行追踪、基线核对、离线交互线框稿；不改领域逻辑 | 文档与浏览器基线已核对；真机待验收 |
| M1 契约与教师裁决 | 失败测试先行：策略组合、历史缺省、非法组合、CAS、旧客户端；契约 + 迁移 + resolver + 教师默认与作业三选项 | 未开始 |
| M2 通用逐题服务 | 失败测试先行：提交版本、幂等、邻题泄露、教师收紧、并发收尾；抽取 submitAttemptQuestion；事务内判分 | 未开始 |
| M3 单题工作区及输入 | 失败测试先行：当前题恢复、原位只读、四组合、按题 flush、快捷键保护、最后一题留反馈 | 未开始 |
| M4 AI、证据及统计整合 | 失败测试先行：本题 AI 完成态、旧回复不串题、三布局回退、待批/改判/统计与导出 | 未开始 |
| M5 偏好、DSL 与往返 | 失败测试先行：账号隔离、来源返回、推荐优先级、mixed、重导/导出与历史 samples | 未开始 |
| M6 全链验证与发布 | 压测、真实 Chromium/WebKit、手机/iPad/Pencil/软键盘、质量闸门、发布/回退说明 | 未开始 |

- 依赖主线 M0 → M1 → … → M6；每批次独立 codex/ 分支，测试先行，未完成项不得写成通过。
- M0 待验收项：真机（iPhone/Android/iPad Safari、Pencil、软键盘）与 iPad Pencil 待编排者/用户核对，不得把视口模拟写成真机通过。

## 验收记录

### M0 文档与原型审查

- GLM-5.3 经 Claude Code CLI 写入三份工件，Codex 审查并修正题卡宽度、示例主动作、AI 窄屏回退及侧栏位置。原型是示例线框稿，不是已上线功能或最终视觉稿。
- 实际调用日志返回 `contextWindow: 258000`，模型为 `glm-5.3`。较长响应发生中途截断及自动重试，改为分段写入；日志保存在上文目录。没有启动其他模型或子代理。
- 真实 Edge 无头浏览器：320/390/820/1180 四视口 × 四组合，共 16 项宽度检查；七题型已提交输入只读、标签、输入/宿主保持、整卷模式不展示题级参考答案、AI 三布局及窄屏弹窗回退，共 15 项行为检查通过；页面脚本异常和外站请求均为 0。
- 截图、检查脚本与报告：上文日志目录 `prototype-*.png`、`check-prototype.mjs`、`prototype-report.json`。检查脚本属于本次编排工件，未成为业务测试替代品。
- 简化审查：复用单张题卡与单份 AI 正文，移除重复 ID 和多余状态循环。正确性审查修复填空锁定、输入标签及下一题动作；安全审查确认仅离线示例、无真实数据或出站。
- 手动验证：打开 `docs/superpowers/prototypes/student-practice-feedback.html`，切换两布局、两反馈、七题型和四状态，输入后切换布局，查看 AI 题下/侧边/弹窗；窄屏侧边回退弹窗，关闭后焦点回入口。
- 本阶段是文档与独立原型，按 AGENTS 纯样式/文案豁免镜像单测；浏览器检查已实际执行。真机、Pencil、Safari 软键盘未执行，继续列为发布前门槛。
