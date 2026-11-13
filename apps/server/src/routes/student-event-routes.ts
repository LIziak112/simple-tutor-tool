import {
  attemptEventBatchRequestSchema,
  lectureEventBatchRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody } from "../lib/http-error";
import {
  appendAttemptEvents,
  appendLectureEvents,
} from "../services/event-service";

function deliver<T>(receive: () => T): T {
  try {
    return receive();
  } catch (error) {
    // 区分真实失权与回退到旧服务端时路由不存在。
    if (error instanceof HttpError && error.status === 404)
      throw new HttpError(404, "EVENT_TARGET_UNAVAILABLE", error.message);
    throw error;
  }
}

export function createStudentEventRoutes(db: Db) {
  return new Hono<StudentEnv>()
    .post("/attempts/:id/events", async (c) => {
      const { events, viewId } = await parseJsonBody(
        c,
        attemptEventBatchRequestSchema,
      );
      return c.json({
        ok: true,
        data: appendAttemptEvents(
          db,
          c.var.student.id,
          c.req.param("id"),
          events,
          viewId,
        ),
      });
    })
    .post("/events", async (c) => {
      const { events } = await parseJsonBody(c, lectureEventBatchRequestSchema);
      return c.json({
        ok: true,
        data: appendLectureEvents(db, c.var.student.id, events),
      });
    })
    .post("/attempts/:id/events/deliver", async (c) => {
      const { events, viewId, delivery } = await parseJsonBody(
        c,
        attemptEventBatchRequestSchema,
      );
      if (!delivery)
        throw new HttpError(
          400,
          "EVENT_DELIVERY_REQUIRED",
          "事件批次缺少回执标识",
        );
      return c.json({
        ok: true,
        data: deliver(() =>
          appendAttemptEvents(
            db,
            c.var.student.id,
            c.req.param("id"),
            events,
            viewId,
            delivery,
          ),
        ),
      });
    })
    .post("/events/deliver", async (c) => {
      const { events, delivery } = await parseJsonBody(
        c,
        lectureEventBatchRequestSchema,
      );
      if (!delivery)
        throw new HttpError(
          400,
          "EVENT_DELIVERY_REQUIRED",
          "事件批次缺少回执标识",
        );
      return c.json({
        ok: true,
        data: deliver(() =>
          appendLectureEvents(db, c.var.student.id, events, delivery),
        ),
      });
    });
}
