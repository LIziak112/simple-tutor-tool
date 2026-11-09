import { Hono } from "hono";
import { loadOrCreateSecretKey } from "../config";
import type { Db } from "../db/client";
import {
  createRequirePersonalMcpToken,
  type PersonalMcpEnv,
} from "./personal-auth";
import { createPersonalMcpServer } from "./personal-server";
import { serveStatelessMcpRequest } from "./stateless-transport";
import { createRejectForeignOrigin } from "./student-mount";

/**
 * /mcp/personal 挂载（模块 0）——个人账号的唯一 MCP 端点：与学生 /mcp/student
 * 同形态（Origin 门 → Bearer 鉴权 → stateless Streamable HTTP），差别只在
 * 鉴权闸门（只收个人账号学习者的 token）与实例（教师白名单 + 学生全部工具）。
 * app.ts 挂在 /mcp 与 /mcp/student 之后、静态托管 / SPA 回退之前。
 *
 * 日志纪律：本层不记录任何请求体 / Header（Token 不进日志）。
 */

/** 挂载选项（app.ts 注入面） */
export interface PersonalMcpMountOptions {
  readonly db: Db;
  readonly dataDir: string;
  readonly publicUrl: string;
  readonly specDir?: string | undefined;
}

/** 创建 /mcp/personal 子应用（app.route("/mcp/personal", …) 挂载） */
export function createPersonalMcpRoutes(options: PersonalMcpMountOptions) {
  const rejectForeignOrigin = createRejectForeignOrigin<PersonalMcpEnv>(
    options.publicUrl,
  );
  const requireToken = createRequirePersonalMcpToken(options.db);
  const hmacSecret = loadOrCreateSecretKey(options.dataDir);
  return new Hono<PersonalMcpEnv>()
    .use("*", rejectForeignOrigin)
    .use("*", requireToken)
    .all("/", async (c) => {
      const server = createPersonalMcpServer({
        db: options.db,
        dataDir: options.dataDir,
        publicUrl: options.publicUrl,
        specDir: options.specDir,
        teacherId: c.var.mcpPersonal.teacherId,
        studentId: c.var.mcpPersonal.studentId,
        hmacSecret,
      });
      return serveStatelessMcpRequest(server, c.req.raw);
    });
}
