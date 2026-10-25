import {
  type AiTaskMaterialInternal,
  type AiTaskPublic,
  aiAttemptReviewActionRequestSchema,
  aiAttemptReviewCreateRequestSchema,
  aiAttemptReviewListQuerySchema,
  aiAttemptReviewPreviewQuerySchema,
  aiBatchReviewCreateRequestSchema,
  aiConnectionCreateRequestSchema,
  aiConnectionModelsRequestSchema,
  aiConnectionPatchRequestSchema,
  aiConnectionProbeRequestSchema,
  aiStatusQuerySchema,
  aiTaskCreateRequestSchema,
  aiTaskFollowupRequestSchema,
  aiTaskListQuerySchema,
  aiTaskShareRequestSchema,
  aiTaskUpdatePendingRequestSchema,
  studentQuickButtonsPutRequestSchema,
} from "@tutor/contract";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
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
  fetchStudentAiConnectionModels,
  listStudentAiConnections,
  patchStudentAiConnection,
  probeStudentAiConnection,
  testStudentAiConnection,
} from "../services/ai-companion/connection-service.ts";
import {
  getStudentQuickButtons,
  putStudentQuickButtons,
} from "../services/ai-companion/quick-buttons-service.ts";
import {
  attemptReviewActionOf,
  attemptReviewDetailOf,
  attemptReviewPreviewOf,
  attemptReviewPublicViewOf,
  createAttemptReviewTask,
  listAttemptReviewTasks,
} from "../services/ai-companion/student-ai-attempt-review.ts";
import { createAiBatchReviewTasks } from "../services/ai-companion/student-ai-batch.ts";
import {
  type AiMaterialUploadPage,
  attachAiTaskMaterials,
} from "../services/ai-companion/student-ai-materials.ts";
import {
  aiQueueSummaryOf,
  aiTaskPublicViewOf,
  archiveAiTask,
  cancelAiTask,
  createAiTask,
  followupStudentAiTask,
  getStudentAiTaskDetail,
  listStudentAiTasks,
  openStudentAiReply,
  refreshPendingAiTask,
  resumeAiTask,
  retryAiTask,
} from "../services/ai-companion/student-ai-queue.ts";
import {
  createAiShareTicket,
  revokeAiShareTickets,
  studentAiShareAccessStatus,
} from "../services/ai-companion/student-ai-share.ts";
import { studentAiStatusOf } from "../services/ai-companion/student-ai-status.ts";

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
 * 任务接口（SAI-13，B00 §4.2 API 表的任务子集；followup SAI-21、
 * share 票据生成/撤销 SAI-28）：
 * - POST /ai/tasks：创建（幂等键重放返回原任务 → 200；新建 201）。请求的
 *   materials 偏好与 quickButtonId 经契约校验后由客户端在材料上传（SAI-11
 *   attach）与统计（SAI-14）消费——服务端不存偏好，快照材料清单以实际落位
 *   行为准。仅打开页面不创建（GET 族零副作用）。
 * - POST /ai/tasks/:id/materials（SAI-20）：multipart 材料登记（manifest +
 *   page-N；归属/状态/策略/版本锚定与字节/槽位防线在 attachAiTaskMaterials）。
 * - GET /ai/tasks：本人任务列表（游标/筛选白名单 + limit 1..50 缺省 20，
 *   查询参数手工过契约 schema，数值经 Number 解析）。
 * - GET /ai/tasks/:id：详情 = 任务公开视图 + 对话（回信按当前策略门禁交付，
 *   需求 §3.3）+ 事实时间线（学生投影无 detail）。
 * - POST /ai/tasks/:id/update-pending|cancel|resume|retry|opened：五个显式
 *   动作，全部薄壳转发 SAI-12 操作（状态 CAS/幂等/退避在服务层）。
 * - GET /ai/queue-summary：顶栏三计数（待领取/处理中/未读，分桶单源）。
 *
 * 单题状态（SAI-20，B11）：
 * - GET /ai/status?attemptId&questionId：有效模式与原因 + 完成态 + 默认通道
 *   连接态 + 首次知情门槛 + 本题任务摘要（student-ai-status 服务单源，
 *   实时裁决不缓存——教师刚改设置立即生效；GET 零副作用）。
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
 * 首次知情门（三个任务创建入口共用，规则三已到：批量复盘 / 单题任务 /
 * 整体复盘）：无任何 active 连接 = 未跨过首次知情，403 且不落任务行
 * （不占配额，也不产必然发送失败的僵尸任务）。
 */
function requireAiInformedGate(db: Db, studentId: string): void {
  if (listStudentAiConnections(db, studentId).length === 0) {
    throw new HttpError(
      403,
      "AI_SETUP_REQUIRED",
      "还没有可用的 AI 连接，请先在设置中完成连接与首次知情确认",
    );
  }
}

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

/**
 * 批量复盘请求的错误码分流：items 超上限（too_big）→ 400 AI_BATCH_LIMIT
 * （§9 限额表）；问题文本域沿用 AI_TEXT_TOO_LONG；其余（空 items、重复条目、
 * strict 未知键——含伪造的 correct 标记）→ VALIDATION_ERROR。
 */
function batchLimitCodeOf(
  firstPath: string,
  issue?: { code?: string },
): string {
  if (firstPath === "items" && issue?.code === "too_big") {
    return "AI_BATCH_LIMIT";
  }
  return textLimitCodeOf(firstPath, issue);
}

/**
 * 材料上传 manifest 的传输层形状（multipart 无 JSON 请求 schema，契约约定
 * 见 student-ai-api.ts 头注）：每页声明类别/页序/像素尺寸，字节与 PNG IHDR
 * 一致性、数量与合计限额、槽位冲突全在服务层 validatePages。
 */
const aiMaterialManifestPageSchema = z
  .object({
    kind: z.enum(["annotation", "draft", "formal_ink"]),
    pageIndex: z.number().int().min(0),
    pixelWidth: z.number().int().positive(),
    pixelHeight: z.number().int().positive(),
  })
  .strict();

/** 材料回执公开视图（内部行的 pngPath 结构上不进响应） */
function materialReceiptOf(rows: readonly AiTaskMaterialInternal[]) {
  const materials = rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    pageIndex: row.pageIndex,
    pixelWidth: row.pixelWidth,
    pixelHeight: row.pixelHeight,
    byteSize: row.byteSize,
    hash: row.hash,
    state: row.state,
    missingReason: row.missingReason,
  }));
  return {
    materials,
    totalBytes: rows.reduce((sum, row) => sum + row.byteSize, 0),
  };
}

/** 解析材料 multipart：manifest（JSON 数组）+ page-N 文件逐页配对 */
async function parseMaterialsBody(
  c: Context,
): Promise<readonly AiMaterialUploadPage[]> {
  const form = await c.req.parseBody();
  const manifestField = form.manifest;
  if (typeof manifestField !== "string") {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "请求需为 multipart/form-data，且包含 manifest 字段与逐页 page-N 文件",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestField);
  } catch {
    throw new HttpError(400, "VALIDATION_ERROR", "材料清单不是合法 JSON");
  }
  const manifest = z.array(aiMaterialManifestPageSchema).safeParse(parsed);
  if (!manifest.success) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `材料清单不合法：${firstIssueMessage(manifest.error)}`,
    );
  }
  const pages: AiMaterialUploadPage[] = [];
  for (const [index, meta] of manifest.data.entries()) {
    const file = form[`page-${index}`];
    if (!(file instanceof File)) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        `材料清单第 ${index + 1} 页缺少对应文件（page-${index}）`,
      );
    }
    pages.push({
      kind: meta.kind,
      pageIndex: meta.pageIndex,
      pixelWidth: meta.pixelWidth,
      pixelHeight: meta.pixelHeight,
      png: new Uint8Array(await file.arrayBuffer()),
    });
  }
  return pages;
}

export function createStudentAiRoutes(
  db: Db,
  dataDir: string,
  /** 对外基础 URL（票据 URL 拼接；与 Cookie Secure 同源的部署配置） */
  publicUrl: string,
) {
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
      // —— 批量错题复盘（SAI-31，B16）：一次确认建一批，逐项裁决逐项返回
      //    （规则/幂等派生/不重复计费在 student-ai-batch 服务层单源；本路由
      //    只做知情门 + 契约解析——与 POST /ai/tasks 同口径不落任何任务行）。
      .post("/ai/batch-review", async (c) => {
        requireAiInformedGate(db, c.var.student.id);
        const body = await parseJsonBodyWithCode(
          c,
          aiBatchReviewCreateRequestSchema,
          batchLimitCodeOf,
        );
        const data = createAiBatchReviewTasks(
          db,
          {
            studentId: c.var.student.id,
            items: body.items,
            channel: body.channel,
            question: body.question,
            mutationId: body.mutationId,
          },
          { hmacSecret },
        );
        return c.json({ ok: true, data });
      })
      // —— 本次练习整体复盘（任务 1ef854c7）：范围预览 → 确认创建 →
      //    列表/详情/动作；裁决与防线全在服务层（student-ai-attempt-review
      //    单源），本文件只做知情门 + 契约解析。整体任务只走 MCP 通道。——
      .get("/ai/attempt-reviews/preview", (c) => {
        const parsed = aiAttemptReviewPreviewQuerySchema.safeParse({
          attemptId: c.req.query("attemptId") ?? undefined,
        });
        if (!parsed.success) {
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            `查询参数不合法：${firstIssueMessage(parsed.error)}`,
          );
        }
        return c.json({
          ok: true,
          data: attemptReviewPreviewOf(
            db,
            { studentId: c.var.student.id, attemptId: parsed.data.attemptId },
            { hmacSecret },
          ),
        });
      })
      .post("/ai/attempt-reviews", async (c) => {
        // 知情门与批量复盘同口径：无任何 active 连接 = 未跨过首次知情，
        // 403 且不落任务行（不占配额，不产必然失败的僵尸任务）
        requireAiInformedGate(db, c.var.student.id);
        const body = await parseJsonBody(c, aiAttemptReviewCreateRequestSchema);
        const { task, created } = createAttemptReviewTask(
          db,
          {
            studentId: c.var.student.id,
            attemptId: body.attemptId,
            mutationId: body.mutationId,
            expectedPreviewVersion: body.expectedPreviewVersion,
            purpose: body.purpose,
          },
          { hmacSecret },
        );
        return c.json(
          {
            ok: true,
            data: {
              task: attemptReviewPublicViewOf(db, task),
              created,
            },
          },
          created ? 201 : 200,
        );
      })
      .get("/ai/attempt-reviews", (c) => {
        const rawLimit = c.req.query("limit");
        const parsed = aiAttemptReviewListQuerySchema.safeParse({
          attemptId: c.req.query("attemptId") ?? undefined,
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
        const { attemptId, status, limit, cursor } = parsed.data;
        return c.json({
          ok: true,
          data: listAttemptReviewTasks(db, {
            studentId: c.var.student.id,
            ...(attemptId !== undefined && { attemptId }),
            ...(status !== undefined && { status }),
            ...(cursor !== undefined && { cursor }),
            limit,
          }),
        });
      })
      .get("/ai/attempt-reviews/:id", (c) => {
        return c.json({
          ok: true,
          data: attemptReviewDetailOf(db, {
            studentId: c.var.student.id,
            taskId: c.req.param("id"),
          }),
        });
      })
      .post("/ai/attempt-reviews/:id/actions", async (c) => {
        const body = await parseJsonBody(c, aiAttemptReviewActionRequestSchema);
        return c.json({
          ok: true,
          data: attemptReviewActionOf(db, {
            studentId: c.var.student.id,
            taskId: c.req.param("id"),
            action: body.action,
          }),
        });
      })
      // —— 单题状态（SAI-20；伴学栏/发送控制器的服务端裁决入口）——
      .get("/ai/status", (c) => {
        // GET 无 JSON body：查询参数手工过契约 schema（与 /ai/tasks 列表同口径）
        const parsed = aiStatusQuerySchema.safeParse({
          attemptId: c.req.query("attemptId") ?? undefined,
          questionId: c.req.query("questionId") ?? undefined,
        });
        if (!parsed.success) {
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            `查询参数不合法：${firstIssueMessage(parsed.error)}`,
          );
        }
        return c.json({
          ok: true,
          data: studentAiStatusOf(db, {
            studentId: c.var.student.id,
            attemptId: parsed.data.attemptId,
            questionId: parsed.data.questionId,
          }),
        });
      })
      .post("/ai/tasks", async (c) => {
        // 知情门服务端强制（SAI-18 遗留①，B11 闸门兑现）：客户端 needsSetup
        // 引导之外直调路由同样不能绕过——无任何 active 连接 = 未跨过首次
        // 知情（status firstUseRequired 同口径单源），403 且不落任务行
        // （不占同题/当日配额，也不产必然发送失败的僵尸任务）。
        requireAiInformedGate(db, c.var.student.id);
        const body = await parseJsonBodyWithCode(
          c,
          aiTaskCreateRequestSchema,
          textLimitCodeOf,
        );
        // link 通道（SAI-28 起开放）：任务创建 + 显式生成票据两步走——worker
        // 只领 inapp、MCP 客户端只领 mcp，link 任务停在 created 等学生生成
        // 链接交给外部 AI；读取不推进任务状态（公开读端点零队列副作用）。
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
          archived: c.req.query("archived") ?? undefined,
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
        const { attemptId, questionId, status, archived, limit, cursor } =
          parsed.data;
        return c.json({
          ok: true,
          data: listStudentAiTasks(db, {
            studentId: c.var.student.id,
            // exactOptionalPropertyTypes：未提供字段不落显式 undefined 键
            ...(attemptId !== undefined && { attemptId }),
            ...(questionId !== undefined && { questionId }),
            ...(status !== undefined && { status }),
            ...(archived !== undefined && { archived }),
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
      // —— 材料上传（SAI-20；multipart 薄壳，防线在服务层）——
      .post("/ai/tasks/:id/materials", async (c) => {
        const pages = await parseMaterialsBody(c);
        const rows = attachAiTaskMaterials(db, dataDir, {
          studentId: c.var.student.id,
          taskId: c.req.param("id"),
          pages,
        });
        return c.json({ ok: true, data: materialReceiptOf(rows) });
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
      .post("/ai/tasks/:id/followup", async (c) => {
        const body = await parseJsonBodyWithCode(
          c,
          aiTaskFollowupRequestSchema,
          textLimitCodeOf,
        );
        const result = followupStudentAiTask(db, {
          studentId: c.var.student.id,
          taskId: c.req.param("id"),
          question: body.question,
        });
        return c.json({
          ok: true,
          data: {
            task: taskView(result.task).data,
            messages: result.messages,
          },
        });
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
      // —— 归档（SAI-23）：队列整理动作不是状态转换，防线在服务层（终态
      // 裁决 + 归档≠已读 + 幂等 + 他人 404 同文案防枚举）——
      .post("/ai/tasks/:id/archive", (c) => {
        const task = archiveAiTask(db, {
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
      // —— 分享票据（SAI-28，B15）：生成/撤销都是学生显式动作；token 明文
      //    只随生成响应返回一次，撤销按任务整批（学生心智=这道题给出去的链接）——
      //    生命周期防线（本人/当前模式/状态门禁/有效期/实时重校验）在服务层。
      .post("/ai/tasks/:id/share", async (c) => {
        const body = await parseJsonBody(c, aiTaskShareRequestSchema);
        const result = createAiShareTicket(db, {
          studentId: c.var.student.id,
          taskId: c.req.param("id"),
          ...(body.validHours !== undefined
            ? { validHours: body.validHours }
            : {}),
        });
        return c.json({
          ok: true,
          data: {
            ticketUrl: `${publicUrl.replace(/\/+$/, "")}/api/public/ai/share/${result.token}`,
            snapshotAt: result.snapshotAt,
            expiresAt: result.expiresAt,
          },
        });
      })
      .get("/ai/tasks/:id/share/status", (c) => {
        c.header("Cache-Control", "no-store");
        const data = studentAiShareAccessStatus(db, {
          studentId: c.var.student.id,
          taskId: c.req.param("id"),
        });
        return c.json({ ok: true, data });
      })
      .delete("/ai/tasks/:id/share", (c) => {
        const result = revokeAiShareTickets(db, {
          studentId: c.var.student.id,
          taskId: c.req.param("id"),
        });
        return c.json({ ok: true, data: result });
      })
      // —— 本人连接管理：MCP Token 允许持续查看，响应不进入共享缓存。——
      .get("/ai/connections", (c) => {
        c.header("Cache-Control", "no-store");
        return c.json({
          ok: true,
          data: {
            connections: listStudentAiConnections(
              db,
              c.var.student.id,
              hmacSecret,
            ),
          },
        });
      })
      .post("/ai/connections", async (c) => {
        c.header("Cache-Control", "no-store");
        // 形状错误统一 400 VALIDATION_ERROR（parseJsonBody 缺省口径）；
        // 通道适用性 / SSRF 保存期拒绝等语义级错误由服务层抛 AI_CONNECTION_INVALID
        const request = await parseJsonBody(c, aiConnectionCreateRequestSchema);
        const result = createStudentAiConnection(db, {
          studentId: c.var.student.id,
          rootSecret: hmacSecret, // 与快照 HMAC 同源 DATA_DIR/secret.key
          request,
        });
        return c.json({ ok: true, data: result }, 201);
      })
      .post("/ai/connections/models", async (c) => {
        c.header("Cache-Control", "no-store");
        const request = await parseJsonBody(c, aiConnectionModelsRequestSchema);
        const data = await fetchStudentAiConnectionModels(db, {
          studentId: c.var.student.id,
          rootSecret: hmacSecret,
          request,
        });
        return c.json({ ok: true, data });
      })
      .post("/ai/connections/probe", async (c) => {
        c.header("Cache-Control", "no-store");
        const request = await parseJsonBody(c, aiConnectionProbeRequestSchema);
        const data = await probeStudentAiConnection(db, {
          studentId: c.var.student.id,
          rootSecret: hmacSecret,
          request,
        });
        return c.json({ ok: true, data });
      })
      .patch("/ai/connections/:id", async (c) => {
        c.header("Cache-Control", "no-store");
        const request = await parseJsonBody(c, aiConnectionPatchRequestSchema);
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
