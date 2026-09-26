import type {
  CourseCreateRequest,
  CourseUpdateRequest,
  LectureUpdateRequest,
  QuestionUpdateRequest,
  ReorderRequest,
} from "@tutor/contract";
import {
  courseCreateRequestSchema,
  courseUpdateRequestSchema,
  lectureUpdateRequestSchema,
  questionUpdateRequestSchema,
  reorderRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { parseJsonBody } from "../lib/http-error";
import {
  createCourse,
  deleteCourse,
  deleteLecture,
  deleteQuestion,
  getContentTree,
  getLectureDetail,
  getQuestionDetail,
  reorderContent,
  updateCourse,
  updateLecture,
  updateQuestion,
} from "../services/content-service";

/**
 * 内容管理路由（需教师会话），由 teacher.ts 挂在 /api/teacher 之下：
 * - GET    /content：内容树（T1.11）；
 * - GET    /questions/:id、PUT /questions/:id、DELETE /questions/:id：
 *   单题完整内容 / 单题编辑（重新解析，version+1）/ 软删（T1.12）；
 * - GET    /lectures/:id、PUT /lectures/:id、DELETE /lectures/:id：
 *   讲义完整内容 / 整篇编辑（title 从 H1 重取）/ 物理删除（T1.12）；
 * - POST   /reorder：拖拽排序，order 按 ids 下标重写（T1.12）；
 * - POST   /courses、PATCH /courses/:id、DELETE /courses/:id：课程 CRUD（T1.12）。
 *
 * 业务逻辑在 ContentService（api-endpoint 技能约定：路由只做鉴权→校验→调 service→包装）。
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型（AppType / hc 前提）。
 * 删除接口返回 { ok: true, data: null }（统一壳，前端 callApi 直接解包）。
 */
export function createContentRoutes(db: Db) {
  return new Hono<TeacherEnv>()
    .get("/content", (c) => {
      return c.json({ ok: true, data: getContentTree(db) });
    })
    .get("/questions/:id", (c) => {
      return c.json({
        ok: true,
        data: getQuestionDetail(db, c.req.param("id")),
      });
    })
    .put("/questions/:id", async (c) => {
      const body: QuestionUpdateRequest = await parseJsonBody(
        c,
        questionUpdateRequestSchema,
      );
      return c.json({
        ok: true,
        data: updateQuestion(db, c.req.param("id"), body),
      });
    })
    .delete("/questions/:id", (c) => {
      deleteQuestion(db, c.req.param("id"));
      return c.json({ ok: true, data: null });
    })
    .get("/lectures/:id", (c) => {
      return c.json({
        ok: true,
        data: getLectureDetail(db, c.req.param("id")),
      });
    })
    .put("/lectures/:id", async (c) => {
      const body: LectureUpdateRequest = await parseJsonBody(
        c,
        lectureUpdateRequestSchema,
      );
      return c.json({
        ok: true,
        data: updateLecture(db, c.req.param("id"), body),
      });
    })
    .delete("/lectures/:id", (c) => {
      deleteLecture(db, c.req.param("id"));
      return c.json({ ok: true, data: null });
    })
    .post("/reorder", async (c) => {
      const body: ReorderRequest = await parseJsonBody(c, reorderRequestSchema);
      reorderContent(db, body);
      return c.json({ ok: true, data: null });
    })
    .post("/courses", async (c) => {
      const body: CourseCreateRequest = await parseJsonBody(
        c,
        courseCreateRequestSchema,
      );
      return c.json({ ok: true, data: createCourse(db, body) }, 201);
    })
    .patch("/courses/:id", async (c) => {
      const body: CourseUpdateRequest = await parseJsonBody(
        c,
        courseUpdateRequestSchema,
      );
      return c.json({
        ok: true,
        data: updateCourse(db, c.req.param("id"), body),
      });
    })
    .delete("/courses/:id", (c) => {
      deleteCourse(db, c.req.param("id"));
      return c.json({ ok: true, data: null });
    });
}
