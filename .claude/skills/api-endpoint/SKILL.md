---
name: api-endpoint
description: 在 simple-tutor-tool 中新增或修改后端 API 接口的标准流程。凡涉及 Hono 路由、/api/teacher|/api/student|/api/public 接口、Zod 请求校验、service 层、或前端调用接口（hc 客户端）时使用。核心约束：契约优先、学生端接口永不下发答案（assertNoLeak 泄露测试必写）。
---

# 新增/修改 API 接口

适用于 T1.9 起所有涉及接口的任务。固定顺序：**schema → 路由 → service → 测试 → 前端调用**。顺序不能颠倒，因为契约是唯一事实来源（AGENTS.md 第 1 条）。

## 固定约定（先背下来）

- 前缀：`/api/public/*`（无需登录）、`/api/teacher/*`（教师会话）、`/api/student/*`（学生会话）、`/mcp`。
- 响应格式：成功 `{ ok: true, data }`；失败 `{ ok: false, error: "UPPER_SNAKE_CODE", message: "中文说明" }`。错误码全大写下划线，如 `LINT_ERROR`、`ALREADY_SUBMITTED`。
- 实体 id 用 `crypto.randomUUID()`；题目/单元 id 来自 DSL（字符串）。
- 时间：数据库存 UTC ISO 字符串，接口返回也是 UTC，界面显示时转 Asia/Shanghai。

## 第 1 步：契约（packages/contract）

请求与响应的 Zod schema 写进 `packages/contract` 对应模块，不写在路由文件里。前端、后端、测试、MCP、导出全部 import 这一份，禁止在前后端各自手写同一个类型。

## 第 2 步：路由（apps/server/src/routes/…）

用 `@hono/zod-validator` 挂校验，校验失败走统一错误中间件（返回约定格式的 400）。业务逻辑不写在路由里，路由只做：鉴权 → 校验 → 调 service → 包装响应。

- 教师接口：会话 Cookie 中间件守卫；学生接口：学生会话中间件（注意：学生会话**不能**访问教师接口，反之亦然）。
- 登录类接口要考虑限流（`login_failures` 表，连续失败 5 次锁 10 分钟）。

## 第 3 步：service（apps/server/src/services/…）

领域服务承载业务逻辑（ContentService、AttemptService、EventService、AnalyticsService、ExportService）。service 接收解析后的输入，返回数据或抛带错误码的错误。判分只在服务端执行（`packages/grading`），客户端结果不可信。

## 第 4 步：测试（必写的最小集合）

用 `app.request()` 直接测路由（不起端口），配合 `createTestDb()` 内存库。每个接口至少覆盖：

1. **401**：未登录访问受保护接口。
2. **403**：权限不符（学生访问教师接口、非本人 attempt、未被指派的作业）。
3. **参数错误**：非法 body → 400 + 正确的 error code。
4. **正常路径**：返回 data 结构符合 schema。

### 学生端接口：泄露测试是硬性要求

学生端接口永远不返回未交卷题目的答案、详解、提示内容（AGENTS.md 第 3 条）。用 T2.4 的通用工具：

```ts
assertNoLeak(response); // 递归检查不存在 answers、solution*、hints 内容字段
```

没有跑 `assertNoLeak` 的学生端接口不允许交付。提示内容只能通过按需接口（如 `POST .../hints`）逐条获取。

## 第 5 步：前端调用

`apps/web` 统一通过 `src/lib/api.ts` 的 Hono RPC 客户端 `hc` 调用，享受端到端类型。禁止手写 fetch + 手抄类型。TanStack Query 管服务端状态。
