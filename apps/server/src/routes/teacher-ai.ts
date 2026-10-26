import type {
  AiPolicyOverridePutRequest,
  AiPromptSettingsPutRequest,
  AiTeacherSettingsPutRequest,
} from "@tutor/contract";
import {
  aiPolicyOverridePutRequestSchema,
  aiPromptSettingsPutRequestSchema,
  aiTeacherSettingsPutRequestSchema,
} from "@tutor/contract";
import type { Context } from "hono";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher.ts";
import type { Db } from "../db/client.ts";
import { noStoreBinaryResponse } from "../lib/binary-response.ts";
import { parseJsonBodyWithCode } from "../lib/http-error.ts";
import {
  getAiPromptSettings,
  updateAiPromptSettings,
} from "../services/ai-companion/ai-prompt-settings-service.ts";
import {
  type AiPolicySubject,
  getAiPolicyOverride,
  getTeacherAiSettings,
  putAiPolicyOverride,
  updateTeacherAiSettings,
} from "../services/ai-companion/settings-service.ts";
import { readTeacherAiTaskMaterial } from "../services/ai-companion/student-ai-materials.ts";
import {
  getTeacherAiTaskDetail,
  getTeacherAttemptAiRecords,
} from "../services/ai-companion/teacher-ai-records.ts";

/**
 * 教师端 AI 路由（SAI-06 配置 + SAI-24 督学记录，需教师会话），由 teacher.ts
 * 挂在 /api/teacher 之下（业务全在 ai-companion 服务层，本文件只做契约解析
 * 与错误码分流，不在路由层拼裁决逻辑）：
 * - GET  /ai/settings：教师默认模式 + 三模板（未设置 → 默认值 + 锚点时刻）；
 * - PUT  /ai/settings：部分更新（缺省 = 不改；null = 恢复默认模板；
 *   baseUpdatedAt 过期 → 409 AI_SETTINGS_STALE 保留服务器值）；
 * - GET/PUT /ai/prompts（hall-9533）：出题助手/学情包/复习包提示词槽位
 *   （updates[].body null = 恢复该槽位默认；baseUpdatedAt 过期 → 409 同上）；
 * - GET/PUT /students/:id/ai-policy、/assignments/:id/ai-policy：覆盖读写
 *   （inherit = 删行回继承），响应携带保存后即刻有效裁决预览；
 * - GET /attempts/:id/ai-records（SAI-24）：按卷求助记录——每题事实摘要
 *   （distinct 题数）+ 任务行轻量形态（回信正文与材料图按需另取）；
 * - GET /ai/tasks/:id（SAI-24）：任务详情（快照 + 对话 + 事实时间线）；
 * - GET /ai/tasks/:id/materials/:materialId/image.png（SAI-24）：材料 PNG
 *   直出（域校验同上——教师不以学生 URL 绕过，他域 404 同文案）。
 *
 * 错误码口径（契约 aiPolicyErrorCodeSchema）：模板正文空/超长 → 400
 * AI_PROMPT_INVALID；覆盖 mode 非法 → 400 AI_POLICY_INVALID；其余校验失败
 * → 400 VALIDATION_ERROR。校验规则本身仍是契约 schema 单源（经
 * parseJsonBodyWithCode 只按 issue 路径分流展示码，不重写规则）。督学读
 * 端点的域外/不存在统一 404（ATTEMPT_NOT_FOUND / NOT_FOUND 同文案防枚举）。
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

/** 解析提示词设置请求体：槽位正文校验失败 → AI_PROMPT_INVALID，其余 → VALIDATION_ERROR */
async function parsePromptsBody(
  c: Context,
): Promise<AiPromptSettingsPutRequest> {
  return parseJsonBodyWithCode(
    c,
    aiPromptSettingsPutRequestSchema,
    (firstPath) =>
      firstPath === "updates" ? "AI_PROMPT_INVALID" : "VALIDATION_ERROR",
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

export function createTeacherAiRoutes(db: Db, dataDir: string) {
  return (
    new Hono<TeacherEnv>()
      // —— 督学记录（SAI-24；读端点，域外/不存在 404 同文案防枚举）——
      .get("/attempts/:id/ai-records", (c) => {
        return c.json({
          ok: true,
          data: getTeacherAttemptAiRecords(
            db,
            c.var.teacher.id,
            c.req.param("id"),
          ),
        });
      })
      .get("/ai/tasks/:id", (c) => {
        return c.json(
          {
            ok: true,
            data: getTeacherAiTaskDetail(
              db,
              c.var.teacher.id,
              c.req.param("id"),
            ),
          },
          200,
          { "cache-control": "no-store" },
        );
      })
      // 材料 PNG 直出：域校验在 readTeacherAiTaskMaterial（不以学生 URL 绕过）；
      // no-store 与教师证据图同口径（历史留痕随任务固定，但避免任何中间缓存）
      .get("/ai/tasks/:id/materials/:materialId/image.png", (c) => {
        const material = readTeacherAiTaskMaterial(db, dataDir, {
          teacherId: c.var.teacher.id,
          taskId: c.req.param("id"),
          materialId: c.req.param("materialId"),
        });
        return noStoreBinaryResponse(material.bytes, "image/png");
      })
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
      .get("/ai/prompts", (c) => {
        return c.json({
          ok: true,
          data: getAiPromptSettings(db, "teacher", c.var.teacher.id),
        });
      })
      .put("/ai/prompts", async (c) => {
        const body = await parsePromptsBody(c);
        return c.json({
          ok: true,
          data: updateAiPromptSettings(db, "teacher", c.var.teacher.id, body),
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
      })
  );
}
