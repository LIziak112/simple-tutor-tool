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
 * - GET    /content：内容树（T1.11；T2A.1 起从 course_items 组装，形状不变）；
 * - GET    /questions/:id、PUT /questions/:id、DELETE /questions/:id：
 *   单题完整内容 / 单题编辑（重新解析，version+1）/ 软删（T1.12）；
 * - GET    /lectures/:id、PUT /lectures/:id、DELETE /lectures/:id：
 *   讲义完整内容 / 整篇编辑（title 从 H1 重取）/ 软删（T2A.1 起改软删，D3）；
 *   以上题目/讲义接口自 T2B.3 起按会话教师（c.var.teacher.id）过滤，越权 → 404；
 * - POST   /reorder：拖拽排序，order 按 ids 下标重写（T1.12；题目/讲义/单元域内）；
 * - POST   /courses、PATCH /courses/:id、DELETE /courses/:id：课程 CRUD（T1.12；
 *   T2A.4 起 PATCH 接受 name（同 title）/description/archived，DELETE 改按 D4——
 *   有作答记录 409 COURSE_HAS_ATTEMPTS，无作答连目录条目与成员一并清理；
 *   T2B.4 起按会话教师 c.var.teacher.id——乙访问甲的课程 → 404）。
 *   GET /courses、GET /courses/:id 及课程目录/成员路由在 courses.ts（T2A.4）。
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
        data: getQuestionDetail(db, c.var.teacher.id, c.req.param("id")),
      });
    })
    .put("/questions/:id", async (c) => {
      const body: QuestionUpdateRequest = await parseJsonBody(
        c,
        questionUpdateRequestSchema,
      );
      return c.json({
        ok: true,
        data: updateQuestion(db, c.var.teacher.id, c.req.param("id"), body),
      });
    })
    .delete("/questions/:id", (c) => {
      deleteQuestion(db, c.var.teacher.id, c.req.param("id"));
      return c.json({ ok: true, data: null });
    })
    .get("/lectures/:id", (c) => {
      return c.json({
        ok: true,
        data: getLectureDetail(db, c.var.teacher.id, c.req.param("id")),
      });
    })
    .put("/lectures/:id", async (c) => {
      const body: LectureUpdateRequest = await parseJsonBody(
        c,
        lectureUpdateRequestSchema,
      );
      return c.json({
        ok: true,
        data: updateLecture(db, c.var.teacher.id, c.req.param("id"), body),
      });
    })
    .delete("/lectures/:id", (c) => {
      deleteLecture(db, c.var.teacher.id, c.req.param("id"));
      return c.json({ ok: true, data: null });
    })
    .post("/reorder", async (c) => {
      const body: ReorderRequest = await parseJsonBody(c, reorderRequestSchema);
      reorderContent(db, c.var.teacher.id, body);
      return c.json({ ok: true, data: null });
    })
    .post("/courses", async (c) => {
      const body: CourseCreateRequest = await parseJsonBody(
        c,
        courseCreateRequestSchema,
      );
      return c.json(
        { ok: true, data: createCourse(db, c.var.teacher.id, body) },
        201,
      );
    })
    .patch("/courses/:id", async (c) => {
      const body: CourseUpdateRequest = await parseJsonBody(
        c,
        courseUpdateRequestSchema,
      );
      return c.json({
        ok: true,
        data: updateCourse(db, c.var.teacher.id, c.req.param("id"), body),
      });
    })
    .delete("/courses/:id", (c) => {
      deleteCourse(db, c.var.teacher.id, c.req.param("id"));
      return c.json({ ok: true, data: null });
    });
}
