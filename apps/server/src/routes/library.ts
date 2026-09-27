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
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { parseJsonBody } from "../lib/http-error";
import {
  batchLibrary,
  createFolder,
  deleteFolder,
  exportLectureMd,
  exportUnitMd,
  getLectureUsage,
  getUnitUsage,
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
  type LibraryListFilter,
} from "../services/library-service";

/**
 * 资源库路由（需教师会话，T2A.2），由 teacher.ts 挂在 /api/teacher 之下：
 * - 文件夹（D2）：GET/POST /library/folders、PATCH/DELETE /library/folders/:id、
 *   POST /library/folders/reorder；
 * - 列表：GET /library/lectures、/library/units（folderId/q/deleted 查询参数，
 *   folderId="none" = 未归类）；
 * - 单元：PATCH /units/:id（元数据）、DELETE /units/:id（软删）、
 *   POST /units/:id/restore、DELETE /units/:id/purge（D3 条件 409 RESOURCE_IN_USE）、
 *   GET /units/:id/usage、GET /units/:id/export.md；
 * - 讲义：PATCH /lectures/:id（移动文件夹）、POST /lectures/:id/restore、
 *   DELETE /lectures/:id/purge、GET /lectures/:id/usage、GET /lectures/:id/export.md；
 * - 批量：POST /library/batch（move/delete/restore/addToCourse）。
 *
 * export.md 为文件直出（text/markdown 附件，非 { ok, data } 统一壳；处理方式同
 * /api/public/spec 的原文直出），文件名经 RFC 5987 编码支持中文。
 * 业务逻辑在 LibraryService（api-endpoint 技能约定：路由只做鉴权→校验→调 service→包装）。
 */
export function createLibraryRoutes(db: Db) {
  return new Hono<TeacherEnv>()
    // ---------- 文件夹 ----------
    .get("/library/folders", (c) => {
      return c.json({ ok: true, data: { folders: listFolders(db) } });
    })
    .post("/library/folders", async (c) => {
      const body: LibraryFolderCreate = await parseJsonBody(
        c,
        libraryFolderCreateSchema,
      );
      return c.json({ ok: true, data: createFolder(db, body) }, 201);
    })
    .post("/library/folders/reorder", async (c) => {
      const body: LibraryFolderReorder = await parseJsonBody(
        c,
        libraryFolderReorderSchema,
      );
      reorderFolders(db, body.ids);
      return c.json({ ok: true, data: null });
    })
    .patch("/library/folders/:id", async (c) => {
      const body: LibraryFolderUpdate = await parseJsonBody(
        c,
        libraryFolderUpdateSchema,
      );
      return c.json({
        ok: true,
        data: renameFolder(db, c.req.param("id"), body),
      });
    })
    .delete("/library/folders/:id", (c) => {
      return c.json({ ok: true, data: deleteFolder(db, c.req.param("id")) });
    })
    // ---------- 列表（讲义库 / 题库 / 回收站） ----------
    .get("/library/lectures", (c) => {
      const filter = parseListQuery(c.req.query());
      return c.json({
        ok: true,
        data: { lectures: listLibraryLectures(db, filter) },
      });
    })
    .get("/library/units", (c) => {
      const filter = parseListQuery(c.req.query());
      return c.json({ ok: true, data: { units: listLibraryUnits(db, filter) } });
    })
    // ---------- 批量操作 ----------
    .post("/library/batch", async (c) => {
      const body: LibraryBatchRequest = await parseJsonBody(
        c,
        libraryBatchRequestSchema,
      );
      return c.json({ ok: true, data: batchLibrary(db, body) });
    })
    // ---------- 单元管理 ----------
    .patch("/units/:id", async (c) => {
      const body: UnitMetaUpdate = await parseJsonBody(c, unitMetaUpdateSchema);
      return c.json({
        ok: true,
        data: updateUnitMeta(db, c.req.param("id"), body),
      });
    })
    .delete("/units/:id", (c) => {
      softDeleteUnit(db, c.req.param("id"));
      return c.json({ ok: true, data: null });
    })
    .post("/units/:id/restore", (c) => {
      restoreUnit(db, c.req.param("id"));
      return c.json({ ok: true, data: null });
    })
    .delete("/units/:id/purge", (c) => {
      purgeUnit(db, c.req.param("id"));
      return c.json({ ok: true, data: null });
    })
    .get("/units/:id/usage", (c) => {
      return c.json({ ok: true, data: getUnitUsage(db, c.req.param("id")) });
    })
    .get("/units/:id/export.md", (c) => {
      const { markdown, filename } = exportUnitMd(db, c.req.param("id"));
      return markdownResponse(markdown, filename);
    })
    // ---------- 讲义管理 ----------
    .patch("/lectures/:id", async (c) => {
      const body: LectureMetaUpdate = await parseJsonBody(
        c,
        lectureMetaUpdateSchema,
      );
      return c.json({
        ok: true,
        data: updateLectureFolder(db, c.req.param("id"), body),
      });
    })
    .post("/lectures/:id/restore", (c) => {
      restoreLecture(db, c.req.param("id"));
      return c.json({ ok: true, data: null });
    })
    .delete("/lectures/:id/purge", (c) => {
      purgeLecture(db, c.req.param("id"));
      return c.json({ ok: true, data: null });
    })
    .get("/lectures/:id/usage", (c) => {
      return c.json({ ok: true, data: getLectureUsage(db, c.req.param("id")) });
    })
    .get("/lectures/:id/export.md", (c) => {
      const { markdown, filename } = exportLectureMd(db, c.req.param("id"));
      return markdownResponse(markdown, filename);
    });
}

/** 查询参数 → 列表筛选条件（folderId="none" = 未归类；q 原样透传） */
function parseListQuery(query: Record<string, string | undefined>): LibraryListFilter {
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
      "content-disposition": `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}

/** filename 的 ASCII 兜底（RFC 6266：不支持 filename* 的旧客户端用） */
function asciiFallback(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
  return ascii.length > 0 ? ascii.replace(/"/g, "_") : "export.md";
}
