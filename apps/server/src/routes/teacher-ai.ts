import type {
  AiPolicyOverridePutRequest,
  AiTeacherSettingsPutRequest,
} from "@tutor/contract";
import {
  aiPolicyOverridePutRequestSchema,
  aiTeacherSettingsPutRequestSchema,
} from "@tutor/contract";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ZodType } from "zod";
import type { TeacherEnv } from "../auth/require-teacher.ts";
import type { Db } from "../db/client.ts";
import { firstIssueMessage, HttpError } from "../lib/http-error.ts";
import {
  type AiPolicySubject,
  getAiPolicyOverride,
  getTeacherAiSettings,
  putAiPolicyOverride,
  updateTeacherAiSettings,
} from "../services/ai-companion/settings-service.ts";

/**
 * 教师端 AI 教学配置路由（SAI-06，需教师会话），由 teacher.ts 挂在
 * /api/teacher 之下（业务全在 ai-companion/settings-service，本文件只做
 * 契约解析与错误码分流，不在路由层拼裁决逻辑）：
 * - GET  /ai/settings：教师默认模式 + 三模板（未设置 → 默认值 + 锚点时刻）；
 * - PUT  /ai/settings：部分更新（缺省 = 不改；null = 恢复默认模板；
 *   baseUpdatedAt 过期 → 409 AI_SETTINGS_STALE 保留服务器值）；
 * - GET/PUT /students/:id/ai-policy、/assignments/:id/ai-policy：覆盖读写
 *   （inherit = 删行回继承），响应携带保存后即刻有效裁决预览。
 *
 * 错误码口径（契约 aiPolicyErrorCodeSchema）：模板正文空/超长 → 400
 * AI_PROMPT_INVALID；覆盖 mode 非法 → 400 AI_POLICY_INVALID；其余校验失败
 * → 400 VALIDATION_ERROR。校验规则本身仍是契约 schema 单源（这里只按
 * issue 路径分流展示码，与 parseJsonBody 的手工过 schema 先例同款）。
 */

/** 契约 schema 校验失败时按 issue 首段路径分流的模板字段集合 */
const PROMPT_TEMPLATE_FIELDS = new Set([
  "promptsOpen",
  "promptsGuided",
  "promptsReview",
]);

/** 解析设置请求体：模板字段校验失败 → AI_PROMPT_INVALID，其余 → VALIDATION_ERROR */
async function parseSettingsBody(
  c: Context,
): Promise<AiTeacherSettingsPutRequest> {
  return parseBodyWithCodeMap(
    c,
    aiTeacherSettingsPutRequestSchema,
    (firstPath) =>
      PROMPT_TEMPLATE_FIELDS.has(firstPath)
        ? "AI_PROMPT_INVALID"
        : "VALIDATION_ERROR",
  );
}

/** 解析覆盖请求体：mode 字段校验失败 → AI_POLICY_INVALID（契约口径） */
async function parseOverrideBody(
  c: Context,
): Promise<AiPolicyOverridePutRequest> {
  return parseBodyWithCodeMap(
    c,
    aiPolicyOverridePutRequestSchema,
    (firstPath) =>
      firstPath === "mode" ? "AI_POLICY_INVALID" : "VALIDATION_ERROR",
  );
}

/**
 * 路由层手工过 schema 变体：校验仍走契约 schema（不重写规则），失败时
 * 按 issue 首段路径改写错误码。不复用 parseJsonBody 再重读 body——
 * Request 流已被消费，二次 c.req.json() 会失败，故这里自己读一次文本。
 */
async function parseBodyWithCodeMap<T>(
  c: Context,
  schema: ZodType<T>,
  codeOf: (firstIssuePath: string) => string,
): Promise<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(await c.req.text()) as unknown;
  } catch {
    throw new HttpError(400, "VALIDATION_ERROR", "请求体不是合法的 JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const firstPath = String(parsed.error.issues[0]?.path[0] ?? "");
    throw new HttpError(
      400,
      codeOf(firstPath),
      `请求参数不合法：${firstIssueMessage(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function createTeacherAiRoutes(db: Db) {
  return new Hono<TeacherEnv>()
    .get("/ai/settings", (c) => {
      return c.json({
        ok: true,
        data: getTeacherAiSettings(db, c.var.teacher.id),
      });
    })
    .put("/ai/settings", async (c) => {
      const body = await parseSettingsBody(c);
      return c.json({
        ok: true,
        data: updateTeacherAiSettings(db, c.var.teacher.id, body),
      });
    })
    .get("/students/:id/ai-policy", (c) => {
      const subject: AiPolicySubject = {
        type: "student",
        id: c.req.param("id"),
      };
      return c.json({
        ok: true,
        data: getAiPolicyOverride(db, c.var.teacher.id, subject),
      });
    })
    .put("/students/:id/ai-policy", async (c) => {
      const body = await parseOverrideBody(c);
      const subject: AiPolicySubject = {
        type: "student",
        id: c.req.param("id"),
      };
      return c.json({
        ok: true,
        data: putAiPolicyOverride(db, c.var.teacher.id, subject, body.mode),
      });
    })
    .get("/assignments/:id/ai-policy", (c) => {
      const subject: AiPolicySubject = {
        type: "assignment",
        id: c.req.param("id"),
      };
      return c.json({
        ok: true,
        data: getAiPolicyOverride(db, c.var.teacher.id, subject),
      });
    })
    .put("/assignments/:id/ai-policy", async (c) => {
      const body = await parseOverrideBody(c);
      const subject: AiPolicySubject = {
        type: "assignment",
        id: c.req.param("id"),
      };
      return c.json({
        ok: true,
        data: putAiPolicyOverride(db, c.var.teacher.id, subject, body.mode),
      });
    });
}
