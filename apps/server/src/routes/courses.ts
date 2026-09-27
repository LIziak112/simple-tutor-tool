import type {
  CourseItemsAddRequest,
  CourseItemsReorderRequest,
  CourseItemUpdateRequest,
  CourseListQuery,
  CourseMembersRequest,
} from "@tutor/contract";
import {
  courseItemsAddRequestSchema,
  courseItemUpdateRequestSchema,
  courseItemsReorderRequestSchema,
  courseListQuerySchema,
  courseMembersRequestSchema,
  courseStudentViewQuerySchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody } from "../lib/http-error";
import {
  addCourseMembers,
  appendCourseItems,
  deleteCourseItem,
  getCourseDetail,
  getStudentView,
  listCoursesForTeacher,
  removeCourseMembers,
  reorderCourseItems,
  updateCourseItem,
} from "../services/course-service";

/**
 * 课程编辑页路由（需教师会话，T2A.4），由 teacher.ts 挂在 /api/teacher 之下：
 * - GET    /courses?archived：课程列表（成员数、条目数、可见条目数、memberIds、
 *   hasAttempts；archived=true 只列已归档，缺省只列未归档，D4）；
 * - GET    /courses/:id：课程详情（目录条目含资源摘要与状态标签数据 + 成员列表）；
 * - POST   /courses/:id/items：批量追加目录条目（重复跳过并返回清单，D6；
 *   withCompanionUnits 一并添加配套练习，D8）；
 * - PUT    /courses/:id/items/order：目录排序（ids 全量重排，order 按下标）；
 * - PATCH  /course-items/:id：条目可见开关 / 定时发布 / 分节改名；
 * - DELETE /course-items/:id：从课程目录移除条目（不动资源库）；
 * - POST/DELETE /courses/:id/members：成员添加 / 移出（D7）；
 * - GET    /courses/:id/student-view：学生可见预览（按 D5 过滤的成员可见目录，§4-10）。
 *
 * 课程本体的 POST/PATCH/DELETE /courses(:id) 在 content.ts（T1.12 起；PATCH 已扩展
 * name/description/archived，DELETE 按 D4 升级为「有作答 409 COURSE_HAS_ATTEMPTS」）。
 * 业务逻辑在 CourseService（api-endpoint 技能约定：路由只做鉴权→校验→调 service→包装）。
 */
export function createCourseRoutes(db: Db) {
  return (
    new Hono<TeacherEnv>()
      .get("/courses", (c) => {
        // GET 无 JSON body：查询参数手工过契约 schema（stringbool 解析 "true"/"false"）
        const parsed = courseListQuerySchema.safeParse({
          archived: c.req.query("archived") ?? undefined,
        });
        if (!parsed.success) {
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "查询参数不合法：archived 只能是 true 或 false",
          );
        }
        const query: CourseListQuery = parsed.data;
        return c.json({
          ok: true,
          data: {
            courses: listCoursesForTeacher(db, {
              archived: query.archived ?? false,
            }),
          },
        });
      })
      .get("/courses/:id", (c) => {
        return c.json({
          ok: true,
          data: getCourseDetail(db, c.req.param("id")),
        });
      })
      .get("/courses/:id/student-view", (c) => {
        const parsed = courseStudentViewQuerySchema.safeParse({
          studentId: c.req.query("studentId") ?? undefined,
        });
        if (!parsed.success) {
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "查询参数不合法：studentId 必须是 UUID（选择一位成员进行预览）",
          );
        }
        return c.json({
          ok: true,
          data: getStudentView(
            db,
            c.req.param("id"),
            parsed.data.studentId,
          ),
        });
      })
      .post("/courses/:id/items", async (c) => {
        const body: CourseItemsAddRequest = await parseJsonBody(
          c,
          courseItemsAddRequestSchema,
        );
        return c.json(
          {
            ok: true,
            data: appendCourseItems(db, c.req.param("id"), body.items, {
              visible: body.visible,
              withCompanionUnits: body.withCompanionUnits,
            }),
          },
          201,
        );
      })
      .put("/courses/:id/items/order", async (c) => {
        const body: CourseItemsReorderRequest = await parseJsonBody(
          c,
          courseItemsReorderRequestSchema,
        );
        reorderCourseItems(db, c.req.param("id"), body.ids);
        return c.json({ ok: true, data: null });
      })
      .post("/courses/:id/members", async (c) => {
        const body: CourseMembersRequest = await parseJsonBody(
          c,
          courseMembersRequestSchema,
        );
        addCourseMembers(db, c.req.param("id"), body.studentIds);
        return c.json({ ok: true, data: null });
      })
      .delete("/courses/:id/members", async (c) => {
        const body: CourseMembersRequest = await parseJsonBody(
          c,
          courseMembersRequestSchema,
        );
        removeCourseMembers(db, c.req.param("id"), body.studentIds);
        return c.json({ ok: true, data: null });
      })
      .patch("/course-items/:id", async (c) => {
        const body: CourseItemUpdateRequest = await parseJsonBody(
          c,
          courseItemUpdateRequestSchema,
        );
        // 服务层返回原始行；响应需要含状态标签数据 → 经详情组装路径重取该课程
        const updated = updateCourseItem(db, c.req.param("id"), body);
        const detail = getCourseDetail(db, updated.courseId);
        const item = detail.items.find((entry) => entry.id === updated.id);
        if (item === undefined) {
          // 理论不可达（刚更新过的条目必在详情里）；防御性兜底
          throw new HttpError(404, "COURSE_ITEM_NOT_FOUND", "目录条目不存在");
        }
        return c.json({ ok: true, data: item });
      })
      .delete("/course-items/:id", (c) => {
        deleteCourseItem(db, c.req.param("id"));
        return c.json({ ok: true, data: null });
      })
  );
}
