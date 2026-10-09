import type {
  LectureMetaUpdate,
  LibraryBatchRequest,
  LibraryFolderCreate,
  LibraryFolderReorder,
  LibraryFolderUpdate,
  LibraryListQuery,
  UnitMetaUpdate,
} from "@tutor/contract";
import {
  lectureMetaUpdateSchema,
  libraryBatchRequestSchema,
  libraryFolderCreateSchema,
  libraryFolderReorderSchema,
  libraryFolderUpdateSchema,
  libraryListQuerySchema,
  unitMetaUpdateSchema,
} from "@tutor/contract";
import { type Context, Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import {
  attachmentDisposition,
  noStoreBinaryResponse,
} from "../lib/binary-response";
import { parseJsonBody } from "../lib/http-error";
import {
  batchLibrary,
  createFolder,
  deleteFolder,
  exportLectureMd,
  exportUnitMd,
  getLectureUsage,
  getUnitUsage,
  type LibraryListFilter,
  listFolders,
  listLibraryLectures,
  listLibraryUnits,
  purgeLecture,
  purgeUnit,
  renameFolder,
  reorderFolders,
  restoreLecture,
  restoreUnit,
  softDeleteUnit,
  updateLectureFolder,
  updateUnitMeta,
} from "../services/library-service";
import { batchPublishToShared } from "../services/shared-service";
import {
  exportTeachingPackZip,
  type TeachingPackKind,
} from "../services/teaching-pack-service";

/**
 * 资源库路由（需教师会话，T2A.2），由 teacher.ts 挂在 /api/teacher 之下：
 * - 文件夹（D2）：GET/POST /library/folders、PATCH/DELETE /library/folders/:id、
 *   POST /library/folders/reorder；
 * - 列表：GET /library/lectures、/library/units（folderId/q/deleted 查询参数，
 *   folderId="none" = 未归类）；
 * - 单元：PATCH /units/:id（元数据）、DELETE /units/:id（软删）、
 *   POST /units/:id/restore、DELETE /units/:id/purge（D3 条件 409 RESOURCE_IN_USE）、
 *   GET /units/:id/usage、GET /units/:id/export.md、GET /units/:id/export-pack.zip
 *   （T7.8 教学包 ZIP：content.md + capabilities-snapshot.json + 随行图片）；
 * - 讲义：PATCH /lectures/:id（移动文件夹）、POST /lectures/:id/restore、
 *   DELETE /lectures/:id/purge、GET /lectures/:id/usage、GET /lectures/:id/export.md、
 *   GET /lectures/:id/export-pack.zip（T7.8，同单元）；
 * - 批量：POST /library/batch（move/delete/restore/addToCourse/publish——
 *   publish 为共享快照批量发布，业务在 shared-service）。
 *
 * export.md 为文件直出（text/markdown 附件，非 { ok, data } 统一壳；处理方式同
 * /api/public/spec 的原文直出），文件名经 RFC 5987 编码支持中文。
 * T2B.3 起全部接口按会话教师（c.var.teacher.id）过滤与写入：乙访问甲的资源 → 404。
 * 业务逻辑在 LibraryService（api-endpoint 技能约定：路由只做鉴权→校验→调 service→包装）。
 */
export function createLibraryRoutes(
  db: Db,
  dataDir: string,
  /** 规范目录覆盖（T7.8 教学包快照与 /api/public/spec 同源；缺省走目录候选） */
  specDir?: string | undefined,
) {
  /**
   * T7.8 教学包 ZIP 导出 handler 工厂（unit/lecture 两端点同构，仅 kind 字面量
   * 不同）；域校验 404 与导出前检查（引用失效 422）都在 service。
   */
  type ExportPackPath =
    | "/units/:id/export-pack.zip"
    | "/lectures/:id/export-pack.zip";
  const exportPackZipHandler = (kind: TeachingPackKind) => {
    return async (c: Context<TeacherEnv, ExportPackPath>) => {
      const zip = await exportTeachingPackZip(
        db,
        c.var.teacher.id,
        kind,
        c.req.param("id"),
        dataDir,
        specDir,
      );
      return noStoreBinaryResponse(zip.bytes, "application/zip", {
        attachmentFilename: zip.filename,
      });
    };
  };

  return (
    new Hono<TeacherEnv>()
      // ---------- 文件夹 ----------
      .get("/library/folders", (c) => {
        return c.json({
          ok: true,
          data: { folders: listFolders(db, c.var.teacher.id) },
        });
      })
      .post("/library/folders", async (c) => {
        const body: LibraryFolderCreate = await parseJsonBody(
          c,
          libraryFolderCreateSchema,
        );
        return c.json(
          { ok: true, data: createFolder(db, c.var.teacher.id, body) },
          201,
        );
      })
      .post("/library/folders/reorder", async (c) => {
        const body: LibraryFolderReorder = await parseJsonBody(
          c,
          libraryFolderReorderSchema,
        );
        reorderFolders(db, c.var.teacher.id, body.ids);
        return c.json({ ok: true, data: null });
      })
      .patch("/library/folders/:id", async (c) => {
        const body: LibraryFolderUpdate = await parseJsonBody(
          c,
          libraryFolderUpdateSchema,
        );
        return c.json({
          ok: true,
          data: renameFolder(db, c.var.teacher.id, c.req.param("id"), body),
        });
      })
      .delete("/library/folders/:id", (c) => {
        return c.json({
          ok: true,
          data: deleteFolder(db, c.var.teacher.id, c.req.param("id")),
        });
      })
      // ---------- 列表（讲义库 / 题库 / 回收站） ----------
      .get("/library/lectures", (c) => {
        const filter = parseListQuery(c.req.query());
        return c.json({
          ok: true,
          data: { lectures: listLibraryLectures(db, c.var.teacher.id, filter) },
        });
      })
      .get("/library/units", (c) => {
        const filter = parseListQuery(c.req.query());
        return c.json({
          ok: true,
          data: { units: listLibraryUnits(db, c.var.teacher.id, filter) },
        });
      })
      // ---------- 批量操作 ----------
      .post("/library/batch", async (c) => {
        const body: LibraryBatchRequest = await parseJsonBody(
          c,
          libraryBatchRequestSchema,
        );
        // publish 是共享目录写入（业务在 shared-service 单点；library-service
        // 不 import shared-service，避免与其导出依赖形成循环），结果形状一致
        const data =
          body.action === "publish"
            ? batchPublishToShared(
                db,
                dataDir,
                c.var.teacher.id,
                c.var.teacher.loginName,
                {
                  kind: body.kind,
                  ids: body.ids,
                },
              )
            : batchLibrary(db, c.var.teacher.id, body);
        return c.json({ ok: true, data });
      })
      // ---------- 单元管理 ----------
      .patch("/units/:id", async (c) => {
        const body: UnitMetaUpdate = await parseJsonBody(
          c,
          unitMetaUpdateSchema,
        );
        return c.json({
          ok: true,
          data: updateUnitMeta(db, c.var.teacher.id, c.req.param("id"), body),
        });
      })
      .delete("/units/:id", (c) => {
        softDeleteUnit(db, c.var.teacher.id, c.req.param("id"));
        return c.json({ ok: true, data: null });
      })
      .post("/units/:id/restore", (c) => {
        restoreUnit(db, c.var.teacher.id, c.req.param("id"));
        return c.json({ ok: true, data: null });
      })
      .delete("/units/:id/purge", (c) => {
        purgeUnit(db, c.var.teacher.id, c.req.param("id"));
        return c.json({ ok: true, data: null });
      })
      .get("/units/:id/usage", (c) => {
        return c.json({
          ok: true,
          data: getUnitUsage(db, c.var.teacher.id, c.req.param("id")),
        });
      })
      .get("/units/:id/export.md", (c) => {
        const { markdown, filename } = exportUnitMd(
          db,
          c.var.teacher.id,
          c.req.param("id"),
        );
        return markdownResponse(markdown, filename);
      })
      // T7.8：导出教学包（ZIP 文件直出；导出前检查声明引用，失效 422 不生成包；
      // 文件名可含中文 → RFC 5987 编码，同 export.md 口径）
      .get("/units/:id/export-pack.zip", exportPackZipHandler("unit"))
      // ---------- 讲义管理 ----------
      .patch("/lectures/:id", async (c) => {
        const body: LectureMetaUpdate = await parseJsonBody(
          c,
          lectureMetaUpdateSchema,
        );
        return c.json({
          ok: true,
          data: updateLectureFolder(
            db,
            c.var.teacher.id,
            c.req.param("id"),
            body,
          ),
        });
      })
      .post("/lectures/:id/restore", (c) => {
        restoreLecture(db, c.var.teacher.id, c.req.param("id"));
        return c.json({ ok: true, data: null });
      })
      .delete("/lectures/:id/purge", (c) => {
        purgeLecture(db, c.var.teacher.id, c.req.param("id"));
        return c.json({ ok: true, data: null });
      })
      .get("/lectures/:id/usage", (c) => {
        return c.json({
          ok: true,
          data: getLectureUsage(db, c.var.teacher.id, c.req.param("id")),
        });
      })
      .get("/lectures/:id/export.md", (c) => {
        const { markdown, filename } = exportLectureMd(
          db,
          c.var.teacher.id,
          c.req.param("id"),
        );
        return markdownResponse(markdown, filename);
      })
      // T7.8：导出教学包（同单元端点，kind=lecture）
      .get("/lectures/:id/export-pack.zip", exportPackZipHandler("lecture"))
  );
}

/** 查询参数 → 列表筛选条件（folderId="none" = 未归类；q 原样透传） */
function parseListQuery(
  query: Record<string, string | undefined>,
): LibraryListFilter {
  const parsed: LibraryListQuery = libraryListQuerySchema.parse(
    Object.fromEntries(
      Object.entries(query).filter(([, value]) => value !== undefined),
    ),
  );
  return {
    folderId:
      parsed.folderId === undefined
        ? undefined
        : parsed.folderId === "none"
          ? null
          : parsed.folderId,
    q: parsed.q,
    deleted: parsed.deleted === "1",
  };
}

/** markdown 文件直出（text/markdown 附件；filename 经 RFC 5987 编码支持中文标题） */
function markdownResponse(markdown: string, filename: string): Response {
  return new Response(markdown, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // 导出内容随资源编辑变化，禁缓存避免「导出旧版本」
      "cache-control": "no-store",
      "content-disposition": attachmentDisposition(filename),
    },
  });
}
