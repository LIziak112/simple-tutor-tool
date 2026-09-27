import { randomUUID } from "node:crypto";
import type {
  AttemptEvent,
  LearningEventBatchData,
  LectureEvent,
} from "@tutor/contract";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { events, lectures, type NewEventRow } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { requireOwnAttempt } from "./attempt-service";

/**
 * EventService（T2.10）——学习痕迹事件的写入与读取（架构文档 §5.2/§5.5）。
 * 路由只做「鉴权 → 校验 → 调 service → 包装响应」，本模块承载：
 *
 * - appendAttemptEvents：本人 attempt 的批量事件追加（≤200 由契约拦截）；
 * - appendLectureEvents：讲义展开事件（lecture_expand，无 attempt 上下文）追加；
 * - recordHintOpenEvent：hint_open 事件服务端直记（T2.11 分步提示接口内部调用）；
 * - attemptTimeline：交卷计算用——按 clientTs 升序取该 attempt 的全部事件
 *   投影（type/clientTs/questionId），供 active-time 纯函数消费。
 *
 * 口径说明：
 * - **已交后仍接收事件（宽松口径）**：交卷瞬间的前台 flush 与 sendBeacon 可能
 *   晚于 POST submit 到达，拒绝会丢「交卷前最后一段」数据；因此只校验本人
 *   attempt（draft/submitted 均收），入库不影响已计算的 activeSec（submit 是
 *   计算截止事件，迟到事件在 computePerQuestionActiveSec 里天然被忽略）；
 * - **追加写**：本服务只 INSERT，永不 UPDATE/DELETE（events 表语义）；
 * - **泄露红线**：事件 payload 只存元信息（契约层保证），响应只回 accepted 计数。
 */

/** 事件行 → { events: [...] }（逐条校验后的合法输入）批量插入，返回落库条数 */
function insertEvents(
  db: Db,
  rows: readonly NewEventRow[],
): LearningEventBatchData {
  const now = new Date().toISOString();
  db.insert(events)
    .values(
      rows.map((row) => ({
        ...row,
        id: randomUUID(),
        serverTs: now,
      })),
    )
    .run();
  return { accepted: rows.length };
}

/**
 * 批量追加 attempt 上下文事件（POST /api/student/attempts/:id/events）：
 * - attempt 不存在 → 404；非本人 → 403（requireOwnAttempt 统一口径）；
 * - draft / submitted / graded 均接收（宽松口径，见文件头）；
 * - questionId 不做归属校验：事件是学生自己的元数据，乱 id 只影响其本人统计，
 *   且草稿期被软删题的迟到事件仍应可落库（对应作答历史的一部分）。
 */
export function appendAttemptEvents(
  db: Db,
  studentId: string,
  attemptId: string,
  batch: readonly AttemptEvent[],
): LearningEventBatchData {
  requireOwnAttempt(db, studentId, attemptId);
  return insertEvents(
    db,
    batch.map((event) => attemptEventRow(event, attemptId)),
  );
}

/**
 * 批量追加无 attempt 上下文事件（POST /api/student/events，目前只有 lecture_expand）：
 * 讲义不存在 → 404 LECTURE_NOT_FOUND（与 GET 讲义同口径）。
 * events 表该类行 attemptId/questionId 均为 NULL，归属在 payloadJson。
 * 注意：events 表按 §5.2 无学生列，讲义事件暂无学生归属（见任务报告待决问题）。
 */
export function appendLectureEvents(
  db: Db,
  _studentId: string,
  batch: readonly LectureEvent[],
): LearningEventBatchData {
  // 讲义可见性校验（一对一场景学生可见全部讲义，T2.3 口径；这里只验存在——
  // T2A.1 起讲义软删，已删讲义按不存在处理，D3 窗口期过滤）
  for (const event of batch) {
    const row = db
      .select({ id: lectures.id })
      .from(lectures)
      .where(and(eq(lectures.id, event.lectureId), isNull(lectures.deletedAt)))
      .get();
    if (row === undefined) {
      throw new HttpError(404, "LECTURE_NOT_FOUND", "讲义不存在");
    }
  }
  return insertEvents(db, batch.map(lectureEventRow));
}

/**
 * 服务端直接记录 hint_open 事件（T2.11 分步提示接口按需写入，不经前端队列——
 * 避免与解锁响应竞态、防绕过：只要提示被下发就必有事件）。
 * payload 只含元信息（type/clientTs/questionId/index），不含提示内容（泄露红线）；
 * 每次打开都记一条（含同条重复请求——回看也是一次 hint_open 行为痕迹）。
 */
export function recordHintOpenEvent(
  db: Db,
  attemptId: string,
  questionId: string,
  index: number,
): void {
  const now = Date.now();
  insertEvents(db, [
    {
      id: "",
      attemptId,
      questionId,
      type: "hint_open",
      payloadJson: JSON.stringify({
        type: "hint_open",
        clientTs: now,
        questionId,
        index,
      }),
      clientTs: now,
      serverTs: "",
    },
  ]);
}

/** 契约事件 → events 行（attempt 上下文：questionId 按事件语义提取） */
function attemptEventRow(event: AttemptEvent, attemptId: string): NewEventRow {
  return {
    id: "", // insertEvents 统一生成
    attemptId,
    questionId: questionIdOf(event),
    type: event.type,
    payloadJson: JSON.stringify(event),
    clientTs: event.clientTs,
    serverTs: "", // insertEvents 统一填写
  };
}

/** 契约事件 → events 行（讲义上下文：attemptId/questionId 均 NULL） */
function lectureEventRow(event: LectureEvent): NewEventRow {
  return {
    id: "",
    attemptId: null,
    questionId: null,
    type: event.type,
    payloadJson: JSON.stringify(event),
    clientTs: event.clientTs,
    serverTs: "",
  };
}

/** 带题目语义的事件提取 questionId（payload 顶层字段，契约保证存在） */
function questionIdOf(event: AttemptEvent): string | null {
  const questionId = (event as { questionId?: unknown }).questionId;
  return typeof questionId === "string" && questionId.length > 0
    ? questionId
    : null;
}

/**
 * 交卷计算用：按 clientTs 升序取 attempt 的全部事件投影
 * （active-time 纯函数的最小输入面；不解析 payloadJson）。
 */
export function attemptTimeline(
  db: Db,
  attemptId: string,
): ReadonlyArray<{
  type: string;
  clientTs: number;
  questionId: string | null;
}> {
  return db
    .select({
      type: events.type,
      clientTs: events.clientTs,
      questionId: events.questionId,
    })
    .from(events)
    .where(eq(events.attemptId, attemptId))
    .orderBy(asc(events.clientTs), asc(events.id))
    .all();
}
