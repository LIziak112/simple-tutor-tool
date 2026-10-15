import {
  type AiTaskPublic,
  aiConnectionCreateRequestSchema,
  aiConnectionPatchRequestSchema,
  aiTaskCreateRequestSchema,
  aiTaskListQuerySchema,
  aiTaskUpdatePendingRequestSchema,
  studentQuickButtonsPutRequestSchema,
} from "@tutor/contract";
import type { Context } from "hono";
import { Hono } from "hono";
import type { StudentEnv } from "../auth/require-student.ts";
import { loadOrCreateSecretKey } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { AiTaskRow } from "../db/schema.ts";
import {
  firstIssueMessage,
  HttpError,
  parseJsonBody,
  parseJsonBodyWithCode,
} from "../lib/http-error.ts";
import {
  createStudentAiConnection,
  deleteStudentAiConnection,
  listStudentAiConnections,
  patchStudentAiConnection,
  testStudentAiConnection,
} from "../services/ai-companion/connection-service.ts";
import {
  getStudentQuickButtons,
  putStudentQuickButtons,
} from "../services/ai-companion/quick-buttons-service.ts";
import {
  aiQueueSummaryOf,
  aiTaskPublicViewOf,
  cancelAiTask,
  createAiTask,
  getStudentAiTaskDetail,
  listStudentAiTasks,
  openStudentAiReply,
  refreshPendingAiTask,
  resumeAiTask,
  retryAiTask,
} from "../services/ai-companion/student-ai-queue.ts";

/**
 * 学生端 AI 伴学路由（SAI-08 快捷按钮、SAI-13 任务接口），由 student.ts 挂在
 * /api/student 之下。业务全在 ai-companion 服务层，本文件只做契约解析与错误
 * 码分流：鉴权（requireStudent）→ 校验（contract）→ service → 响应壳。
 * 归属恒取 c.var.student.id，客户端自报身份/policy 字段被契约 strict 整体拒绝
 * （400 VALIDATION_ERROR），本人核验与题目/作答访问在服务层按任务 ID 复查
 * （404 同文案防枚举）。快照装配密钥取 DATA_DIR/secret.key（一次性读入）。
 *
 * 快捷按钮（SAI-08）：
 * - GET /ai/quick-buttons：本人快捷按钮整组（无配置 → 契约默认四项 + 未设置
 *   锚点，服务不物化行；删光 → 空组，不偷偷回填）；
 * - PUT /ai/quick-buttons：整组替换（含空组 = 删光）；baseUpdatedAt 过期 →
 *   409 AI_SETTINGS_STALE 保留服务器值。
 *
 * 任务接口（SAI-13，B00 §4.2 API 表的任务子集；材料 multipart / dispatch /
 * followup / share / status / connections 归后续批次 SAI-17/18/24/28）：
 * - POST /ai/tasks：创建（幂等键重放返回原任务 → 200；新建 201）。请求的
 *   materials 偏好与 quickButtonId 经契约校验后由客户端在材料上传（SAI-11
 *   attach）与统计（SAI-14）消费——服务端不存偏好，快照材料清单以实际落位
 *   行为准。仅打开页面不创建（GET 族零副作用）。
 * - GET /ai/tasks：本人任务列表（游标/筛选白名单 + limit 1..50 缺省 20，
 *   查询参数手工过契约 schema，数值经 Number 解析）。
 * - GET /ai/tasks/:id：详情 = 任务公开视图 + 对话（回信按当前策略门禁交付，
 *   需求 §3.3）+ 事实时间线（学生投影无 detail）。
 * - POST /ai/tasks/:id/update-pending|cancel|resume|retry|opened：五个显式
 *   动作，全部薄壳转发 SAI-12 操作（状态 CAS/幂等/退避在服务层）。
 * - GET /ai/queue-summary：顶栏三计数（待领取/处理中/未读，分桶单源）。
 *
 * 连接管理（SAI-16，B00 §4.2 API 表 connections 段；业务与安全防线全在
 * connection-service / outbound-target / provider-client）：
 * - GET /ai/connections：本人 active 连接列表（只含指纹视图，无密文列）；
 * - POST /ai/connections：三通道创建（201；同通道 active 重复 409；
 *   isDefault 学生维度跨通道唯一先清后设；mcp token 明文仅本响应一次）；
 * - PATCH /ai/connections/:id：按行通道判别适用字段；inapp 不传 apiKey =
 *   保持原 Key（传则重封回 unverified）；mcp resetToken 旧哈希立即失效；
 * - DELETE /ai/connections/:id：软删 + 事务内停发该通道 created 任务；
 * - POST /ai/connections/:id/test：inapp 一次真实探针（固定文案不带题面；
 *   成功 verified / 失败 failed / 解密失败 needs_rekey 不再出站）；
 *   link/mcp 通道 400 AI_CONNECTION_INVALID。Key 密封 rootSecret 与快照
 *   HMAC 同源（DATA_DIR/secret.key，一次读入复用）。
 *
 * 错误码口径：按钮名称/提示词/数量/重复与顺序冲突 → 400 AI_BUTTONS_INVALID；
 * 问题/追问文本域校验失败 → 400 AI_TEXT_TOO_LONG（§9 限额表）；连接请求
 * 形状错误（含 strict 未知键/超长）→ 400 VALIDATION_ERROR；通道适用性/
 * SSRF 保存期拒绝/非 inapp 测试 → 400 AI_CONNECTION_INVALID、同通道重复
 * → 409 AI_STATE_CONFLICT（均由服务层抛）；其余形状错误（含 strict 未知
 * 键）→ 400 VALIDATION_ERROR；策略/状态/配额错误由服务层
 * 抛 HttpError（403 AI_POLICY_DISABLED、409 AI_STATE_CONFLICT /
 * AI_TASK_LIMIT_REACHED、404 NOT_FOUND 同文案），中文消息即操作指引，
 * 不回显参考/路径/密钥。
 */

/**
 * 解析按钮请求体：buttons 域校验失败 → AI_BUTTONS_INVALID，其余 → VALIDATION_ERROR。
 * 「按钮 ID 重复 / 顺序冲突」的 superRefine 挂在契约外层对象上、issue 不带
 * 路径（首段路径为 ""、code=custom），同属按钮域错误（契约错误码注释将两者
 * 列在 AI_BUTTONS_INVALID 之下）；strict 未知键（如 teacherId）同为空路径但
 * code=unrecognized_keys，按请求形状错误回落 VALIDATION_ERROR。
 */
async function parseButtonsBody(c: Context) {
  return parseJsonBodyWithCode(
    c,
    studentQuickButtonsPutRequestSchema,
    (firstPath, issue) =>
      firstPath === "buttons" || (firstPath === "" && issue?.code === "custom")
        ? "AI_BUTTONS_INVALID"
        : "VALIDATION_ERROR",
  );
}

/**
 * 问题文本域失败 → AI_TEXT_TOO_LONG（§9），其余（含 strict 未知键、缺字段）
 * → VALIDATION_ERROR。issue.code 区分：invalid_type（字段缺失/类型不符）是
 * 形状错误，too_small/too_big（空白/超长）才是文本域错误。
 */
function textLimitCodeOf(firstPath: string, issue?: { code?: string }): string {
  return firstPath === "question" && issue?.code !== "invalid_type"
    ? "AI_TEXT_TOO_LONG"
    : "VALIDATION_ERROR";
}

export function createStudentAiRoutes(db: Db, dataDir: string) {
  // 快照装配 HMAC 密钥（SAI-09/12）：DATA_DIR/secret.key 一次性读入复用
  const hmacSecret = loadOrCreateSecretKey(dataDir);

  /** 动作路由共用响应壳：操作后的任务行 → 当前策略叠加的公开视图 */
  const taskView = (task: AiTaskRow): { ok: true; data: AiTaskPublic } => ({
    ok: true,
    data: aiTaskPublicViewOf(db, task),
  });

  return (
    new Hono<StudentEnv>()
      .get("/ai/quick-buttons", (c) => {
        return c.json({
          ok: true,
          data: getStudentQuickButtons(db, c.var.student.id),
        });
      })
      .put("/ai/quick-buttons", async (c) => {
        const body = await parseButtonsBody(c);
        return c.json({
          ok: true,
          data: putStudentQuickButtons(db, c.var.student.id, body),
        });
      })
      // —— 任务接口（SAI-13）——
      .get("/ai/queue-summary", (c) => {
        return c.json({
          ok: true,
          data: aiQueueSummaryOf(db, c.var.student.id),
        });
      })
      .post("/ai/tasks", async (c) => {
        const body = await parseJsonBodyWithCode(
          c,
          aiTaskCreateRequestSchema,
          textLimitCodeOf,
        );
        const { task, created } = createAiTask(
          db,
          {
            studentId: c.var.student.id,
            attemptId: body.attemptId,
            questionId: body.questionId,
            question: body.question,
            channel: body.channel,
            mutationId: body.mutationId,
          },
          { hmacSecret },
        );
        return c.json(taskView(task), created ? 201 : 200);
      })
      .get("/ai/tasks", (c) => {
        // GET 无 JSON body：查询参数手工过契约 schema（limit 数值经 Number 解析，
        // 白名单字段逐个取值，未知参数自然丢弃——与 /records 同款口径）
        const rawLimit = c.req.query("limit");
        const parsed = aiTaskListQuerySchema.safeParse({
          attemptId: c.req.query("attemptId") ?? undefined,
          questionId: c.req.query("questionId") ?? undefined,
          status: c.req.query("status") ?? undefined,
          limit: rawLimit === undefined ? undefined : Number(rawLimit),
          cursor: c.req.query("cursor") ?? undefined,
        });
        if (!parsed.success) {
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            `查询参数不合法：${firstIssueMessage(parsed.error)}`,
          );
        }
        const { attemptId, questionId, status, limit, cursor } = parsed.data;
        return c.json({
          ok: true,
          data: listStudentAiTasks(db, {
            studentId: c.var.student.id,
            // exactOptionalPropertyTypes：未提供字段不落显式 undefined 键
            ...(attemptId !== undefined && { attemptId }),
            ...(questionId !== undefined && { questionId }),
            ...(status !== undefined && { status }),
            ...(cursor !== undefined && { cursor }),
            limit,
          }),
        });
      })
      .get("/ai/tasks/:id", (c) => {
        return c.json({
          ok: true,
          data: getStudentAiTaskDetail(db, {
            studentId: c.var.student.id,
            taskId: c.req.param("id"),
          }),
        });
      })
      .post("/ai/tasks/:id/update-pending", async (c) => {
        const body = await parseJsonBodyWithCode(
          c,
          aiTaskUpdatePendingRequestSchema,
          textLimitCodeOf,
        );
        const task = refreshPendingAiTask(
          db,
          {
            studentId: c.var.student.id,
            taskId: c.req.param("id"),
            ...(body.question !== undefined && { question: body.question }),
          },
          { hmacSecret },
        );
        return c.json(taskView(task));
      })
      .post("/ai/tasks/:id/cancel", (c) => {
        const task = cancelAiTask(db, {
          studentId: c.var.student.id,
          taskId: c.req.param("id"),
        });
        return c.json(taskView(task));
      })
      .post("/ai/tasks/:id/resume", (c) => {
        const task = resumeAiTask(db, {
          studentId: c.var.student.id,
          taskId: c.req.param("id"),
        });
        return c.json(taskView(task));
      })
      .post("/ai/tasks/:id/retry", (c) => {
        const task = retryAiTask(db, {
          studentId: c.var.student.id,
          taskId: c.req.param("id"),
        });
        return c.json(taskView(task));
      })
      .post("/ai/tasks/:id/opened", (c) => {
        const task = openStudentAiReply(db, {
          studentId: c.var.student.id,
          taskId: c.req.param("id"),
        });
        return c.json(taskView(task));
      })
      // —— 连接管理（SAI-16；归属恒取会话，明文凭证只在 POST/PATCH 响应一次）——
      .get("/ai/connections", (c) => {
        return c.json({
          ok: true,
          data: { connections: listStudentAiConnections(db, c.var.student.id) },
        });
      })
      .post("/ai/connections", async (c) => {
        // 形状错误统一 400 VALIDATION_ERROR（parseJsonBody 缺省口径）；
        // 通道适用性 / SSRF 保存期拒绝等语义级错误由服务层抛 AI_CONNECTION_INVALID
        const request = await parseJsonBody(
          c,
          aiConnectionCreateRequestSchema,
        );
        const result = createStudentAiConnection(db, {
          studentId: c.var.student.id,
          rootSecret: hmacSecret, // 与快照 HMAC 同源 DATA_DIR/secret.key
          request,
        });
        return c.json({ ok: true, data: result }, 201);
      })
      .patch("/ai/connections/:id", async (c) => {
        const request = await parseJsonBody(
          c,
          aiConnectionPatchRequestSchema,
        );
        const result = patchStudentAiConnection(db, {
          studentId: c.var.student.id,
          connectionId: c.req.param("id"),
          rootSecret: hmacSecret,
          request,
        });
        return c.json({ ok: true, data: result });
      })
      .delete("/ai/connections/:id", (c) => {
        const result = deleteStudentAiConnection(db, {
          studentId: c.var.student.id,
          connectionId: c.req.param("id"),
        });
        return c.json({ ok: true, data: result });
      })
      .post("/ai/connections/:id/test", async (c) => {
        // 真实探针出站（transport 不可注入是设计语义：路由只调服务层默认栈）
        const data = await testStudentAiConnection(db, {
          studentId: c.var.student.id,
          connectionId: c.req.param("id"),
          rootSecret: hmacSecret,
        });
        return c.json({ ok: true, data });
      })
  );
}
