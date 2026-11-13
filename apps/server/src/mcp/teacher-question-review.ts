import {
  type QuestionReviewKind,
  type QuestionReviewRow,
  type QuestionType,
  questionTypeSchema,
} from "@tutor/contract";
import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, responses, students } from "../db/schema";
import {
  effectiveVerdictOfRow,
  effectiveVerdictSourceSql,
  effectiveVerdictValueSql,
} from "../services/response-verdict.ts";
import { teacherVisibleResponsesWhere } from "../services/teacher-attempt-service";
import {
  AI_TASK_EXISTS,
  decodeCursorOffset,
  NOTES_CORRECTION_EXISTS,
  parseKnowledgeArray,
  resolveToolStudent,
  stemSummaryOf,
} from "./teacher-queries";

// ---------- question-review（学生主页「错题与存疑」聚合，T-PR4 Web-2②） ----------

/** question-review 入参（teacher-students 路由的 questionReviewQuerySchema 与之对齐；
 * studentId 由调用方单独传，域校验走 resolveToolStudent） */
export interface QuestionReviewArgs {
  kind: QuestionReviewKind;
  courseId?: string | undefined;
  /** 单题提交时间下界 / 上界（UTC ISO；与 MCP-A from/to 同轴：responses.submittedAt） */
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

/**
 * 错题口径（#6980-3，与错题本 wrongCount 同一判据）：判错且「答了或有人工
 * 判定」——生效的教师判错或自评错误同样计入；
 * 纯未做判错行不算（详情页灰显「未做」的那批）。
 */
const questionReviewWrongWhere = and(
  eq(effectiveVerdictValueSql, 0),
  or(
    eq(responses.answered, true),
    inArray(effectiveVerdictSourceSql, ["teacher", "self"]),
  ),
);

/** kind → 行级筛选（三档口径见契约 question-review-api.ts 头注释） */
function questionReviewKindWhere(kind: QuestionReviewKind) {
  if (kind === "wrong") return questionReviewWrongWhere;
  if (kind === "unsure") return eq(responses.studentFlag, "unsure");
  return NOTES_CORRECTION_EXISTS;
}

/** 坏快照行按缺失计：题干 / 题型 / 难度任一取不出合法值即整行跳过（同作答详情口径） */
function usableReviewRowOf(
  row: {
    stemMd: string | null;
    type: string | null;
    difficulty: number | null;
  } & Record<string, unknown>,
): { stemMd: string; type: QuestionType; difficulty: number } | null {
  const stem = row.stemMd;
  if (stem === null || stem.length === 0) return null;
  const parsedType = questionTypeSchema.safeParse(row.type);
  if (!parsedType.success) return null;
  const difficulty = row.difficulty;
  if (
    typeof difficulty !== "number" ||
    !Number.isInteger(difficulty) ||
    difficulty < 1 ||
    difficulty > 5
  ) {
    return null;
  }
  return { stemMd: stem, type: parsedType.data, difficulty };
}

/**
 * 学生主页「错题与存疑」聚合：与 queryStudentResponses 共用查询构造器（共享
 * 谓词 + EXISTS 片段 + 截断 / 游标 helper），Web 端固定筛选形状（方案 §Web-2②）。
 * - 一条 SQL 取 kind 口径下全部可见行；细列不含答案 / 解析 / 选项（本面只有
 *   判定与计数，看全文走作答详情）；
 * - JS 侧按 questionId 聚合：代表作答 =（attempt 最近活动时间, responses.id）
 *   最新一行；redoCount = 该 kind 口径下可见行数 − 1；lastAt = 代表行 attempt
 *   最近活动时间（与作答列表排序同一时间轴）；
 * - 输出按 lastAt 倒序（同刻按 questionId 稳定）；offset 游标分页
 *   （total = 聚合后题目数）。
 */
export function questionReviewOf(
  db: Db,
  teacherId: string,
  studentId: string,
  args: QuestionReviewArgs,
): {
  total: number;
  nextCursor: string | null;
  questions: QuestionReviewRow[];
} {
  // 域校验：不存在或非本教师学生 → 404 STUDENT_NOT_FOUND（不暴露存在性）
  resolveToolStudent(db, teacherId, studentId);
  const offset = decodeCursorOffset(args.cursor);
  const rows = db
    .select({
      revisionId: responses.id,
      attemptId: responses.attemptId,
      questionId: responses.questionId,
      finalCorrect: responses.finalCorrect,
      autoCorrect: responses.autoCorrect,
      teacherMark: responses.teacherMark,
      selfReviewVerdict: responses.selfReviewVerdict,
      selfReviewAt: responses.selfReviewAt,
      selfReviewRevision: responses.selfReviewRevision,
      studentFlag: responses.studentFlag,
      type: sql<
        string | null
      >`json_extract(${responses.questionSnapshotJson}, '$.type')`,
      difficulty: sql<
        number | null
      >`json_extract(${responses.questionSnapshotJson}, '$.difficulty')`,
      stemMd: sql<
        string | null
      >`json_extract(${responses.questionSnapshotJson}, '$.stemMd')`,
      knowledge: sql<
        string | null
      >`json_extract(${responses.questionSnapshotJson}, '$.knowledge')`,
      lastActivity: sql<string>`coalesce(${attempts.submittedAt}, ${attempts.startedAt})`,
      hasCorrection: NOTES_CORRECTION_EXISTS,
      hasAiHelp: AI_TASK_EXISTS,
    })
    .from(responses)
    .innerJoin(attempts, eq(responses.attemptId, attempts.id))
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(
      and(
        eq(students.teacherId, teacherId),
        eq(attempts.studentId, studentId),
        // 共享谓词：排作废卷；draft 卷只纳入单题已提交的行；幽灵行排除
        ...teacherVisibleResponsesWhere(),
        questionReviewKindWhere(args.kind),
        ...(args.courseId !== undefined
          ? [eq(attempts.courseId, args.courseId)]
          : []),
        ...(args.from !== undefined
          ? [gte(responses.submittedAt, args.from)]
          : []),
        ...(args.to !== undefined ? [lte(responses.submittedAt, args.to)] : []),
      ),
    )
    .all();

  // 坏快照行先剔除（校验通过的行才参与聚合），随后细列排序：题间按
  // questionId 稳定、题内按（最近活动, 行 id）倒序，分组后每组首行即代表行
  const usable: ((typeof rows)[number] & {
    snapshot: { stemMd: string; type: QuestionType; difficulty: number };
  })[] = [];
  for (const row of rows) {
    const snapshot = usableReviewRowOf(row);
    if (snapshot !== null) usable.push({ ...row, snapshot });
  }
  const sorted = [...usable].sort((a, b) => {
    if (a.questionId !== b.questionId) {
      return a.questionId < b.questionId ? -1 : 1;
    }
    return (
      b.lastActivity.localeCompare(a.lastActivity) ||
      (a.revisionId < b.revisionId ? 1 : -1)
    );
  });

  /** 聚合中间态：代表行 + 该 kind 口径下可见行数 */
  interface ReviewGroup {
    rep: (typeof sorted)[number];
    count: number;
  }
  const grouped = new Map<string, ReviewGroup>();
  for (const row of sorted) {
    const entry = grouped.get(row.questionId);
    if (entry !== undefined) {
      entry.count += 1;
      continue;
    }
    grouped.set(row.questionId, { rep: row, count: 1 });
  }

  const entries = [...grouped.values()].sort(
    (a, b) =>
      b.rep.lastActivity.localeCompare(a.rep.lastActivity) ||
      (a.rep.questionId < b.rep.questionId ? -1 : 1),
  );
  const total = entries.length;
  const page = entries.slice(offset, offset + args.limit);

  const items: QuestionReviewRow[] = page.map(({ rep, count }) => {
    // stem 非空串已在校验收窄；stemSummaryOf 的可空签名是给共享路径的，
    // 这里兜底原串仅作类型收口（运行时不可达）
    const stem = rep.snapshot.stemMd;
    return {
      questionId: rep.questionId,
      attemptId: rep.attemptId,
      type: rep.snapshot.type,
      difficulty: rep.snapshot.difficulty,
      knowledge: parseKnowledgeArray(rep.knowledge),
      stemMd: stemSummaryOf(stem) ?? stem,
      finalCorrect: rep.finalCorrect,
      effectiveVerdict: effectiveVerdictOfRow(rep),
      studentFlag: rep.studentFlag === "unsure" ? "unsure" : null,
      hasCorrection: Boolean(rep.hasCorrection),
      hasAiHelp: Boolean(rep.hasAiHelp),
      redoCount: count - 1,
      lastAt: rep.lastActivity,
    };
  });

  const nextCursor =
    offset + page.length < total ? String(offset + page.length) : null;
  return { total, nextCursor, questions: items };
}
