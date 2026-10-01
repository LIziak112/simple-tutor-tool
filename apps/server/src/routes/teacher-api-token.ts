import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { getApiToken, regenerateApiToken } from "../services/api-token-service";

/**
 * API Token 路由（需教师会话，T4.6 D22），由 teacher.ts 挂在 /api/teacher 之下：
 * - GET  /api-token：查看当前 token（未生成为 null，设置页提示可生成；
 *   D22：可随时查看，不做「只显示一次」）；
 * - POST /api-token：生成 / 重置（同一动作：无则生成、有则覆盖；旧 token 立即
 *   失效。前端重置需二次确认并提示「已配置的客户端需更新 token」）。
 */
export function createTeacherApiTokenRoutes(db: Db) {
  return new Hono<TeacherEnv>()
    .get("/api-token", (c) => {
      return c.json({ ok: true, data: getApiToken(db, c.var.teacher.id) });
    })
    .post("/api-token", (c) => {
      return c.json({
        ok: true,
        data: regenerateApiToken(db, c.var.teacher.id),
      });
    });
}
