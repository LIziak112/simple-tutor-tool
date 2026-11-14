/**
 * 学习记录装配服务（LR-PR3，学习记录模型设计稿 §3/§6/§7）：
 * 服务端从既有表与 blob **现算**装配只读聚合 LearningRecord（不新建表、
 * 不落盘）——渲染/导出/AI 上下文都是它的投影（P1：记录是事实源）。
 *
 * 装配口径（设计稿）：
 * - 身份面：questionRevisionId = 冻结 responses 行 id；questionNo = 卷内冻结
 *   展示序（frozenRowsInDisplayOrder，与结果/教师详情同口径）；
 * - 题面面：nodes 一律从**公开投影**枚举（questionNodesOf∘publicOfSnapshot，
 *   两种角色同一键序列——锚点跨角色互认的前提，§3.3）；teacher 额外带
 *   answers/solutionMd/hints 原文；
 * - 材料面：draft（notes scratch 头版本）/ formal_ink（ink 行）/ annotation
 *   （annotations scratch 行 + 底图 layout）三类各一项，缺则 present:false；
 * - 时间线：events（题目级 + 页级）＋三份文档的 startedAt/deletedAt ＋
 *   note_versions/封存 ＋ ai_facts 现算；停顿是派生值不落盘（§6.2）；
 *   serverSkewMs = 服务端确认时刻 − 最晚落笔结束（只提示不校正）；
 * - 判定面：学生角色按公布 gate（assignment 来源 answersReleased；其余来源
 *   交卷即公布，D11 同 attempt-service 结果视图公式）携带 autoCorrect/
 *   finalCorrect；教师域键（attemptId/studentId/questionId/answers/
 *   solutionMd/hints/teacherMark/teacherComment/reviewSource）学生恒缺席
 *   （learningRecordSchema superRefine 结构性拒绝，双重保险）。
 *
 * 出口经 learningRecordSchema.parse fail-closed：装配不变量破坏在装配方
 * 暴露，不带病出门（同 attemptQuestionPublicSchema.parse 口径）。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AnnotationDoc,
  annotationDocSchema,
  type InkMaterialFacet,
  type InkStroke,
  inkDocSchema,
  type LearningRecord,
  learningRecordSchema,
  type NoteDoc,
  noteDocSchema,
  type Question,
} from "@tutor/contract";
import { QUESTION_NODES_VERSION, questionNodesOf } from "@tutor/md-dsl";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  annotationBases,
  annotations,
  events,
  ink as inkTable,
  noteImages,
  notes,
  noteVersions,
  type ResponseRow,
  responses,
} from "../db/schema";
import { parseGzipOrJsonBytes } from "../lib/blob-io";
import { HttpError } from "../lib/http-error";
import {
  answerOf,
  frozenRowsInDisplayOrder,
  publicOfSnapshot,
  requireUsableAttempt,
} from "./attempt-service";
import { inkStatsOf } from "./learning-record-ink-stats.ts";
import { timelineOf } from "./learning-record-timeline.ts";
import { serializeStudentAnswer } from "./mark-response";
import { readNoteVersionDoc } from "./note-service";
import {
  effectiveVerdictOfRow,
  selfReviewRecordOf,
  teacherMarkOf,
} from "./response-verdict.ts";
import { questionReviewReadable } from "./review-access.ts";
import { requireTeacherAttempt } from "./teacher-attempt-service";

/** 解压上限：标注正文（annotation-service 同值；独立引入避免私有耦合） */
const ANNOTATION_BODY_DECOMPRESSED_MAX_BYTES_LOCAL = 8 * 1024 * 1024;
/** 解压上限：正式手写矢量（ink-service INK_MAX_STROKES_UNCOMPRESSED 同值） */
const INK_MAX_STROKES_UNCOMPRESSED_LOCAL = 32 * 1024 * 1024;

// ---------- 内部读取（无门口；所有权/可用性门口在入口函数） ----------

function responseRowOf(
  db: Db,
  attemptId: string,
  questionId: string,
): ResponseRow {
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
  if (row === undefined || row.questionSnapshotJson === null) {
    throw new HttpError(
      404,
      "QUESTION_NOT_FOUND",
      "题目不存在或不属于这次练习",
    );
  }
  return row;
}

function snapshotOf(row: ResponseRow): Question {
  try {
    const parsed = JSON.parse(row.questionSnapshotJson ?? "") as Question;
    // 升级遗留/损坏快照可能缺 stemMd（backup-gc 的坏行夹具即此类）——
    // 统一折算成 SNAPSHOT_BROKEN（HttpError），装配调用方按已知遗留类降级
    if (typeof parsed?.stemMd !== "string") {
      throw new HttpError(
        500,
        "SNAPSHOT_BROKEN",
        "冻结题目快照损坏（数据问题，请联系老师）",
      );
    }
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      500,
      "SNAPSHOT_BROKEN",
      "冻结题目快照损坏（数据问题，请联系老师）",
    );
  }
}

/** 卷内题号（冻结展示序；快照缺失行不计数——annotation-service 同口径） */
function questionNoOf(db: Db, attempt: Attempt, questionId: string): number {
  let no = 0;
  for (const entry of frozenRowsInDisplayOrder(db, attempt)) {
    if (entry.row.questionSnapshotJson !== null) no += 1;
    if (entry.row.questionId === questionId) break;
  }
  return Math.max(1, no);
}

function readJsonGz(
  path: string,
  maxDecompressed: number,
  label: string,
): unknown {
  let jsonText: string;
  try {
    jsonText = parseGzipOrJsonBytes(readFileSync(resolve(path)), {
      maxDecompressed,
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, "MATERIAL_FILE_MISSING", `${label}文件缺失`);
  }
  return JSON.parse(jsonText) as unknown;
}

// ---------- 三类材料面（§3.5） ----------

function draftMaterialOf(
  db: Db,
  dataDir: string,
  attemptId: string,
  questionId: string,
  teacher: boolean,
): InkMaterialFacet {
  const note = db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.attemptId, attemptId),
        eq(notes.questionId, questionId),
        eq(notes.phase, "scratch"),
      ),
    )
    .get();
  if (
    note === undefined ||
    note.currentVersionId === null ||
    note.currentRevision === 0
  ) {
    return {
      kind: "draft",
      present: false,
      strokes: [],
      deleted: [],
      frame: { kind: "paper", width: 1000, height: 800 },
      stats: inkStatsOf([], []),
      images: [],
    };
  }
  const version = readNoteVersionDoc(db, dataDir, note.currentVersionId);
  const doc = noteDocSchema.parse(version.doc) satisfies NoteDoc;
  const strokes = doc.ink.strokes;
  const deleted = doc.ink.deleted ?? [];
  return {
    kind: "draft",
    present: true,
    phase: "scratch",
    version: {
      revision: note.currentRevision,
      hash: version.rowHash,
      // 角色投影（设计稿 §3.5）：student 只留 revision/hash；id/时刻仅 teacher
      ...(teacher ? { versionId: note.currentVersionId } : {}),
      ...(teacher && note.serverSavedAt !== null
        ? { savedAt: note.serverSavedAt }
        : {}),
      ...(teacher && note.sealedAt !== null ? { sealedAt: note.sealedAt } : {}),
    },
    frame: {
      kind: "paper",
      width: 1000,
      height: doc.paperHeightLogical,
      background: doc.background,
    },
    strokes,
    deleted,
    stats: inkStatsOf(strokes, deleted),
    // 评审 #11695 顺手项：draft 面图片映射 note_images（记录是投影事实源，
    // 消费方不再各自查表）；ready→ready，其余一律 missing（如实）
    images: db
      .select()
      .from(noteImages)
      .where(eq(noteImages.noteVersionId, note.currentVersionId))
      .all()
      .map((image) => ({
        kind:
          image.spec === "thumbnail"
            ? ("thumbnail" as const)
            : ("analysis" as const),
        pageIndex: image.pageIndex,
        pixelWidth: image.pixelWidth,
        pixelHeight: image.pixelHeight,
        state:
          image.state === "ready" ? ("ready" as const) : ("missing" as const),
      })),
  };
}

function formalInkMaterialOf(
  db: Db,
  dataDir: string,
  attemptId: string,
  questionId: string,
  teacher: boolean,
): InkMaterialFacet {
  const row = db
    .select()
    .from(inkTable)
    .where(
      and(
        eq(inkTable.attemptId, attemptId),
        eq(inkTable.questionId, questionId),
      ),
    )
    .get();
  if (row === undefined) {
    return {
      kind: "formal_ink",
      present: false,
      strokes: [],
      deleted: [],
      frame: { kind: "paper", width: 1000, height: 800 },
      stats: inkStatsOf([], []),
      images: [],
    };
  }
  const parsed = inkDocSchema.parse(
    readJsonGz(
      resolve(dataDir, row.strokesPath),
      INK_MAX_STROKES_UNCOMPRESSED_LOCAL,
      "正式手写矢量",
    ),
  );
  // excalidraw 历史场景不解构成笔画——如实 present 但笔画数组为空，
  // 计数以表列为准（strokeCount 引擎口径）
  const strokes =
    parsed.engine === "atrament"
      ? (parsed.data.strokes as InkStroke[])
      : ([] as InkStroke[]);
  const deleted =
    parsed.engine === "atrament" ? (parsed.data.deleted ?? []) : [];
  return {
    kind: "formal_ink",
    present: true,
    version: {
      revision: row.revision,
      ...(teacher && row.updatedAt !== null ? { savedAt: row.updatedAt } : {}),
    },
    frame: { kind: "paper", width: 1000, height: 800 },
    strokes,
    deleted,
    stats: {
      ...inkStatsOf(strokes, deleted),
      strokeCount: row.strokeCount,
    },
    images: [
      {
        kind: "snapshot",
        pageIndex: 0,
        pixelWidth: row.width,
        pixelHeight: row.height,
        state: "ready",
      },
    ],
  };
}

function annotationMaterialOf(
  db: Db,
  dataDir: string,
  attemptId: string,
  questionId: string,
  teacher: boolean,
): InkMaterialFacet {
  const row = db
    .select()
    .from(annotations)
    .where(
      and(
        eq(annotations.attemptId, attemptId),
        eq(annotations.questionId, questionId),
        eq(annotations.phase, "scratch"),
      ),
    )
    .get();
  if (row === undefined || row.bodyPath === null || row.baseId === null) {
    return {
      kind: "annotation",
      present: false,
      strokes: [],
      deleted: [],
      frame: { kind: "base", pixelWidth: 1, pixelHeight: 1, anchoredRatio: 0 },
      stats: inkStatsOf([], []),
      images: [],
    };
  }
  const doc = annotationDocSchema.parse(
    readJsonGz(
      resolve(dataDir, row.bodyPath),
      ANNOTATION_BODY_DECOMPRESSED_MAX_BYTES_LOCAL,
      "题干标注矢量",
    ),
  ) satisfies AnnotationDoc;
  const base =
    row.baseId !== null
      ? db
          .select()
          .from(annotationBases)
          .where(eq(annotationBases.id, row.baseId))
          .get()
      : undefined;
  const strokes = doc.strokes;
  const deleted = doc.deleted ?? [];
  const anchored = strokes.filter(
    (stroke) =>
      stroke.id !== undefined && doc.anchors?.[stroke.id] !== undefined,
  ).length;
  return {
    kind: "annotation",
    present: true,
    phase: row.phase,
    version: {
      revision: row.revision,
      ...(row.hash !== null ? { hash: row.hash } : {}),
      ...(teacher && row.updatedAt !== null ? { savedAt: row.updatedAt } : {}),
      ...(teacher && row.sealedAt !== null ? { sealedAt: row.sealedAt } : {}),
    },
    frame: {
      kind: "base",
      pixelWidth: base?.pixelWidth ?? doc.baseWidth,
      pixelHeight: base?.pixelHeight ?? doc.baseHeight,
      ...(base?.layout !== null && base?.layout !== undefined
        ? { layout: base.layout }
        : {}),
      anchoredRatio: strokes.length === 0 ? 0 : anchored / strokes.length,
    },
    strokes,
    deleted,
    ...(doc.anchors !== undefined ? { anchors: doc.anchors } : {}),
    stats: inkStatsOf(strokes, deleted),
    images:
      base?.imagePath !== null && base?.imagePath !== undefined
        ? [
            {
              kind: "base",
              pageIndex: 0,
              pixelWidth: base.pixelWidth ?? doc.baseWidth,
              pixelHeight: base.pixelHeight ?? doc.baseHeight,
              state: base?.state === "ready" ? "ready" : "missing",
            },
          ]
        : [],
  };
}

// ---------- 判定面（§3.7）与装配入口 ----------

function assemble(
  db: Db,
  dataDir: string,
  attempt: Attempt,
  row: ResponseRow,
  role: "student" | "teacher" | "ai",
  now: Date,
): LearningRecord {
  const teacher = role === "teacher";
  const snapshot = snapshotOf(row);
  const pub = publicOfSnapshot(snapshot, row.id, {
    questionVersion: row.questionVersion,
  });
  const showJudgment = teacher || questionReviewReadable(db, attempt, row, now);
  const selfReview = showJudgment ? selfReviewRecordOf(row) : null;
  const effectiveVerdict = teacher ? effectiveVerdictOfRow(row) : null;

  const draft = draftMaterialOf(
    db,
    dataDir,
    attempt.id,
    row.questionId,
    teacher,
  );
  const formalInk = formalInkMaterialOf(
    db,
    dataDir,
    attempt.id,
    row.questionId,
    teacher,
  );
  const annotation = annotationMaterialOf(
    db,
    dataDir,
    attempt.id,
    row.questionId,
    teacher,
  );
  const materials = [draft, formalInk, annotation];

  // 题面面：nodes 两种角色都从公开投影枚举（§3.3 同一键序列）
  const nodes = questionNodesOf({
    stemMd: pub.stemMd,
    options: pub.options ?? [],
  });

  // 作答历史（answer_change 事件现算）
  const history = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.attemptId, attempt.id),
        eq(events.questionId, row.questionId),
        eq(events.type, "answer_change"),
      ),
    )
    .orderBy(asc(events.clientTs))
    .all()
    .map((event) => {
      const payload = JSON.parse(event.payloadJson) as {
        from?: unknown;
        to?: unknown;
      };
      return {
        at: event.clientTs,
        ...(payload.from !== undefined ? { from: payload.from } : {}),
        ...(payload.to !== undefined ? { to: payload.to } : {}),
      };
    });

  const timeline = timelineOf(
    db,
    attempt,
    row,
    materials,
    showJudgment,
    selfReview,
  );

  const draftRecord = {
    recordVersion: 1,
    role,
    generatedAt: now.toISOString(),
    identity: {
      questionRevisionId: row.id,
      questionNo: questionNoOf(db, attempt, row.questionId),
      ...(teacher
        ? {
            attemptId: attempt.id,
            studentId: attempt.studentId,
            questionId: row.questionId,
          }
        : {}),
      attemptStatus: attempt.status,
      source: attempt.sourceType,
    },
    question: {
      snapshotPresent: true,
      type: pub.type,
      difficulty: snapshot.difficulty ?? null,
      knowledge: snapshot.knowledge ?? [],
      // stemMd/options 按角色投影：student 公开投影；teacher 原文与选项原文
      stemMd: teacher ? snapshot.stemMd : pub.stemMd,
      ...(snapshot.options !== undefined
        ? {
            options: teacher
              ? snapshot.options.map((option) => option.text)
              : (pub.options ?? []),
          }
        : {}),
      ...(role !== "student"
        ? {
            answers: snapshot.answers,
            solutionMd: snapshot.solutionMd ?? "",
            hints: snapshot.hints.map((hint) =>
              typeof hint === "string"
                ? hint
                : String((hint as { md?: unknown }).md ?? ""),
            ),
          }
        : {}),
      nodesVersion: QUESTION_NODES_VERSION,
      nodes,
    },
    answer: {
      current: row.answerJson === null ? null : answerOf(row.answerJson),
      answerText:
        row.answerJson === null
          ? null
          : serializeStudentAnswer(answerOf(row.answerJson)),
      answerRevision: row.answerRevision,
      submittedAt: row.submittedAt,
      studentFlag: row.studentFlag === null ? null : true,
      history,
    },
    ink: materials,
    timeline,
    grading: {
      answered: row.answered,
      // 判定域：teacher 全带；student 仅在「已公布」时带（与结果页同一 gate）
      ...(showJudgment
        ? {
            autoCorrect: row.autoCorrect,
            finalCorrect: row.finalCorrect,
            selfReview,
            selfCorrect:
              selfReview === null ? null : selfReview.verdict === "correct",
            reviewedAt: selfReview?.at ?? null,
          }
        : {}),
      ...(teacher
        ? {
            effectiveVerdict,
            reviewSource:
              effectiveVerdict?.source === "auto"
                ? "automatic"
                : (effectiveVerdict?.source ?? null),
            teacherMark: teacherMarkOf(row.teacherMark),
            teacherComment: row.teacherComment,
          }
        : {}),
      hintsUsed: row.hintsUsed,
      hintsOpened: JSON.parse(row.hintsOpenedJson ?? "[]") as number[],
    },
  } as const;

  // fail-closed：学生禁携清单由 learningRecordSchema superRefine 结构性兜底
  return learningRecordSchema.parse(draftRecord);
}

/** 学生视角记录（本人；requireUsableAttempt 门口：本人 + 可用 attempt） */
export function getStudentLearningRecord(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  questionId: string,
  now: Date = new Date(),
): LearningRecord {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  const row = responseRowOf(db, attempt.id, questionId);
  return assemble(db, dataDir, attempt, row, "student", now);
}

/** 教师视角记录（域内；requireTeacherAttempt 门口：本人学生的 attempt） */
export function getTeacherLearningRecord(
  db: Db,
  dataDir: string,
  teacherId: string,
  attemptId: string,
  questionId: string,
  now: Date = new Date(),
): LearningRecord {
  const { attempt } = requireTeacherAttempt(db, teacherId, attemptId);
  const row = responseRowOf(db, attempt.id, questionId);
  return assemble(db, dataDir, attempt, row, "teacher", now);
}

/** AI 视图记录（学生上下文授权口径：学生投影 + 按快照授权携带答案/解析/提示） */
export function getAiLearningRecord(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  questionId: string,
  now: Date = new Date(),
): LearningRecord {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  const row = responseRowOf(db, attempt.id, questionId);
  return assemble(db, dataDir, attempt, row, "ai", now);
}

/**
 * 三类材料的版本钉住引用（LR-PR5 recordRefs，§7.3）：任务创建时把
 * (revision, hash) 写进快照并并入 contextVersion 的 HMAC 输入。纯 DB 读取
 * （note_versions.hash / annotations.hash 均为表列）；缺失材料 revision 0、
 * hash null（formal_ink 行无 hash 列，恒 null——如实）。
 */
export function learningRecordMaterialRefs(
  db: Db,
  attemptId: string,
  questionId: string,
): Array<{
  kind: "draft" | "formal_ink" | "annotation";
  revision: number;
  hash: string | null;
}> {
  const note = db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.attemptId, attemptId),
        eq(notes.questionId, questionId),
        eq(notes.phase, "scratch"),
      ),
    )
    .get();
  const version =
    note?.currentVersionId !== null && note?.currentVersionId !== undefined
      ? db
          .select()
          .from(noteVersions)
          .where(eq(noteVersions.id, note.currentVersionId))
          .get()
      : undefined;
  const draftRef = {
    kind: "draft" as const,
    revision:
      note === undefined || note.currentRevision === 0
        ? 0
        : note.currentRevision,
    hash: version?.hash ?? null,
  };
  const inkRow = db
    .select()
    .from(inkTable)
    .where(
      and(
        eq(inkTable.attemptId, attemptId),
        eq(inkTable.questionId, questionId),
      ),
    )
    .get();
  const formalRef = {
    kind: "formal_ink" as const,
    revision: inkRow?.revision ?? 0,
    hash: null,
  };
  const annotationRow = db
    .select()
    .from(annotations)
    .where(
      and(
        eq(annotations.attemptId, attemptId),
        eq(annotations.questionId, questionId),
        eq(annotations.phase, "scratch"),
      ),
    )
    .get();
  const annotationRef = {
    kind: "annotation" as const,
    revision:
      annotationRow === undefined || annotationRow.bodyPath === null
        ? 0
        : annotationRow.revision,
    hash: annotationRow?.hash ?? null,
  };
  return [draftRef, formalRef, annotationRef];
}
