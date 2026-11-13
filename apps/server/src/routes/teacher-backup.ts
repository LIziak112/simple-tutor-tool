import { Readable } from "node:stream";
import { BACKUP_MAX_UPLOAD_BYTES } from "@tutor/contract";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { assertInstanceBackupOperator } from "../auth/instance-backup-access";
import type { TeacherEnv } from "../auth/require-teacher";
import { getTeacherSession, TEACHER_SESSION_COOKIE } from "../auth/session";
import { getTeacherInfo } from "../auth/teacher-auth-service";
import type { Db, DbHandle } from "../db/client";
import { noStoreAttachmentHeaders } from "../lib/binary-response";
import { HttpError } from "../lib/http-error";
import {
  buildBackupZip,
  listSnapshots,
  restoreFromBackup,
} from "../services/backup-service";

/**
 * 整站备份与恢复路由，限主机指定且有管理员权限的教师会话。
 * 由 teacher.ts 挂在 /api/teacher 之下：
 * - GET  /backup/snapshots：最近快照列表（时间倒序；只列 db 快照，供设置页展示）；
 * - GET  /backup/download：完整备份 zip 文件直出（下载前恒先拍一份当前时刻
 *   db 快照 + blobs + shared + secret.key，排除 backups/ 自身）。文件直出
 *   非统一壳，处理方式同
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
  operatorId: string | undefined,
) {
  return (
    new Hono<TeacherEnv>()
      .use("/backup/*", async (c, next) => {
        assertInstanceBackupOperator(c.var.teacher, operatorId);
        await next();
      })
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
            headers: noStoreAttachmentHeaders("application/zip", zip.filename),
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
        const teacherId = c.var.teacher.id;
        const token = getCookie(c, TEACHER_SESSION_COOKIE);
        const recheckAccess = () => {
          const session = token ? getTeacherSession(db, token) : null;
          const teacher =
            session?.teacherId === teacherId
              ? getTeacherInfo(db, teacherId)
              : null;
          assertInstanceBackupOperator(teacher, operatorId);
        };
        const zipBytes = new Uint8Array(await zip.arrayBuffer());
        recheckAccess();
        const result = await restoreFromBackup(
          dataDir,
          handle,
          teacherId,
          password,
          zipBytes,
          recheckAccess,
        );
        return c.json({ ok: true, data: result });
      })
  );
}
