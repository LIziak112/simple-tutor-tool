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
import type { TeacherEnv } from "../auth/require-teacher.ts";
import type { Db } from "../db/client.ts";
import { parseJsonBodyWithCode } from "../lib/http-error.ts";
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
 * → 400 VALIDATION_ERROR。校验规则本身仍是契约 schema 单源（经
 * parseJsonBodyWithCode 只按 issue 路径分流展示码，不重写规则）。
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
  return parseJsonBodyWithCode(
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
  return parseJsonBodyWithCode(
    c,
    aiPolicyOverridePutRequestSchema,
    (firstPath) =>
      firstPath === "mode" ? "AI_POLICY_INVALID" : "VALIDATION_ERROR",
  );
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
