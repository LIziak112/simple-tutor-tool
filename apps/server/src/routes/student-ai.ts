import { studentQuickButtonsPutRequestSchema } from "@tutor/contract";
import type { Context } from "hono";
import { Hono } from "hono";
import type { StudentEnv } from "../auth/require-student.ts";
import type { Db } from "../db/client.ts";
import { parseJsonBodyWithCode } from "../lib/http-error.ts";
import {
  getStudentQuickButtons,
  putStudentQuickButtons,
} from "../services/ai-companion/quick-buttons-service.ts";

/**
 * 学生端 AI 伴学路由（SAI-08 起，需学生会话），由 student.ts 挂在
 * /api/student 之下（业务全在 ai-companion 服务层，本文件只做契约解析
 * 与错误码分流；归属恒取 c.var.student.id，客户端无可传归属字段）：
 * - GET /ai/quick-buttons：本人快捷按钮整组（无配置 → 契约默认四项 + 未设置
 *   锚点，服务不物化行；删光 → 空组，不偷偷回填）；
 * - PUT /ai/quick-buttons：整组替换（含空组 = 删光）；baseUpdatedAt 过期 →
 *   409 AI_SETTINGS_STALE 保留服务器值。
 *
 * 错误码口径（契约 aiPolicyErrorCodeSchema）：按钮名称/提示词/数量/重复与
 * 顺序冲突 → 400 AI_BUTTONS_INVALID；教师域字段（teacherId/effectiveMode 等）
 * 出现在请求体 → 400 VALIDATION_ERROR（契约 strict 整体拒绝，学生不能借本
 * 接口改教师模板）。校验规则仍是契约 schema 单源（parseJsonBodyWithCode
 * 只按 issue 路径分流展示码，不重写规则）。
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

export function createStudentAiRoutes(db: Db) {
  return new Hono<StudentEnv>()
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
    });
}
