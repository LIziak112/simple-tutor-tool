import {
  type AiMcpCurrentContext,
  questionFocusEventSchema,
} from "@tutor/contract";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { aiTasks, events } from "../../db/schema";
import { HttpError } from "../../lib/http-error";
import { sqliteAiPolicyConfigSource } from "./ai-policy-config-source";
import { isMcpLiveContextEnabled } from "./connection-service";
import { resolveAttemptQuestionAiPolicy } from "./teaching-policy-service";

const FOCUS_TTL_MS = 60_000;
const MAX_DELIVERY_DELAY_MS = 15_000;
const CLOCK_LEAD_MS = 5_000;
const EVENT_LIMIT = 512;
const eventView = questionFocusEventSchema.pick({ viewId: true }).required();
const noCurrent = { status: "no_current_question" } as const;

export function getStudentMcpCurrentContext(
  db: Db,
  studentId: string,
  connectionId: string,
): AiMcpCurrentContext {
  if (!isMcpLiveContextEnabled(db, studentId, connectionId)) {
    return { status: "disabled" };
  }
  const now = Date.now();
  const rows = db
    .select({
      attemptId: events.attemptId,
      questionId: events.questionId,
      type: events.type,
      clientTs: events.clientTs,
      serverTs: events.serverTs,
      payloadJson: events.payloadJson,
    })
    .from(events)
    .where(
      and(
        eq(events.studentId, studentId),
        isNull(events.lectureId),
        gte(events.clientTs, now - FOCUS_TTL_MS),
        inArray(events.type, [
          "question_focus",
          "question_blur",
          "page_hidden",
          "page_visible",
        ]),
      ),
    )
    .orderBy(desc(events.clientTs))
    .limit(EVENT_LIMIT + 1)
    .all();
  if (rows.length > EVENT_LIMIT) return noCurrent;

  const views = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.attemptId === null) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson);
    } catch {
      return noCurrent;
    }
    const view = eventView.safeParse(payload);
    if (!view.success) continue;
    const key = JSON.stringify([row.attemptId, view.data.viewId]);
    const timeline = views.get(key);
    if (timeline === undefined) views.set(key, [row]);
    else timeline.push(row);
  }

  let current: { attemptId: string; questionId: string } | undefined;
  for (const timeline of views.values()) {
    const focus = timeline.find((row) => row.type === "question_focus");
    if (focus?.attemptId == null || focus.questionId === null) continue;
    const delay = Date.parse(focus.serverTs) - focus.clientTs;
    if (
      focus.clientTs > now + CLOCK_LEAD_MS ||
      !(delay >= -CLOCK_LEAD_MS && delay <= MAX_DELIVERY_DELAY_MS)
    )
      continue;
    const latestVisible = timeline.find((row) => row.type === "page_visible");
    const latestHidden = timeline.find((row) => row.type === "page_hidden");
    // 恢复可见后也须有新的焦点，避免把后台期间的旧题重新交给 Agent。
    if (
      (latestVisible !== undefined &&
        latestVisible.clientTs >= focus.clientTs) ||
      (latestHidden !== undefined &&
        latestHidden.clientTs >= (latestVisible?.clientTs ?? 0))
    )
      continue;
    if (
      timeline.some(
        (row) =>
          row.clientTs >= focus.clientTs &&
          row.type === "question_blur" &&
          row.questionId === focus.questionId,
      )
    )
      continue;
    if (
      timeline.some(
        (row) =>
          row.clientTs === focus.clientTs &&
          row.type === "question_focus" &&
          row.questionId !== focus.questionId,
      )
    ) {
      return noCurrent;
    }
    if (
      current !== undefined &&
      (current.attemptId !== focus.attemptId ||
        current.questionId !== focus.questionId)
    ) {
      return noCurrent;
    }
    current = { attemptId: focus.attemptId, questionId: focus.questionId };
  }
  if (current === undefined) return noCurrent;

  try {
    const { resolution, attempt } = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      current.attemptId,
      current.questionId,
      sqliteAiPolicyConfigSource,
    );
    if (!resolution.usable || attempt.status !== "draft") return noCurrent;
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return noCurrent;
  }

  // 页面焦点仅用于定位。只有学生显式加入 MCP 队列才产生可领取的授权任务。
  const task = db
    .select({ id: aiTasks.id })
    .from(aiTasks)
    .where(
      and(
        eq(aiTasks.studentId, studentId),
        eq(aiTasks.attemptId, current.attemptId),
        eq(aiTasks.questionId, current.questionId),
        eq(aiTasks.channel, "mcp"),
        eq(aiTasks.status, "created"),
        isNull(aiTasks.cancelRequestedAt),
      ),
    )
    .orderBy(desc(aiTasks.createdAt), desc(aiTasks.id))
    .get();
  return task === undefined
    ? { status: "student_action_required" }
    : { status: "authorized_task", taskId: task.id };
}
