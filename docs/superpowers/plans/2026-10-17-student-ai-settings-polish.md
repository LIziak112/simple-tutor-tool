# 学生 AI 连接体验与测试修复计划

分支：`codex/student-ai-settings-polish`。状态：用户已确认实施，代码、TDD、审查与验证完成。全仓 5174/5174、双浏览器并行 E2E 28/28、typecheck/lint/build 与生成幂等通过；详见 docs/审查报告/学生AI连接设置改版验收-2026-10-17.md。

## 目标

重做 `/s/settings/ai` 的整体界面，优先满足个人用户配置后直接复制使用的需求；MCP 连接卡直接展示完整 Token 与已代入 Token 的客户端配置，不设置显示密码开关，不以占位符作为正常连接的主配置。

## 文件与实施顺序

1. **契约与文档先行**：调整 `packages/contract/src/student-ai.ts` 及相关契约测试，允许本人连接设置读取 MCP Token；同步 `AGENTS.md`、学生端 AI 技术方案与使用指南。仅连接设置的本人授权读取提供该字段，普通取卷、AI 题目上下文与其他账号读取不扩展。
2. **Token 持久回显**：修改 `apps/server/src/services/ai-companion/connection-service.ts`、必要的 `connection-cipher.ts`、`apps/server/src/routes/student-ai.ts` 与测试。复用现有凭证加密能力，在既有 `configJson` 增加可选密文，认证继续使用现有哈希；无新增表字段，不需要数据库迁移。生成后刷新页面仍可复制完整 Token。旧连接只有哈希，不能反推出原 Token：保持旧凭证有效，明确提示一次重新生成后即可持续查看，不自动重置。
3. **整体 UI**：修改 `apps/web/src/pages/student/StudentAiConnectionPage.tsx` 与 `features/student-ai/AiConnectionManager.tsx`，必要时拆成同目录小组件。统一标题与内容轴线，顶部给出默认通道及状态；我的连接按页内 AI、MCP、上下文链接呈现。MCP 聚合端点、完整 Token、完整 JSON 及复制操作，减少重复文本。新增/编辑连接按当前通道显示相关字段；外发说明压缩为简短提示与可展开详情。延续学生端现有主题，不新增依赖。修正“上下文链接建设中”的滞后文案，保留加载、失败重试、复制失败反馈与未保存编辑保护。
4. **测试隔离与 lint**：修复 `playwright.config.ts` / `e2e/fake-ai-provider.ts` 及相关 AI specs 的跨文件共享假服务串扰，确保 `--workers=2` 稳定。优先保持普通 E2E 并行，通过共享 AI 套件串行分组或明确会话隔离解决，不只删除零出站断言。调整 `biome.json` 对工作区工具目录的扫描边界，并修复已确认的两个格式问题。同步验收记录头部与本轮报告结论。

## 测试点

- 先补失败测试：MCP 创建后重读/刷新可见同一完整 Token；完整 JSON 使用真实 Token；旧哈希连接不被自动重置；显式重置旧 Token 立即失效；本人可读、他人不可读；日志、AI 外发上下文与普通学生接口不含凭证。
- 连接创建、修改、默认切换、删除、测试连接、取消编辑与复制成功/失败；慢请求及后台刷新不覆盖输入。
- 空连接、三通道连接、旧 Token、解密失败、读取失败；320px、手机、iPad、桌面与键盘操作。长 Token 和 JSON 不撑破页面。
- 并行运行上一轮 26 项 Chromium/WebKit AI E2E，确认禁用零出站、开栏零出站、超时、材料、跨账号隔离与 MCP 闭环全部通过。
- 纯布局与文案部分可按项目规则豁免 TDD，交互、服务与契约变更先 RED 后 GREEN。

## 质量闸门与交付

按完整 diff 做简化、正确性及安全审查；跑定向与完整测试、`pnpm typecheck`、`pnpm lint`、`pnpm build`；契约变更后执行 `pnpm schema:export` 与 `pnpm gen:spec` 并验证幂等。保留浏览器截图与人工验证步骤，小步提交，仅提交本任务文件，不夹带原有工作区改动。全部检查通过后按用户 2026-10-17 最新指示，仅合入并推送远端 `v2`，不推进 `main`；不自动部署。

## 边界

用户明确授权的变化是本人在连接设置直接查看完整 MCP Token；不扩大到 API Key 回显、他人连接、普通学生响应或 AI 出站载荷。旧 Token 的哈希无法恢复是数据现状，不伪造、不静默更换凭证。
