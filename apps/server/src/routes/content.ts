import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { getContentTree } from "../services/content-service";

/**
 * 内容查询路由（需教师会话），由 teacher.ts 挂在 /api/teacher 之下：
 * - GET /content：教师端内容页的树状结构（课程 → 讲义/单元 → 题目摘要，T1.11）。
 *
 * 业务逻辑在 ContentService（api-endpoint 技能约定：路由只做鉴权→调 service→包装）。
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型（AppType / hc 前提）。
 */
export function createContentRoutes(db: Db) {
  return new Hono<TeacherEnv>().get("/content", (c) => {
    return c.json({ ok: true, data: getContentTree(db) });
  });
}
