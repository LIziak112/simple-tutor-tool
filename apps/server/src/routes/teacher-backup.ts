import { Readable } from "node:stream";
import { BACKUP_MAX_UPLOAD_BYTES } from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db, DbHandle } from "../db/client";
import { HttpError } from "../lib/http-error";
import {
  buildBackupZip,
  listSnapshots,
  restoreFromBackup,
} from "../services/backup-service";

/**
 * 教师端备份与恢复路由（T4.5，需教师会话；D20/D21 口径见契约 backup-api.ts），
 * 由 teacher.ts 挂在 /api/teacher 之下：
 * - GET  /backup/snapshots：最近快照列表（时间倒序；只列 db 快照，供设置页展示）；
 * - GET  /backup/download：完整备份 zip 文件直出（最新 db 快照 + blobs + shared +
 *   secret.key，排除 backups/ 自身）。文件直出非统一壳，处理方式同
 *   /export/learning-pack；archiver 流式打包经 Readable.toWeb 转 web 流，
 *   边打包边响应、不整包进内存（blobs 可能很大）；
 * - POST /backup/restore：multipart（zip 文件 + password 登录密码字段，D21 服务端
 *   scrypt 校验）→ 校验结构 → 恢复前自动快照 → 原子替换 DATA_DIR → 重启数据连接
 *   （DbHandle）。恢复是整库操作，多教师同库无域隔离（既定口径，契约注释同源）。
 *
 * 恢复的 body 大小防御（content-length 预检）在 app.ts 路由前置中间件
 * （与笔迹上传同模式）；本路由内再按文件实际大小兜底（chunked 无长度时）。
 */
export function createTeacherBackupRoutes(
  db: Db,
  dataDir: string,
  handle: DbHandle,
) {
  return (
    new Hono<TeacherEnv>()
      // T4.5：最近快照列表（设置页「最近快照」区数据源）
      .get("/backup/snapshots", (c) => {
        return c.json({
          ok: true,
          data: { snapshots: listSnapshots(dataDir) },
        });
      })
      // T4.5：下载完整备份（zip 流式直出；内容随数据变化，禁缓存）
      .get("/backup/download", (_c) => {
        const zip = buildBackupZip(dataDir, db);
        return new Response(
          Readable.toWeb(zip.stream) as unknown as ReadableStream<Uint8Array>,
          {
            status: 200,
            headers: {
              "content-type": "application/zip",
              "cache-control": "no-store",
              "content-disposition": `attachment; filename="${zip.filename}"`,
            },
          },
        );
      })
      // T4.5：从备份 zip 恢复整库（D21：multipart zip + 登录密码）
      .post("/backup/restore", async (c) => {
        const body = await c.req.parseBody();
        const zip = body.zip;
        const password = body.password;
        if (
          !(zip instanceof File) ||
          typeof password !== "string" ||
          password.length === 0
        ) {
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "请求需为 multipart/form-data，且包含 zip 备份文件与 password 密码字段",
          );
        }
        // chunked 传输无 content-length 时由这里兜底（与 ink 上传同口径）
        if (zip.size > BACKUP_MAX_UPLOAD_BYTES) {
          throw new HttpError(
            413,
            "BACKUP_TOO_LARGE",
            "备份文件超过 256 MB 上限，请检查是否选错了文件",
          );
        }
        const result = await restoreFromBackup(
          dataDir,
          handle,
          c.var.teacher.id,
          password,
          new Uint8Array(await zip.arrayBuffer()),
        );
        return c.json({ ok: true, data: result });
      })
  );
}
