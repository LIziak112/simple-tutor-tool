import { learningPackExportRequestSchema } from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { noStoreBinaryResponse } from "../lib/binary-response";
import { parseJsonBody } from "../lib/http-error";
import {
  buildLearningPackZip,
  previewLearningPack,
} from "../services/export-service";

/**
 * 教师端学情数据包导出路由（T4.3，需教师会话），由 teacher.ts 挂在
 * /api/teacher 之下（D14–D19；导出向导前端是 T4.4）：
 * - POST /export/learning-pack/preview：文件清单 + 预估大小 + 超限标志
 *   （向导第⑤步数据源；超限不报错，由前端据 overLimit 提示精简）；
 * - POST /export/learning-pack：返回 zip 流（application/zip +
 *   Content-Disposition 附件文件名 learning-pack-<北京时间戳>.zip，文件直出
 *   非 { ok, data } 统一壳，处理方式同 /export/csv）。超限 → 413
 *   EXPORT_TOO_LARGE（统一错误壳，中文说明含精简方向）。
 * 两接口共用 learningPackExportRequestSchema 请求体；业务与域校验全部在
 * export-service（范围 id 逐个域校验 404，不暴露存在性）。
 *
 * 路由只做「鉴权（teacher.ts 整组 requireTeacher）→ 校验 → 调 service →
 * 包装响应」（api-endpoint 技能约定）。返回类型不显式标注 Hono：链式注册把
 * 路由签名累积进推断类型（AppType 前提）。
 */
export function createTeacherExportRoutes(db: Db, dataDir: string) {
  return (
    new Hono<TeacherEnv>()
      // T4.3（D14⑤/D18）：预览——清单 + 预估字节数 + 超限标志（不报错）
      .post("/export/learning-pack/preview", async (c) => {
        const req = await parseJsonBody(c, learningPackExportRequestSchema);
        return c.json({
          ok: true,
          data: previewLearningPack(db, dataDir, c.var.teacher.id, req),
        });
      })
      // T4.3（D18）：生成 zip 文件直出；导出内容随批改变化，禁缓存
      .post("/export/learning-pack", async (c) => {
        const req = await parseJsonBody(c, learningPackExportRequestSchema);
        const zip = await buildLearningPackZip(
          db,
          dataDir,
          c.var.teacher.id,
          req,
        );
        return noStoreBinaryResponse(zip.bytes, "application/zip", {
          attachmentFilename: zip.filename,
        });
      })
  );
}
