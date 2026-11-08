import { randomUUID } from "node:crypto";
import {
  annotationPngFingerprint,
  QUESTION_PROCESS_MAX_EVENTS,
  QUESTION_PROCESS_MAX_QUESTION_BYTES,
  QUESTION_PROCESS_RETENTION_DAYS,
  type QuestionProcessBatch,
  type QuestionProcessRead,
  type QuestionProcessStatus,
  questionProcessBatchSchema,
  questionProcessReadSchema,
  questionSchema,
} from "@tutor/contract";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  annotationBases,
  questionProcessBatches,
  questionProcessRecordings,
  responses,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { annotationBaseImageBytes } from "./annotation-service";
import {
  materialSlotOrderOf,
  publicOfSnapshot,
  requireUsableAttempt,
} from "./attempt-service";
import { requireTeacherAttempt } from "./teacher-attempt-service";

function recordingOf(db: Db, attemptId: string) {
  return db
    .select()
    .from(questionProcessRecordings)
    .where(eq(questionProcessRecordings.attemptId, attemptId))
    .get();
}

function responseOf(db: Db, attemptId: string, questionId: string) {
  const row = db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .get();
  if (!row?.questionSnapshotJson) {
    throw new HttpError(404, "QUESTION_NOT_FOUND", "找不到这次练习的冻结题目");
  }
  return { ...row, questionSnapshotJson: row.questionSnapshotJson };
}

export function purgeExpiredQuestionProcesses(db: Db, now = new Date()) {
  // 外键级联清理批次。交卷后的旧练习无法再次开启记录。
  db.delete(questionProcessRecordings)
    .where(lte(questionProcessRecordings.expiresAt, now.toISOString()))
    .run();
}

export function questionProcessStatus(
  db: Db,
  studentId: string,
  attemptId: string,
  enabled: boolean,
  now = new Date(),
): QuestionProcessStatus {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.sourceType !== "course") return { state: "unavailable" };
  const row = recordingOf(db, attemptId);
  if (row) {
    if (row.deletedAt || row.expiresAt <= now.toISOString())
      return { state: "closed" };
    if (!enabled) return { state: "unavailable" };
    return {
      state: "active",
      recordingId: row.id,
      expiresAt: row.expiresAt,
      canCapture: attempt.status === "draft",
    };
  }
  return {
    state: enabled && attempt.status === "draft" ? "available" : "unavailable",
  };
}

export function startQuestionProcess(
  db: Db,
  studentId: string,
  attemptId: string,
  enabled: boolean,
  now = new Date(),
): QuestionProcessStatus {
  const status = questionProcessStatus(db, studentId, attemptId, enabled, now);
  if (status.state !== "available") return status;
  db.insert(questionProcessRecordings)
    .values({
      id: randomUUID(),
      attemptId,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + QUESTION_PROCESS_RETENTION_DAYS * 86_400_000,
      ).toISOString(),
    })
    .onConflictDoNothing()
    .run();
  return questionProcessStatus(db, studentId, attemptId, enabled, now);
}

export function deleteQuestionProcess(
  db: Db,
  studentId: string,
  attemptId: string,
  now = new Date(),
) {
  requireUsableAttempt(db, studentId, attemptId);
  const row = recordingOf(db, attemptId);
  if (!row) return;
  db.transaction((tx) => {
    tx.delete(questionProcessBatches)
      .where(eq(questionProcessBatches.recordingId, row.id))
      .run();
    tx.update(questionProcessRecordings)
      .set({ deletedAt: now.toISOString() })
      .where(eq(questionProcessRecordings.id, row.id))
      .run();
  });
}

export function appendQuestionProcess(
  db: Db,
  studentId: string,
  attemptId: string,
  enabled: boolean,
  batch: QuestionProcessBatch,
  now = new Date(),
) {
  const status = questionProcessStatus(db, studentId, attemptId, enabled, now);
  if (status.state !== "active" || status.recordingId !== batch.recordingId) {
    throw new HttpError(403, "QUESTION_PROCESS_CLOSED", "本次过程记录已关闭");
  }
  const row = responseOf(db, attemptId, batch.questionId);
  if (row.id !== batch.revisionId) {
    throw new HttpError(
      409,
      "QUESTION_PROCESS_REVISION",
      "过程记录对应的题目版本已变化",
    );
  }
  const payload = JSON.stringify(batch);
  const bytes = Buffer.byteLength(payload);
  const first = batch.events[0];
  const last = batch.events.at(-1);
  if (!first || !last)
    throw new HttpError(400, "VALIDATION_ERROR", "过程批次为空");
  // 上传可以晚于提交。教师读端只标记收到的过程，不以客户端时间改变提交事实。
  return db.transaction((tx) => {
    const question = and(
      eq(questionProcessBatches.recordingId, batch.recordingId),
      eq(questionProcessBatches.questionId, batch.questionId),
    );
    const segment = and(
      question,
      eq(questionProcessBatches.segmentId, batch.segmentId),
    );
    const overlap = tx
      .select()
      .from(questionProcessBatches)
      .where(
        and(
          segment,
          lte(questionProcessBatches.firstSeq, last.seq),
          sql`${questionProcessBatches.lastSeq} >= ${first.seq}`,
        ),
      )
      .get();
    if (overlap) {
      if (overlap.payload === payload) return { acceptedThrough: last.seq };
      throw new HttpError(
        409,
        "QUESTION_PROCESS_SEQUENCE",
        "过程批次的事件序号已占用",
      );
    }
    const totals = tx
      .select({
        bytes: sql<number>`coalesce(sum(${questionProcessBatches.bytes}), 0)`,
        count: sql<number>`coalesce(sum(${questionProcessBatches.lastSeq} - ${questionProcessBatches.firstSeq} + 1), 0)`,
      })
      .from(questionProcessBatches)
      .where(question)
      .get();
    const allBytes = tx
      .select({
        bytes: sql<number>`coalesce(sum(${questionProcessBatches.bytes}), 0)`,
      })
      .from(questionProcessBatches)
      .where(eq(questionProcessBatches.recordingId, batch.recordingId))
      .get();
    if (
      (totals?.bytes ?? 0) + bytes > QUESTION_PROCESS_MAX_QUESTION_BYTES ||
      (totals?.count ?? 0) + batch.events.length >
        QUESTION_PROCESS_MAX_EVENTS ||
      (allBytes?.bytes ?? 0) + bytes > 64 * 1024 * 1024
    ) {
      throw new HttpError(
        413,
        "QUESTION_PROCESS_LIMIT",
        "过程记录已达到容量上限",
      );
    }
    tx.insert(questionProcessBatches)
      .values({
        recordingId: batch.recordingId,
        questionId: batch.questionId,
        segmentId: batch.segmentId,
        firstSeq: first.seq,
        lastSeq: last.seq,
        payload,
        bytes,
      })
      .run();
    return { acceptedThrough: last.seq };
  });
}

export function readQuestionProcess(
  db: Db,
  dataDir: string,
  teacherId: string,
  attemptId: string,
  questionId: string,
  now = new Date(),
): QuestionProcessRead {
  requireTeacherAttempt(db, teacherId, attemptId);
  const row = responseOf(db, attemptId, questionId);
  const snapshot = questionSchema.parse(JSON.parse(row.questionSnapshotJson));
  const question = publicOfSnapshot(snapshot, row.id, {
    unitId: row.unitId,
    materialSlots: materialSlotOrderOf(db, attemptId),
  });
  const recording = recordingOf(db, attemptId);
  const segments = new Map<string, QuestionProcessRead["segments"][number]>();
  if (
    recording &&
    !recording.deletedAt &&
    recording.expiresAt > now.toISOString()
  ) {
    const bases = db
      .select()
      .from(annotationBases)
      .where(
        and(
          eq(annotationBases.attemptId, attemptId),
          eq(annotationBases.questionId, questionId),
          eq(annotationBases.questionRevisionId, row.id),
          eq(annotationBases.phase, "scratch"),
          eq(annotationBases.state, "ready"),
        ),
      )
      .all();
    const fingerprints = new Map<string, string | undefined>();
    const fingerprintOf = (id: string) => {
      if (!fingerprints.has(id)) {
        try {
          const bytes = annotationBaseImageBytes(
            db,
            dataDir,
            { kind: "teacher", id: teacherId },
            undefined,
            id,
          );
          fingerprints.set(id, annotationPngFingerprint(new Uint8Array(bytes)));
        } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 404)
            throw error;
          fingerprints.set(id, undefined);
        }
      }
      return fingerprints.get(id);
    };
    const resolveFrame = <
      T extends {
        baseId?: string | undefined;
        baseHash?: string | undefined;
        baseFingerprint?: string | undefined;
        width: number;
        height: number;
      },
    >(
      frame: T,
    ) => {
      const { baseId, baseHash, baseFingerprint, ...rest } = frame;
      const base = bases.find(
        (candidate) =>
          candidate.pixelWidth === frame.width &&
          candidate.pixelHeight === frame.height &&
          (baseHash
            ? candidate.imageHash === baseHash
            : baseFingerprint
              ? fingerprintOf(candidate.id) === baseFingerprint
              : candidate.id === baseId),
      );
      return { ...rest, ...(base ? { baseId: base.id } : {}) };
    };
    const batches = db
      .select()
      .from(questionProcessBatches)
      .where(
        and(
          eq(questionProcessBatches.recordingId, recording.id),
          eq(questionProcessBatches.questionId, questionId),
        ),
      )
      .orderBy(
        asc(questionProcessBatches.segmentId),
        asc(questionProcessBatches.firstSeq),
      )
      .all();
    for (const batchRow of batches) {
      const batch = questionProcessBatchSchema.parse(
        JSON.parse(batchRow.payload),
      );
      let segment = segments.get(batch.segmentId);
      if (!segment) {
        segment = {
          id: batch.segmentId,
          startedAt: batch.startedAt,
          events: [],
          gap: false,
        };
        segments.set(segment.id, segment);
      }
      for (const event of batch.events) {
        if (
          segment.gap ||
          event.seq !== segment.events.length ||
          event.at < (segment.events.at(-1)?.at ?? 0) ||
          batch.startedAt !== segment.startedAt
        ) {
          segment.gap = true;
          break;
        }
        if (event.kind === "start" && event.layers.annotation) {
          event.layers.annotation = resolveFrame(event.layers.annotation);
        } else if (event.kind === "surface" && event.layer === "annotation") {
          event.surface = resolveFrame(event.surface);
        } else if (
          event.kind === "ink" &&
          event.layer === "annotation" &&
          event.frame
        ) {
          event.frame = resolveFrame(event.frame);
        }
        segment.events.push(event);
      }
    }
  }
  return questionProcessReadSchema.parse({
    question,
    segments: [...segments.values()].sort((a, b) => a.startedAt - b.startedAt),
  });
}
