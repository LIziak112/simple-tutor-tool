import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type {
  LearningPack,
  LearningPackAttemptSummary,
  LearningPackEvidence,
  LearningPackExportRequest,
  LearningPackGoal,
  LearningPackLecture,
  LearningPackLectureTrace,
  LearningPackManifest,
  LearningPackModules,
  LearningPackPreviewData,
  LearningPackPreviewFile,
  LearningPackQuestion,
  LearningPackQuestionTrace,
  LearningPackResponse,
  LearningPackStudentSummary,
  LearningPackSummarySection,
  LearningPackV2,
  LearningPackV2Question,
  LearningPackV2Response,
} from "@tutor/contract";
import {
  LEARNING_PACK_GOAL_LABELS,
  LEARNING_PACK_MAX_BYTES,
  learningPackAliasOf,
  learningPackJsonSchema,
  learningPackSchema,
  learningPackV2JsonSchema,
  learningPackV2Schema,
  renderLearningPackPrompt,
} from "@tutor/contract";
import { analyzeLectureStructure } from "@tutor/md-dsl";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  assignments,
  attempts,
  courseItems,
  courses,
  events,
  type InkRow,
  ink,
  lectures,
  questions,
  type ResponseRow,
  responses,
  students,
  units,
} from "../db/schema";
import { chunk } from "../lib/chunk";
import { HttpError } from "../lib/http-error";
import { zipBufferOf } from "../lib/zip-write";
import { answerOf, frozenRowsInDisplayOrder } from "./attempt-service";
import { beijingDateTimeOf, beijingExportStampOf } from "./export-csv";
import { inkFileAbs } from "./ink-service";
import { lectureReadingMapFor } from "./lecture-insights";
import { serializeStudentAnswer } from "./mark-response";
import { extractMediaImageSrcs, statMediaSrc } from "./media-service";
import {
  assembleQuestionEvidence,
  evidenceMissingRowsOf,
  materialOf,
  readyEvidenceImagesOf,
} from "./question-evidence";
import { snapshotOfRow } from "./snapshot";
import { sourceOf } from "./teacher-attempt-service";
import { type TraceEvent, traceEventsFromRows } from "./trace-intervals";
import { computeAttemptTraceMetrics } from "./trace-metrics";

/**
 * ExportService（T4.3，Phase4 清单 §4 / §2 D14–D19 + 架构 §5.9 第二层）——
 * AI 学情数据包的模块装配、化名引擎、prompt/summary 生成与 zip 打包。
 *
 * 分层：
 * - assembleLearningPack：范围解析（域校验 404）→ 装配 pack.json / summary.md /
 *   prompt.md / schema.json / 映射.txt / ink 与 media 清单及预估大小
 *   （preview 与生成共用）；
 * - previewLearningPack：装配 + 文件清单响应（超限不报错，D18 由向导提示精简）；
 * - buildLearningPackZip：装配 + 50MB 预检（超限 413 EXPORT_TOO_LARGE）+
 *   archiver 打包为内存 Buffer（上限内的一对一规模，无需落盘临时文件）。
 *
 * 口径要点（与契约 learning-pack.ts 注释一致）：
 * - D15 全部历次：attempts/responses/summary 只收**已交卷** attempt（draft 无
 *   判定无快照），attemptNo 与 isFirst 原样携带；
 * - D16 化名：按请求学生名单顺序编号（学生A/B…，learningPackAliasOf），贯穿
 *   pack.json / summary.md / ink 文件名；映射.txt 只进 zip 顶层不进 pack.json；
 *   教师评语原文一律不改动（meta.note 与 summary.md 头部注明可能含真名）；
 * - D13：traces 只输出 responses 列 + computeAttemptTraceMetrics 派生指标与
 *   阅读地图（lectureReadingMapFor），原始 events 不出库；
 * - D7 域隔离：请求携带的学生/课程/作业/讲义 id 逐个域校验（404 不暴露存在性），
 *   作答经 attempt → student → teacherId 过滤（乙教师拿不到甲的任何行）；
 * - 题目三层（D14）：stem 层题干经 studentStemMd 学生端投影（不给答案，选项列表剥除）；
 *   answer/solution 层保留快照原文（含 [[答案]] 标记，教师侧导出无泄露问题）。
 *
 * now 可注入（时间窗与生成时间的确定性测试；默认当前时刻）。
 */

/** 一天（days 窗口换算） */
const DAY_MS = 86_400_000;

/** 服务选项：now 注入测试时刻；maxBytes 注入缩小的上限（50MB 预检用例） */
export interface LearningPackServiceOptions {
  readonly now?: Date | string;
  /** 覆盖大小上限（默认 LEARNING_PACK_MAX_BYTES；测试注入小值触发超限） */
  readonly maxBytes?: number;
}

// ---------- 范围校验（D7：域内逐个校验，404 不暴露存在性） ----------

/** 学生域校验：不存在或非本教师 → 404 STUDENT_NOT_FOUND；通过返回展示行 */
function requireOwnedStudent(
  db: Db,
  teacherId: string,
  studentId: string,
): { id: string; displayName: string; archivedAt: string | null } {
  const row = db
    .select({
      id: students.id,
      displayName: students.displayName,
      archivedAt: students.archivedAt,
    })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.teacherId, teacherId)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "STUDENT_NOT_FOUND", "学生不存在");
  }
  return row;
}

/** 课程域校验（D7）：不存在或非本教师 → 404 COURSE_NOT_FOUND */
function requireOwnedCourse(db: Db, teacherId: string, courseId: string): void {
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.id, courseId), eq(courses.teacherId, teacherId)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
  }
}

/** 作业域校验（D7）：不存在或非本教师 → 404 ASSIGNMENT_NOT_FOUND（软删作业可导出历史） */
function requireOwnedAssignment(
  db: Db,
  teacherId: string,
  assignmentId: string,
): void {
  const row = db
    .select({ id: assignments.id })
    .from(assignments)
    .where(
      and(
        eq(assignments.id, assignmentId),
        eq(assignments.teacherId, teacherId),
      ),
    )
    .get();
  if (row === undefined) {
    throw new HttpError(404, "ASSIGNMENT_NOT_FOUND", "作业不存在");
  }
}

/** 讲义域校验（D7）：不存在、非本教师或已软删 → 404 LECTURE_NOT_FOUND */
function requireOwnedLecture(
  db: Db,
  teacherId: string,
  lectureId: string,
): { id: string; title: string; markdown: string } {
  const row = db
    .select({
      id: lectures.id,
      title: lectures.title,
      markdown: lectures.markdown,
    })
    .from(lectures)
    .where(
      and(
        eq(lectures.id, lectureId),
        eq(lectures.teacherId, teacherId),
        isNull(lectures.deletedAt),
      ),
    )
    .get();
  if (row === undefined) {
    throw new HttpError(404, "LECTURE_NOT_FOUND", "讲义不存在或已删除");
  }
  return row;
}

// ---------- 通用工具 ----------

/** zip 条目名里必须替换掉的不安全字符（路径分隔符与 Windows 保留字符） */
const ZIP_UNSAFE_CHARS = '\\/:*?"<>|';

/** questionId → zip 条目安全名（去路径分隔符/Windows 保留字符/控制字符；空或异常回退 hash） */
function zipSafeQuestionName(questionId: string): string {
  // 逐码点白名单式替换（不用含控制字符区间的正则——biome noControlCharactersInRegex）
  let cleaned = "";
  for (const ch of questionId) {
    const code = ch.codePointAt(0) ?? 0;
    const unsafe =
      ZIP_UNSAFE_CHARS.includes(ch) || code < 0x20 || code === 0x7f;
    if (unsafe || /\s/.test(ch)) continue;
    cleaned += ch;
  }
  cleaned = cleaned.replaceAll(/\.\.+/g, ".");
  const trimmed = cleaned.slice(0, 60);
  if (trimmed.length > 0 && !trimmed.startsWith(".")) return trimmed;
  return `q-${createHash("sha256").update(questionId).digest("hex").slice(0, 12)}`;
}

// ---------- 讲义小节切片（与前端 extractOutline / headingIndex 同口径） ----------

/**
 * 讲义 markdown → 各 H2/H3 节的 [起始行, 结束行]（1 起闭区间）。
 * 行扫描口径与 extractOutline 一致（跳过代码围栏；H2/H3 才是目录项），与
 * analyzeLectureStructure 的 headingIndex 对齐（契约测试锁定两者序列一致，
 * T4.0 方案 §4.4.2 前提 5）。
 */
function sectionRangesOf(markdown: string): Array<[number, number]> {
  const lines = markdown.split(/\r?\n/);
  const headingLines: number[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line.trimStart());
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (fence === null) fence = marker[0] ?? "`";
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (/^#{2,3}(?!#)\s+\S/.test(line)) headingLines.push(i + 1); // 1 起行号
  }
  return headingLines.map((start, index) => {
    const end =
      index + 1 < headingLines.length
        ? (headingLines[index + 1] ?? start) - 1
        : lines.length;
    return [start, end] as [number, number];
  });
}

// ---------- ::image 图片引用提取 ----------
// extractMediaImageSrcs 已抽取到 media-service 共享（导出打包与导入存在性
// 核对同源，见该函数注释），此处经 import 引用。

/**
 * 题目条目的单元标题统一回填（v1/v2 共用）：域内 units 表查标题（含软删——
 * 历史统计不消失），查不到回退 unitId 本身。原位修改 unitTitle 字段。
 */
function backfillUnitTitles<
  T extends { unitId: string | null; unitTitle: string | null },
>(db: Db, teacherId: string, items: T[]): void {
  const unitIds = [
    ...new Set(
      items
        .map((item) => item.unitId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const titleById = new Map<string, string>();
  if (unitIds.length > 0) {
    for (const row of db
      .select({ id: units.id, title: units.title })
      .from(units)
      .where(and(eq(units.teacherId, teacherId), inArray(units.id, unitIds)))
      .all()) {
      titleById.set(row.id, row.title);
    }
  }
  for (const item of items) {
    if (item.unitId !== null) {
      item.unitTitle = titleById.get(item.unitId) ?? item.unitId;
    }
  }
}

// ---------- 装配 ----------

/** 装配结果：pack 各文件内容 + ink 清单（zip 写入与 preview 共用） */
export interface LearningPackAssembly {
  /** pack.json 文本（2 空格缩进；已通过 learningPackSchema 往返校验） */
  readonly packJson: string;
  readonly summaryMd: string;
  readonly promptMd: string;
  /** zip 内 schema.json 文本（与 schema:export 产物逐字节一致） */
  readonly schemaJson: string;
  /** 映射.txt 文本；真名模式（anonymize=false）为 null（不进 zip） */
  readonly mappingTxt: string | null;
  /** ink 条目：zip 路径 + 绝对路径 + 实测字节数（statSync；缺文件已跳过） */
  readonly inkEntries: ReadonlyArray<{
    readonly entry: string;
    readonly absPath: string;
    readonly bytes: number;
  }>;
  /**
   * media 条目（媒体管线第三单）：进入 pack 的 md 中 ::image 引用的图片。
   * zip 路径即契约 src 相对路径（blobs/media/<hash>.<ext>，zip 内含子目录
   * 条目）；缺文件已跳过（v1 同 ink 口径；v2 进 manifest.missing）。
   */
  readonly mediaEntries: ReadonlyArray<{
    readonly entry: string;
    readonly absPath: string;
    readonly bytes: number;
  }>;
  /**
   * v2 证据图条目（T6R.12；evidence 模块勾选才非空）：zip 路径
   * evidence/<编号>-<阶段>-<页号>.png；ref 为证据条目编号（manifest 关联用）。
   */
  readonly evidenceEntries: ReadonlyArray<{
    readonly entry: string;
    readonly absPath: string;
    readonly bytes: number;
    readonly ref: string;
  }>;
  /** 文件清单（路径 + 预估字节数；D18 preview 与预检共用） */
  readonly files: readonly LearningPackPreviewFile[];
  /** 内容合计字节数（不含 zip 容器开销） */
  readonly totalBytes: number;
  /** studentId → 化名（真名模式为 displayName；ink 命名与测试断言用） */
  readonly displayNameOf: ReadonlyMap<string, string>;
}

/**
 * 装配数据包（preview 与生成的共用核心）：
 * 1. 域校验（学生/课程/作业/讲义逐个 404）→ 2. 时间窗 → 3. 范围内已交卷
 * attempt → 4. 学生名单（显式顺序或 displayName 排序）与化名 → 5. 按勾选
 * 模块装配各 section → 6. pack.json / summary.md / prompt.md / schema.json /
 * 映射.txt 与 ink 清单 → 7. 文件清单与合计字节。
 */
export function assembleLearningPack(
  db: Db,
  dataDir: string,
  teacherId: string,
  request: LearningPackExportRequest,
  options: LearningPackServiceOptions = {},
): LearningPackAssembly {
  const nowMs =
    typeof options.now === "string"
      ? Date.parse(options.now)
      : (options.now ?? new Date()).getTime();
  const nowIso = new Date(nowMs).toISOString();
  const fromIso =
    request.scope.days === "all"
      ? null
      : new Date(nowMs - request.scope.days * DAY_MS).toISOString();
  const m = request.modules;

  // —— 1. 域校验（先验后取，404 不暴露存在性） ——
  const explicitStudents: Array<{
    id: string;
    displayName: string;
    archivedAt: string | null;
  }> = [];
  const seenStudentIds = new Set<string>();
  for (const studentId of request.scope.studentIds ?? []) {
    if (seenStudentIds.has(studentId)) continue; // 去重保序（化名编号稳定）
    seenStudentIds.add(studentId);
    explicitStudents.push(requireOwnedStudent(db, teacherId, studentId));
  }
  if (request.scope.courseId !== undefined) {
    requireOwnedCourse(db, teacherId, request.scope.courseId);
  }
  if (request.scope.assignmentId !== undefined) {
    requireOwnedAssignment(db, teacherId, request.scope.assignmentId);
  }
  const lectureRows = m.lectures.map((pick) => ({
    pick,
    lecture: requireOwnedLecture(db, teacherId, pick.lectureId),
  }));

  // —— 2/3. 范围内已交卷 attempt（域过滤 + 窗口 + 交叉筛选） ——
  const filters = [
    eq(students.teacherId, teacherId),
    ne(attempts.status, "draft"), // D15：历次=已交卷历次，draft 不收录
    isNotNull(attempts.submittedAt),
    lte(attempts.submittedAt, nowIso),
    fromIso !== null ? gte(attempts.submittedAt, fromIso) : undefined,
    request.scope.studentIds !== undefined
      ? inArray(attempts.studentId, [...seenStudentIds])
      : undefined,
    request.scope.assignmentId !== undefined
      ? eq(attempts.assignmentId, request.scope.assignmentId)
      : undefined,
  ].filter((item): item is NonNullable<typeof item> => item !== undefined);
  const scopeAttempts = db
    .select({ attempt: attempts })
    .from(attempts)
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(and(...filters))
    .orderBy(asc(attempts.submittedAt), asc(attempts.id))
    .all()
    .map((row) => row.attempt)
    .filter((attempt) => {
      if (request.scope.courseId === undefined) return true;
      // 作业作答的课程以作业行兜底（T2A.7 同款口径）
      if (attempt.courseId === request.scope.courseId) return true;
      if (attempt.assignmentId === null) return false;
      const assignment = db
        .select({ courseId: assignments.courseId })
        .from(assignments)
        .where(eq(assignments.id, attempt.assignmentId))
        .get();
      return assignment?.courseId === request.scope.courseId;
    });

  // —— 4. 学生名单与化名（D16） ——
  let roster: Array<{
    id: string;
    displayName: string;
    archived: boolean;
  }>;
  if (explicitStudents.length > 0) {
    roster = explicitStudents.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      archived: row.archivedAt !== null,
    }));
  } else {
    // 无显式名单：取范围内出现的学生，displayName 升序稳定排序
    const ids = [...new Set(scopeAttempts.map((attempt) => attempt.studentId))];
    const rows = ids.map((id) => requireOwnedStudent(db, teacherId, id));
    rows.sort(
      (a, b) =>
        a.displayName.localeCompare(b.displayName, "zh-Hans-CN") ||
        a.id.localeCompare(b.id),
    );
    roster = rows.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      archived: row.archivedAt !== null,
    }));
  }
  const anonymized = request.privacy.anonymize;
  const displayNameOf = new Map<string, string>();
  roster.forEach((student, index) => {
    displayNameOf.set(
      student.id,
      anonymized ? learningPackAliasOf(index) : student.displayName,
    );
  });

  // —— 5. 范围内 responses（各 section 共用） ——
  const responsesByAttempt = new Map<string, ResponseRow[]>();
  for (const ids of chunk(scopeAttempts.map((attempt) => attempt.id))) {
    for (const row of db
      .select()
      .from(responses)
      .where(inArray(responses.attemptId, ids))
      // rowid 序＝attemptResponseRows 同序（复审 C15：预取行喂展示序装配）
      .orderBy(sql`rowid`)
      .all()) {
      const list = responsesByAttempt.get(row.attemptId);
      if (list === undefined) responsesByAttempt.set(row.attemptId, [row]);
      else list.push(row);
    }
  }
  // 按学生（名单顺序）→ 提交时间排布 attempt（summary 与逐题的遍历序）
  const rosterIndex = new Map(
    roster.map((student, i) => [student.id, i] as const),
  );
  const orderedAttempts = [...scopeAttempts].sort(
    (a, b) =>
      (rosterIndex.get(a.studentId) ?? 0) -
        (rosterIndex.get(b.studentId) ?? 0) ||
      (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "") ||
      a.id.localeCompare(b.id),
  );

  // —— ink 条目（勾选 ink 才装配；化名贯穿文件名 D16） ——
  const inkEntryByAttemptQuestion = new Map<string, string>();
  const inkEntries: Array<{ entry: string; absPath: string; bytes: number }> =
    [];
  if (m.ink) {
    const studentIdOfAttempt = new Map(
      scopeAttempts.map((attempt) => [attempt.id, attempt.studentId] as const),
    );
    for (const ids of chunk(scopeAttempts.map((attempt) => attempt.id))) {
      const rows: InkRow[] = db
        .select()
        .from(ink)
        .where(inArray(ink.attemptId, ids))
        .all();
      for (const row of rows) {
        const studentId = studentIdOfAttempt.get(row.attemptId);
        const name =
          studentId !== undefined
            ? (displayNameOf.get(studentId) ?? "学生?")
            : "学生?";
        let entry = `ink/${name}-${zipSafeQuestionName(row.questionId)}-${row.attemptId.slice(0, 8)}.png`;
        if (inkEntries.some((item) => item.entry === entry)) {
          entry = `ink/${name}-${zipSafeQuestionName(row.questionId)}-${row.attemptId}.png`;
        }
        // 目录边界（T6R.14 收敛，T6R.12 安全审查留档「既有」）：旧内联
        // `abs.startsWith(inkRoot)` 会被同前缀相邻目录（blobs/inkfoo）骗过，
        // 换 ink-service 既有薄壳 inkFileAbs（lib/blob-io 的 path.relative
        // 强算法 + blobs/ink 根 + 同错误码 INK_UNREADABLE；review-pack 的
        // ink 装配同构场景即走它）。不传后缀 = 保持旧语义精确等价（无后缀
        // 白名单检查）。
        const absPath = inkFileAbs(dataDir, row.pngPath, undefined);
        let bytes: number;
        try {
          bytes = statSync(absPath).size;
        } catch {
          continue; // 快照文件缺失（ink-service 404 同款语义）：跳过该条目
        }
        inkEntries.push({ entry, absPath, bytes });
        inkEntryByAttemptQuestion.set(
          `${row.attemptId}:${row.questionId}`,
          entry,
        );
      }
    }
  }

  // —— content.lectures（D14：大纲 + 勾选小节全文） ——
  const lectureItems: LearningPackLecture[] = lectureRows.map(
    ({ pick, lecture }) => {
      const structure = analyzeLectureStructure(lecture.markdown);
      const ranges = sectionRangesOf(lecture.markdown);
      const lines = lecture.markdown.split(/\r?\n/);
      const picked = [...new Set(pick.sectionIndexes)]
        .filter((index) => index < structure.sections.length)
        .sort((a, b) => a - b);
      return {
        lectureId: lecture.id,
        title: lecture.title,
        outline: structure.sections.map((section) => ({
          level: section.level,
          text: section.text,
        })),
        sections: picked.map((headingIndex) => {
          const range = ranges[headingIndex];
          const markdown =
            range === undefined
              ? ""
              : lines
                  .slice(range[0] - 1, range[1])
                  .join("\n")
                  .trim();
          return { headingIndex, markdown };
        }),
      };
    },
  );

  /** v2（T6R.12）：请求显式 packVersion=2 才走证据装配链；缺省 v1 零变化 */
  const isV2 = request.packVersion === 2;
  /**
   * 展示序行缓存（frozenRowsInDisplayOrder 统一口径；复审 C11/C15/D23：
   * 证据 scope/逐题行/traces 三处共用，预取行（rowid 序）直接喂入——
   * 不再二次装载，v1 同样吃缓存；orderedResponsesOf 收编为单一入口）。
   */
  const displayRowsByAttempt = new Map<string, ResponseRow[]>(
    orderedAttempts.map(
      (attempt) =>
        [
          attempt.id,
          frozenRowsInDisplayOrder(
            db,
            attempt,
            responsesByAttempt.get(attempt.id),
          ).map((entry) => entry.row),
        ] as const,
    ),
  );
  const displayRowsOf = (attempt: Attempt): ResponseRow[] =>
    displayRowsByAttempt.get(attempt.id) ?? [];

  // —— attempts.responses / attempts.summaries / traces.questions 共用的逐题行序 ——
  const traceByAttempt = new Map<
    string,
    Record<string, ReturnType<typeof computeAttemptTraceMetrics>[string]>
  >();
  const needTraces = m.traces;
  const needSummary = m.responses || m.summaries || m.traces;
  const offlineAgg = new Map<string, { active: number; offline: number }>();
  if (needTraces || needSummary) {
    // 装载事件流并计算每 attempt 的派生指标（原始 events 不出库，D13）
    for (const ids of chunk(orderedAttempts.map((attempt) => attempt.id))) {
      const rawRowsByAttempt = new Map<
        string,
        Array<{
          type: string;
          clientTs: number;
          serverTs: string;
          payloadJson: string;
        }>
      >();
      for (const row of db
        .select({
          attemptId: events.attemptId,
          type: events.type,
          clientTs: events.clientTs,
          serverTs: events.serverTs,
          payloadJson: events.payloadJson,
        })
        .from(events)
        .where(inArray(events.attemptId, ids))
        .all()) {
        if (row.attemptId === null) continue;
        const projected = {
          type: row.type,
          clientTs: row.clientTs,
          serverTs: row.serverTs,
          payloadJson: row.payloadJson,
        };
        const list = rawRowsByAttempt.get(row.attemptId);
        if (list === undefined)
          rawRowsByAttempt.set(row.attemptId, [projected]);
        else list.push(projected);
      }
      for (const attemptId of ids) {
        const activeSecByQuestion: Record<string, number> = {};
        for (const response of responsesByAttempt.get(attemptId) ?? []) {
          if (response.activeSec !== null && response.activeSec > 0) {
            activeSecByQuestion[response.questionId] = response.activeSec;
          }
        }
        const trace: TraceEvent[] = traceEventsFromRows(
          rawRowsByAttempt.get(attemptId) ?? [],
        );
        const metrics = computeAttemptTraceMetrics(trace, activeSecByQuestion);
        traceByAttempt.set(attemptId, metrics);
        // 离线占比聚合（activeSec 加权；与学情页 buildOffline 同口径）
        const agg = offlineAgg.get(attemptId) ?? { active: 0, offline: 0 };
        for (const [questionId, sec] of Object.entries(activeSecByQuestion)) {
          agg.active += sec;
          agg.offline += (metrics[questionId]?.offlineShare ?? 0) * sec;
        }
        offlineAgg.set(attemptId, agg);
      }
    }
  }

  // —— attempts.summaries（D15：attemptNo 与 isFirst） ——
  const summaryRows: LearningPackAttemptSummary[] = [];
  if (m.summaries) {
    for (const attempt of orderedAttempts) {
      const source = sourceOf(db, attempt, teacherId);
      const rows = responsesByAttempt.get(attempt.id) ?? [];
      let correct = 0;
      let wrong = 0;
      let pending = 0;
      for (const row of rows) {
        if (row.finalCorrect === null) pending += 1;
        else if (row.finalCorrect) correct += 1;
        else wrong += 1;
      }
      summaryRows.push({
        attemptId: attempt.id,
        studentId: attempt.studentId,
        sourceType: source.sourceType,
        assignmentId: source.assignmentId,
        assignmentTitle: source.assignmentTitle,
        courseId: source.courseId,
        courseName: source.courseName,
        unitId: source.unitId,
        unitTitle: source.unitTitle,
        attemptNo: attempt.attemptNo,
        isFirst: attempt.attemptNo === 1,
        status: attempt.status,
        startedAt: attempt.startedAt,
        submittedAt: attempt.submittedAt ?? "",
        scoreAuto: attempt.scoreAuto,
        scoreFinal: attempt.scoreFinal,
        questionCount: rows.length,
        correctCount: correct,
        wrongCount: wrong,
        pendingCount: pending,
      });
    }
  }

  // —— traces.questions（D13 派生指标） ——
  const traceRows: LearningPackQuestionTrace[] = [];
  if (m.traces) {
    for (const attempt of orderedAttempts) {
      const metrics = traceByAttempt.get(attempt.id) ?? {};
      for (const row of displayRowsOf(attempt)) {
        const metric = metrics[row.questionId];
        traceRows.push({
          attemptId: attempt.id,
          studentId: attempt.studentId,
          questionId: row.questionId,
          activeSec: row.activeSec,
          hintsUsed: row.hintsUsed,
          changeCount: row.changeCount,
          timeToFirstHintSec: metric?.timeToFirstHintSec ?? null,
          hintDwellSec: metric?.hintDwellSec ?? 0,
          inkEditCount: metric?.inkEditCount ?? 0,
          fullscreenUsed: metric?.fullscreenUsed ?? false,
          offlineShare: metric?.offlineShare ?? 0,
          reviewedSolution: metric?.reviewedSolution ?? false,
        });
      }
    }
  }

  // —— traces.lectures（阅读地图；scope 学生的全部阅读讲义，courseId 筛选同 D3） ——
  const lectureTraceRows: LearningPackLectureTrace[] = [];
  if (m.traces) {
    let inCourseLectures: Set<string> | null = null;
    if (request.scope.courseId !== undefined) {
      inCourseLectures = new Set(
        db
          .select({ refId: courseItems.refId })
          .from(courseItems)
          .where(
            and(
              eq(courseItems.courseId, request.scope.courseId),
              eq(courseItems.kind, "lecture"),
            ),
          )
          .all()
          .map((row) => row.refId)
          .filter((id): id is string => id !== null),
      );
    }
    for (const student of roster) {
      const readIds = db
        .selectDistinct({ lectureId: events.lectureId })
        .from(events)
        .where(
          and(eq(events.studentId, student.id), isNotNull(events.lectureId)),
        )
        .all()
        .map((row) => row.lectureId)
        .filter((id): id is string => id !== null);
      const entries = readIds
        .filter((id) => inCourseLectures === null || inCourseLectures.has(id))
        .map((lectureId) => {
          const map = lectureReadingMapFor(db, student.id, lectureId);
          if (map === null) return null;
          const lecture = db
            .select({ title: lectures.title })
            .from(lectures)
            .where(eq(lectures.id, lectureId))
            .get();
          if (lecture === undefined) return null;
          return {
            studentId: student.id,
            lectureId,
            title: lecture.title,
            map: {
              sections: map.sections.map((section) => ({ ...section })),
              folds: map.folds.map((fold) => ({ ...fold })),
              steps: map.steps.map((step) => ({
                ...step,
                paceSec: [...step.paceSec],
              })),
              summary: { ...map.summary },
            },
          } satisfies LearningPackLectureTrace;
        })
        .filter((entry): entry is LearningPackLectureTrace => entry !== null);
      entries.sort(
        (a, b) =>
          a.title.localeCompare(b.title, "zh-Hans-CN") ||
          a.lectureId.localeCompare(b.lectureId),
      );
      lectureTraceRows.push(...entries);
    }
  }

  // —— summary section（D4 口径；供 summary.md 与 pack.summary） ——
  let summarySection: LearningPackSummarySection | undefined;
  if (needSummary) {
    const perStudent: LearningPackStudentSummary[] = roster.map((student) => {
      const mine = orderedAttempts.filter(
        (attempt) => attempt.studentId === student.id,
      );
      let judged = 0;
      let correct = 0;
      let pending = 0;
      let activeTotal = 0;
      for (const attempt of mine) {
        for (const row of responsesByAttempt.get(attempt.id) ?? []) {
          if (row.finalCorrect === null) pending += 1;
          else {
            judged += 1;
            if (row.finalCorrect) correct += 1;
          }
          if (row.activeSec !== null) activeTotal += row.activeSec;
        }
      }
      const offline = mine.reduce((sum, attempt) => {
        const agg = offlineAgg.get(attempt.id);
        return sum + (agg?.offline ?? 0);
      }, 0);
      return {
        studentId: student.id,
        name: displayNameOf.get(student.id) ?? student.displayName,
        attemptCount: mine.length,
        judgedCount: judged,
        correctCount: correct,
        pendingCount: pending,
        correctRate: judged > 0 ? correct / judged : null,
        activeSecTotal: activeTotal,
        offlineShare: activeTotal > 0 ? Math.min(1, offline / activeTotal) : 0,
      };
    });
    const overall = perStudent.reduce(
      (acc, row) => ({
        attemptCount: acc.attemptCount + row.attemptCount,
        judgedCount: acc.judgedCount + row.judgedCount,
        correctCount: acc.correctCount + row.correctCount,
        pendingCount: acc.pendingCount + row.pendingCount,
        activeSecTotal: acc.activeSecTotal + row.activeSecTotal,
      }),
      {
        attemptCount: 0,
        judgedCount: 0,
        correctCount: 0,
        pendingCount: 0,
        activeSecTotal: 0,
      },
    );
    // questionCount：逐题行总数（全部历次 responses 行）
    const questionCount = orderedAttempts.reduce(
      (sum, attempt) => sum + (responsesByAttempt.get(attempt.id)?.length ?? 0),
      0,
    );
    const offlineTotal = orderedAttempts.reduce(
      (sum, attempt) => sum + (offlineAgg.get(attempt.id)?.offline ?? 0),
      0,
    );
    summarySection = {
      students: perStudent,
      overall: {
        studentCount: roster.length,
        attemptCount: overall.attemptCount,
        questionCount,
        judgedCount: overall.judgedCount,
        correctCount: overall.correctCount,
        pendingCount: overall.pendingCount,
        correctRate:
          overall.judgedCount > 0
            ? overall.correctCount / overall.judgedCount
            : null,
        activeSecTotal: overall.activeSecTotal,
        offlineShare:
          overall.activeSecTotal > 0
            ? Math.min(1, offlineTotal / overall.activeSecTotal)
            : 0,
      },
    };
  }

  // —— 映射.txt（化名模式才生成；不进 pack.json，D16） ——
  const mappingTxt = anonymized
    ? [
        "学情数据包 · 化名映射",
        "",
        `导出时间：${beijingDateTimeOf(nowIso)}（北京时间）`,
        "本文件仅供教师本人保存，请勿随数据包转发给他人或 AI。",
        "",
        ...roster.map(
          (student, index) =>
            `${learningPackAliasOf(index)} = ${student.displayName}`,
        ),
        "",
      ].join("\n")
    : null;

  // —— 共享前置收口与版本派发（复审 B3：isV2 分支收编为 assembleV1/V2；
  // media 扫描/responses 过滤/packFilesOf 参数/renderSummaryMd 类型撑宽全消） ——
  const core: PackCore = {
    db,
    dataDir,
    teacherId,
    request,
    m,
    nowIso,
    fromIso,
    anonymized,
    roster,
    displayNameOf,
    responsesByAttempt,
    orderedAttempts,
    displayRowsOf,
    inkEntries,
    inkEntryByAttemptQuestion,
    lectureItems,
    summaryRows,
    traceRows,
    lectureTraceRows,
    summarySection,
    mappingTxt,
  };
  if (isV2) {
    return assembleV2(core);
  }
  return assembleV1(core);
}

// ---------- v1/v2 共享前置与骨架（复审 B3） ----------

/** 装配共享前置：域校验/时间窗/scope/化名之后、版本专属装配之前的全部结果 */
interface PackCore {
  readonly db: Db;
  readonly dataDir: string;
  readonly teacherId: string;
  readonly request: LearningPackExportRequest;
  readonly m: LearningPackModules;
  readonly nowIso: string;
  readonly fromIso: string | null;
  readonly anonymized: boolean;
  readonly roster: ReadonlyArray<{
    id: string;
    displayName: string;
    archived: boolean;
  }>;
  readonly displayNameOf: ReadonlyMap<string, string>;
  readonly responsesByAttempt: ReadonlyMap<string, ResponseRow[]>;
  readonly orderedAttempts: readonly Attempt[];
  /** 该 attempt 的逐题展示序（frozenRowsInDisplayOrder 统一口径；预取行喂给） */
  readonly displayRowsOf: (attempt: Attempt) => ResponseRow[];
  readonly inkEntries: ReadonlyArray<{
    entry: string;
    absPath: string;
    bytes: number;
  }>;
  readonly inkEntryByAttemptQuestion: ReadonlyMap<string, string>;
  readonly lectureItems: LearningPackLecture[];
  readonly summaryRows: LearningPackAttemptSummary[];
  readonly traceRows: LearningPackQuestionTrace[];
  readonly lectureTraceRows: LearningPackLectureTrace[];
  readonly summarySection: LearningPackSummarySection | undefined;
  readonly mappingTxt: string | null;
}

/**
 * prompt.md 渲染（v1/v2 共用；复审 A9 移入版本侧——media 旗标依赖该版本的
 * 媒体装配结果，交付清单按模块枚举 evidence/ink/blobs-media 目录）。
 */
function renderPromptMdOf(core: PackCore, mediaPresent: boolean): string {
  const m = core.m;
  return renderLearningPackPrompt({
    goal: core.request.goal,
    lectures: m.lectures.length > 0,
    questionLevel: m.questions ?? null,
    responses: m.responses,
    summaries: m.summaries,
    ink: m.ink,
    traces: m.traces,
    ...(m.evidence ? { evidence: true } : {}),
    ...(mediaPresent ? { media: true } : {}),
    anonymized: core.anonymized,
    ...(core.request.customPrompt !== undefined &&
    core.request.customPrompt.length > 0
      ? { customPrompt: core.request.customPrompt }
      : {}),
  });
}

/** pack 头部（meta + students）：v1/v2 骨架同款，仅 version 与 evidence 回显差异 */
/** 模块回显形态：v2 恒含 evidence，v1 无该键（与两版 meta.modules 契约一致） */
interface PackHeaderModules {
  lectures: boolean;
  questions: "stem" | "answer" | "solution" | null;
  responses: boolean;
  summaries: boolean;
  ink: boolean;
  traces: boolean;
}
type PackHeaderOf<V extends 1 | 2> = {
  meta: {
    version: V;
    generatedAt: string;
    goal: LearningPackGoal;
    days: number | "all";
    from: string | null;
    to: string;
    anonymized: boolean;
    modules: V extends 2
      ? PackHeaderModules & { evidence: boolean }
      : PackHeaderModules;
    note: string;
  };
  students: Array<{ id: string; name: string; archived: boolean }>;
};

function packHeaderOf<V extends 1 | 2>(
  core: PackCore,
  version: V,
  evidenceEcho: V extends 2 ? boolean : undefined,
): PackHeaderOf<V> {
  const m = core.m;
  const base = {
    lectures: m.lectures.length > 0,
    questions: m.questions ?? null,
    responses: m.responses,
    summaries: m.summaries,
    ink: m.ink,
    traces: m.traces,
  };
  // 条件类型的联合窄化是 TS 已知局限：此处单一断言收敛（值域由两处调用点
  // 的字面量 version 保证，无 any）
  const modules = (
    version === 2 ? { ...base, evidence: evidenceEcho } : { ...base }
  ) as PackHeaderOf<V>["meta"]["modules"];
  return {
    meta: {
      version,
      generatedAt: core.nowIso,
      goal: core.request.goal,
      days: core.request.scope.days,
      from: core.fromIso,
      to: core.nowIso,
      anonymized: core.anonymized,
      modules,
      note: "评语为教师原文（不改动），可能包含学生真实姓名；学习痕迹指标与阅读状态均为行为推断，仅供参考。",
    },
    students: core.roster.map((student) => ({
      id: student.id,
      name: core.displayNameOf.get(student.id) ?? student.displayName,
      archived: student.archived,
    })),
  };
}

/**
 * pack 条件 section（content/attempts/evidence/traces/summary）：v1/v2 骨架
 * 同款；questions/responses 条目类型由调用方按版本具型（泛型 Q/R），null =
 * 对应模块未勾选（该 section 缺席，D19）。evidence 仅 v2 携带（模块门控后
 * 传入，null 省略）。
 */
function packSectionsOf<Q, R>(
  core: PackCore,
  sections: {
    readonly questions: Q[] | null;
    readonly responses: R[] | null;
    readonly evidence: LearningPackEvidence[] | null;
  },
): {
  content?: { lectures?: LearningPackLecture[]; questions?: Q[] };
  attempts?: {
    responses?: R[];
    summaries?: LearningPackAttemptSummary[];
  };
  evidence?: LearningPackEvidence[];
  traces?: {
    questions: LearningPackQuestionTrace[];
    lectures: LearningPackLectureTrace[];
  };
  summary?: LearningPackSummarySection;
} {
  const m = core.m;
  return {
    ...(m.lectures.length > 0 || sections.questions !== null
      ? {
          content: {
            ...(m.lectures.length > 0 ? { lectures: core.lectureItems } : {}),
            ...(sections.questions !== null
              ? { questions: sections.questions }
              : {}),
          },
        }
      : {}),
    ...(m.responses || m.summaries
      ? {
          attempts: {
            ...(m.responses ? { responses: sections.responses ?? [] } : {}),
            ...(m.summaries ? { summaries: core.summaryRows } : {}),
          },
        }
      : {}),
    ...(sections.evidence !== null ? { evidence: sections.evidence } : {}),
    ...(m.traces
      ? {
          traces: {
            questions: core.traceRows,
            lectures: core.lectureTraceRows,
          },
        }
      : {}),
    ...(core.summarySection !== undefined
      ? { summary: core.summarySection }
      : {}),
  };
}

/**
 * 逐题作答行公共底座（v1/v2 同构 15 字段，复审 D19：两处手写重复收敛；
 * v2 在此之上 spread 快照关联三字段）。
 */
function responseBaseOf(
  core: PackCore,
  attempt: Attempt,
  row: ResponseRow,
  no: number,
): LearningPackResponse {
  const inkFile = core.inkEntryByAttemptQuestion.get(
    `${attempt.id}:${row.questionId}`,
  );
  return {
    attemptId: attempt.id,
    studentId: attempt.studentId,
    questionId: row.questionId,
    no,
    answerText: serializeStudentAnswer(answerOf(row.answerJson)),
    autoCorrect: row.autoCorrect,
    finalCorrect: row.finalCorrect,
    teacherMark:
      row.teacherMark === "correct" || row.teacherMark === "wrong"
        ? row.teacherMark
        : null,
    teacherComment: row.teacherComment,
    ...(inkFile !== undefined ? { inkFile } : {}),
  };
}

/**
 * 讲义切片 ::image 引用的落盘扫描（v1/v2 共用骨架，复审 D24）：
 * v1 额外把题目 md 文本并入同一次提取（跨源去重与首见序是 v1 既有口径）并
 * **忽略缺失**（静默跳过）；v2 只扫讲义、缺失显式返回（题目侧由证据装配
 * 另行提供并去重合并）。
 */
function lectureMediaOf(
  core: PackCore,
  dataDir: string,
  extraTexts: readonly string[] = [],
): {
  present: Array<{ entry: string; absPath: string; bytes: number }>;
  missing: Array<{ src: string; reason: string }>;
} {
  const mdTexts: string[] = [];
  for (const item of core.lectureItems) {
    for (const section of item.sections) mdTexts.push(section.markdown);
  }
  mdTexts.push(...extraTexts);
  const present: Array<{ entry: string; absPath: string; bytes: number }> = [];
  const missing: Array<{ src: string; reason: string }> = [];
  for (const src of extractMediaImageSrcs(mdTexts)) {
    const stat = statMediaSrc(dataDir, src);
    if ("absPath" in stat) {
      present.push({ entry: src, absPath: stat.absPath, bytes: stat.bytes });
    } else {
      missing.push({ src, reason: stat.reason });
    }
  }
  return { present, missing };
}

// ---------- v1 装配（缺省路径：形状与行为逐字节锁定） ----------

function assembleV1(core: PackCore): LearningPackAssembly {
  const { db, dataDir, teacherId, request, m } = core;
  // —— content.questions（v1：同 qid 取最新一次提交的快照，既有口径锁定不改） ——
  const questionItems: LearningPackQuestion[] = [];
  if (m.questions !== undefined) {
    const latestSnapshot = new Map<string, { row: ResponseRow; at: string }>();
    for (const attempt of core.orderedAttempts) {
      const at = attempt.submittedAt ?? "";
      for (const row of core.responsesByAttempt.get(attempt.id) ?? []) {
        const prev = latestSnapshot.get(row.questionId);
        if (prev === undefined || at >= prev.at) {
          latestSnapshot.set(row.questionId, { row, at });
        }
      }
    }
    // 元信息查询收窄（复审 C17）：只取卷内出现的 qid（inArray），不带 stemMd 列
    const metaOf = new Map<
      string,
      { id: string; unitId: string; order: number }
    >();
    const latestIds = [...latestSnapshot.keys()];
    if (latestIds.length > 0) {
      for (const row of db
        .select({
          id: questions.id,
          unitId: questions.unitId,
          order: questions.order,
        })
        .from(questions)
        .where(
          and(
            eq(questions.teacherId, teacherId),
            inArray(questions.id, latestIds),
          ),
        )
        .all()) {
        metaOf.set(row.id, row);
      }
    }
    for (const [questionId, { row }] of latestSnapshot) {
      const snapshot = snapshotOfRow(row);
      const meta = metaOf.get(questionId);
      // T6R.3：快照缺失按**显式缺失**处理（空题干），不拿当前题库兜底；
      // 投影/层级切片经 materialOf 单点（复审 B2，与 v2 同一实现；教师角色
      // 不触发学生哨兵）
      const material = materialOf(snapshot, false, m.questions);
      const item: LearningPackQuestion = {
        questionId,
        unitId: meta?.unitId ?? null,
        unitTitle: null, // 下方统一回填
        type: material.type,
        difficulty: material.difficulty,
        knowledge: [...material.knowledge],
        stemMd: material.stemMd,
      };
      if (material.options !== undefined) item.options = [...material.options];
      if (material.answers !== undefined) item.answers = material.answers;
      if (material.solutionMd !== undefined)
        item.solutionMd = material.solutionMd;
      questionItems.push(item);
    }
    // 单元标题统一回填（域内 units 表，含软删——历史统计不消失）+ 排序（单元内题序）
    backfillUnitTitles(db, teacherId, questionItems);
    questionItems.sort((a, b) => {
      const metaA = metaOf.get(a.questionId);
      const metaB = metaOf.get(b.questionId);
      if (metaA !== undefined && metaB !== undefined) {
        return (
          metaA.unitId.localeCompare(metaB.unitId) ||
          metaA.order - metaB.order ||
          a.questionId.localeCompare(b.questionId)
        );
      }
      if (metaA !== undefined) return -1;
      if (metaB !== undefined) return 1;
      return a.questionId.localeCompare(b.questionId);
    });
  }

  // —— media 条目（::image 引用的图片打进 zip，条目名 = src 原相对路径） ——
  // v1 扫描进入 pack 的全部 md 文本（讲义切片 + 题干与详解，同一提取内跨源
  // 去重）；缺文件静默跳过（既有口径；v2 的缺失显式登记见 assembleV2）
  const questionTexts: string[] = [];
  if (m.questions !== undefined) {
    for (const item of questionItems) {
      questionTexts.push(item.stemMd);
      if (item.solutionMd !== undefined) questionTexts.push(item.solutionMd);
    }
  }
  // v1 忽略 missing（同 ink 缺文件口径，零变化）
  const mediaEntries = lectureMediaOf(core, dataDir, questionTexts).present;

  // —— prompt.md（媒体装配后渲染：media 旗标按实际在场配图传入，复审 A9） ——
  const promptMd = renderPromptMdOf(core, mediaEntries.length > 0);

  // —— attempts.responses（D15 全部历次；评语原文不改动 D16） ——
  const responseRows: LearningPackResponse[] = [];
  if (m.responses) {
    for (const attempt of core.orderedAttempts) {
      let no = 0;
      for (const row of core.displayRowsOf(attempt)) {
        no += 1;
        responseRows.push(responseBaseOf(core, attempt, row, no));
      }
    }
  }

  // —— pack.json（未勾选的 section 不出现，D19） ——
  const pack: LearningPack = {
    ...packHeaderOf(core, 1 as const, undefined),
    ...packSectionsOf(core, {
      questions: m.questions !== undefined ? questionItems : null,
      responses: m.responses ? responseRows : null,
      evidence: null,
    }),
  };
  // 服务端自检：直接校验内存对象（复审 C16；序列化一致性由既有测试锁定）
  learningPackSchema.parse(pack);
  const packJson = `${JSON.stringify(pack, null, 2)}\n`;

  // —— schema.json（与 schema:export 产物逐字节一致，D19） ——
  const schemaJson = `${JSON.stringify(learningPackJsonSchema(), null, 2)}\n`;

  // —— summary.md（人类可读；只统计勾选模块，D19） ——
  const summaryMd = renderSummaryMd({
    request,
    pack,
    lectureItems: core.lectureItems,
    questionItems,
    summaryRows: core.summaryRows,
    responseRows,
    traceRows: core.traceRows,
    lectureTraceRows: core.lectureTraceRows,
    inkEntries: core.inkEntries,
    mediaEntries,
    evidenceEntries: [],
    displayNameOf: core.displayNameOf,
    nowIso: core.nowIso,
  });

  // —— 文件清单与合计（D18 预检与 preview 共用；不含 zip 容器开销） ——
  const files = packFilesOf({
    packJsonBytes: Buffer.byteLength(packJson, "utf8"),
    summaryMd,
    promptMd,
    schemaJson,
    mappingTxt: core.mappingTxt,
    inkEntries: core.inkEntries,
    mediaEntries,
  });

  return {
    packJson,
    summaryMd,
    promptMd,
    schemaJson,
    mappingTxt: core.mappingTxt,
    inkEntries: core.inkEntries,
    mediaEntries,
    evidenceEntries: [],
    files,
    totalBytes: files.reduce((sum, file) => sum + file.estimatedBytes, 0),
    displayNameOf: core.displayNameOf,
  };
}

// ---------- v2 装配（T6R.12：证据装配、快照关联与 manifest） ----------

function assembleV2(core: PackCore): LearningPackAssembly {
  const { db, dataDir, teacherId, request, m } = core;
  // evidenceAsm 在本函数内为 const（复审 B3：原 6 处判空/防御 throw 全消，
  // 仅保留行级映射不变量的两处快速失败）
  /**
   * 装配需求（复审 C18）：题目条目/证据条目/逐题配对键任一需要才装载行集；
   * 全不需要（如仅讲义+汇总）时传空 scope——evidenceAsm 恒为 const 非空，
   * 各 section 天然为空，无需下游判空。媒体清单只在题目模块勾选时装配
   * （assembleMedia，「未选模块不夹带内容」）。
   */
  const needsAssembly = m.questions !== undefined || m.evidence || m.responses;
  const evidenceAsm = assembleQuestionEvidence(
    db,
    dataDir,
    teacherId,
    needsAssembly
      ? core.orderedAttempts.map((attempt) => ({
          attempt,
          rows: core.displayRowsOf(attempt),
        }))
      : [],
    {
      role: "teacher",
      // 题目模块未勾选时 material 不进包，层级取最小权限层
      ...(m.questions !== undefined ? { questionLevel: m.questions } : {}),
      includeEvidence: m.evidence,
      ...(m.questions !== undefined ? { assembleMedia: true } : {}),
    },
  );

  // —— content.questions（快照一一配对；条目序 = 装配首见序即配对序，不排序） ——
  const questionItemsV2: LearningPackV2Question[] = [];
  /**
   * media src ↔ q 条目 双向关联（一次遍历同产两份，复审 B3：消双转置）。
   * **只在 questions 模块勾选时登记**（复审 A4）：题目条目与 manifest refs
   * 都不携带未选模块的关系，refs 不悬空、不外泄。
   */
  const mediaRefsBySrc = new Map<string, string[]>();
  if (m.questions !== undefined) {
    const mediaByRef = new Map<
      string,
      Array<{ src: string; present: boolean }>
    >();
    const registerQuestionMedia = (
      src: string,
      present: boolean,
      refs: readonly string[],
    ) => {
      mediaRefsBySrc.set(src, [...refs]);
      for (const ref of refs) {
        const list = mediaByRef.get(ref);
        if (list === undefined) mediaByRef.set(ref, [{ src, present }]);
        else if (!list.some((item) => item.src === src))
          list.push({ src, present });
      }
    };
    for (const medium of evidenceAsm.media) {
      registerQuestionMedia(medium.src, true, medium.questionRefs);
    }
    for (const miss of evidenceAsm.missingMedia) {
      registerQuestionMedia(miss.src, false, miss.questionRefs);
    }
    for (const revision of evidenceAsm.revisions) {
      questionItemsV2.push({
        ref: revision.ref,
        questionId: revision.questionId,
        unitId: revision.unitId,
        unitTitle: null, // 下方统一回填
        type: revision.material.type,
        difficulty: revision.material.difficulty,
        knowledge: [...revision.material.knowledge],
        stemMd: revision.material.stemMd,
        present: revision.present,
        snapshotHash: revision.snapshotHash,
        media: mediaByRef.get(revision.ref) ?? [],
        ...(revision.material.options !== undefined
          ? { options: [...revision.material.options] }
          : {}),
        ...(revision.material.answers !== undefined
          ? { answers: revision.material.answers }
          : {}),
        ...(revision.material.solutionMd !== undefined
          ? { solutionMd: revision.material.solutionMd }
          : {}),
      });
    }
    // 单元标题统一回填（域内 units 表，含软删——历史统计不消失）
    backfillUnitTitles(db, teacherId, questionItemsV2);
  }

  // —— media 条目：讲义切片扫描 + 题目媒体并入（同 src 双源去重，复审 C12：
  // 防同图双 zip 条目/totalBytes 双计/manifest 重复行） ——
  const mediaEntries: Array<{ entry: string; absPath: string; bytes: number }> =
    [];
  /**
   * v2 manifest.missing 的 media 行（缺失显式登记，不静默跳过）。
   * Map 化按 path 去重（复审 A6）：讲义先行行与题目侧行同 src 时**合并 refs**
   * （与在场分支对称——讲义无关联 refs=[]，题目侧并入时补上 q 条目关联）。
   */
  const missingMediaByPath = new Map<
    string,
    { path: string; kind: "media"; reason: string; refs: string[] }
  >();
  const upsertMissingMedia = (
    src: string,
    reason: string,
    refs: readonly string[],
  ) => {
    const existing = missingMediaByPath.get(src);
    if (existing === undefined) {
      missingMediaByPath.set(src, {
        path: src,
        kind: "media",
        reason,
        refs: [...refs],
      });
      return;
    }
    for (const ref of refs) {
      if (!existing.refs.includes(ref)) existing.refs.push(ref);
    }
  };
  {
    const lectureMedia = lectureMediaOf(core, dataDir);
    const seenEntry = new Set<string>();
    for (const item of lectureMedia.present) {
      seenEntry.add(item.entry);
      mediaEntries.push(item);
    }
    for (const miss of lectureMedia.missing) {
      upsertMissingMedia(miss.src, miss.reason, []);
    }
    // v2 题目媒体：证据装配结果并入（refs 关联 q 条目），已被讲义收录的 src
    // 跳过；题目模块未勾选时不并入也不登记缺失——「未选模块不夹带内容」（§9.2）
    if (m.questions !== undefined) {
      for (const medium of evidenceAsm.media) {
        if (seenEntry.has(medium.src)) continue;
        seenEntry.add(medium.src);
        mediaEntries.push({
          entry: medium.src,
          absPath: medium.absPath,
          bytes: medium.bytes,
        });
      }
      for (const miss of evidenceAsm.missingMedia) {
        upsertMissingMedia(miss.src, miss.reason, miss.questionRefs);
      }
    }
  }

  // —— prompt.md（媒体装配后渲染：media 旗标按实际在场配图传入，复审 A9） ——
  const promptMd = renderPromptMdOf(core, mediaEntries.length > 0);

  // —— 证据图条目（evidence 模块勾选才装配；zip 写入与 preview 共用） ——
  // ready 分析图条目（T6R.13 /code-review D27：遍历收敛在 question-evidence
  // 共享件，与 review-pack 同一实现）
  const evidenceEntries: Array<{
    entry: string;
    absPath: string;
    bytes: number;
    ref: string;
  }> = [];
  if (m.evidence) {
    for (const evidenceEntry of evidenceAsm.evidence) {
      evidenceEntries.push(...readyEvidenceImagesOf(evidenceEntry));
    }
  }

  // —— attempts.responses（v2 行携带快照关联三字段，T6R.12） ——
  const responseRowsV2: LearningPackV2Response[] = [];
  const hashByRef = new Map(
    evidenceAsm.revisions.map(
      (revision) => [revision.ref, revision.snapshotHash] as const,
    ),
  );
  if (m.responses) {
    for (const attempt of core.orderedAttempts) {
      let no = 0;
      for (const row of core.displayRowsOf(attempt)) {
        no += 1;
        const base = responseBaseOf(core, attempt, row, no);
        // 快照关联（scope 覆盖全部行，映射缺项即装配不变量破坏，快速失败）
        const questionRef = evidenceAsm.refByResponseRowId.get(row.id);
        if (questionRef === undefined) {
          throw new HttpError(
            500,
            "EXPORT_ASSEMBLY_BROKEN",
            "v2 装配缺少该行的题目版本引用",
          );
        }
        const evidenceRef = evidenceAsm.evidenceRefByResponseRowId.get(row.id);
        if (m.evidence && evidenceRef === undefined) {
          throw new HttpError(
            500,
            "EXPORT_ASSEMBLY_BROKEN",
            "v2 装配缺少该行的证据引用",
          );
        }
        responseRowsV2.push({
          ...base,
          questionRef,
          snapshotHash: hashByRef.get(questionRef) ?? null,
          ...(m.evidence ? { evidenceRef } : {}),
        });
      }
    }
  }

  // —— evidence section（evidence 模块勾选才装配；快照配对的证据条目） ——
  const evidenceSection: LearningPackEvidence[] = [];
  if (m.evidence) {
    for (const entry of evidenceAsm.evidence) {
      evidenceSection.push({
        ref: entry.ref,
        attemptId: entry.attemptId,
        studentId: entry.studentId,
        questionId: entry.questionId,
        questionRef: entry.questionRef,
        no: entry.no,
        phase: entry.phase,
        state: entry.state,
        ...(entry.version !== undefined ? { version: entry.version } : {}),
        images: entry.images.map((image) => ({
          file: image.file,
          spec: image.spec,
          pageIndex: image.pageIndex,
          crop: { ...image.crop },
          pixelWidth: image.pixelWidth,
          pixelHeight: image.pixelHeight,
          state: image.state,
        })),
      });
    }
  }

  // —— pack 骨架（manifest 恒出现；先建草稿渲染 summary，再定稿） ——
  const packDraft: Omit<LearningPackV2, "manifest"> = {
    ...packHeaderOf(core, 2 as const, m.evidence),
    ...packSectionsOf(core, {
      questions: m.questions !== undefined ? questionItemsV2 : null,
      responses: m.responses ? responseRowsV2 : null,
      evidence: m.evidence ? evidenceSection : null,
    }),
  };

  // —— summary.md（人类可读；v2 附手写原稿清单） ——
  const summaryMd = renderSummaryMd({
    request,
    pack: packDraft,
    lectureItems: core.lectureItems,
    questionItems: questionItemsV2,
    summaryRows: core.summaryRows,
    responseRows: responseRowsV2,
    traceRows: core.traceRows,
    lectureTraceRows: core.lectureTraceRows,
    inkEntries: core.inkEntries,
    mediaEntries,
    evidenceEntries,
    displayNameOf: core.displayNameOf,
    nowIso: core.nowIso,
  });

  // —— schema.json（与 schema:export 产物逐字节一致；v2 单一来源） ——
  const schemaJson = `${JSON.stringify(learningPackV2JsonSchema(), null, 2)}\n`;

  // —— manifest（pack.json 同时为 zip 清单：files + missing + 口径说明） ——
  const contextNotes: string[] = [];
  if (m.questions === undefined && (m.responses || m.evidence)) {
    contextNotes.push(
      "题目内容模块未勾选：题目上下文未提供（逐题作答行与证据条目只有配对键 questionRef 与 snapshotHash，无题干/选项/答案——evidence[].questionRef 同样悬空指向未收录的题目条目，复审 B14）。",
    );
  }
  const missingSnapshotCount = evidenceAsm.revisions.filter(
    (revision) => !revision.present,
  ).length;
  if (missingSnapshotCount > 0) {
    contextNotes.push(
      `${missingSnapshotCount} 个题目版本的历史快照缺失（题目已删除或升级遗留），对应作答无题干内容，不回填当前题库。`,
    );
  }
  const manifest: LearningPackManifest = {
    files: [
      {
        path: "summary.md",
        kind: "summary",
        bytes: Buffer.byteLength(summaryMd, "utf8"),
        refs: [],
      },
      {
        path: "prompt.md",
        kind: "prompt",
        bytes: Buffer.byteLength(promptMd, "utf8"),
        refs: [],
      },
      {
        path: "schema.json",
        kind: "schema",
        bytes: Buffer.byteLength(schemaJson, "utf8"),
        refs: [],
      },
      ...(core.mappingTxt !== null
        ? [
            {
              path: "映射.txt",
              kind: "mapping" as const,
              bytes: Buffer.byteLength(core.mappingTxt, "utf8"),
              refs: [],
            },
          ]
        : []),
      ...core.inkEntries.map((entry) => ({
        path: entry.entry,
        kind: "ink" as const,
        bytes: entry.bytes,
        refs: [],
      })),
      ...mediaEntries.map((entry) => ({
        path: entry.entry,
        kind: "media" as const,
        bytes: entry.bytes,
        refs: mediaRefsBySrc.get(entry.entry) ?? [],
      })),
      ...evidenceEntries.map((entry) => ({
        path: entry.entry,
        kind: "evidence" as const,
        bytes: entry.bytes,
        refs: [entry.ref],
      })),
    ],
    missing: [
      ...missingMediaByPath.values(),
      ...evidenceMissingRowsOf(evidenceAsm),
    ],
    contextNotes,
  };

  const packV2: LearningPackV2 = { ...packDraft, manifest };
  // 服务端自检：直接校验内存对象（复审 C13；序列化一致性由既有测试锁定）
  learningPackV2Schema.parse(packV2);
  const packJson = `${JSON.stringify(packV2, null, 2)}\n`;

  // —— 文件清单与合计：由 manifest.files 派生 + pack.json 实测（复审 B3：消两遍装配） ——
  const files: LearningPackPreviewFile[] = [
    { path: "pack.json", estimatedBytes: Buffer.byteLength(packJson, "utf8") },
    ...manifest.files.map((file) => ({
      path: file.path,
      estimatedBytes: file.bytes,
    })),
  ];

  return {
    packJson,
    summaryMd,
    promptMd,
    schemaJson,
    mappingTxt: core.mappingTxt,
    inkEntries: core.inkEntries,
    mediaEntries,
    evidenceEntries,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.estimatedBytes, 0),
    displayNameOf: core.displayNameOf,
  };
}

/**
 * v1 文件清单组装（v2 由 manifest.files 派生，不经此函数）：固定四文件 +
 * 映射.txt（化名模式）+ ink/media 附件（内容合计不含 zip 容器开销，D18
 * 预检与 preview 共用）。pack.json 自身字节数由调用方传入（渲染后实测）。
 */
function packFilesOf(input: {
  readonly packJsonBytes: number;
  readonly summaryMd: string;
  readonly promptMd: string;
  readonly schemaJson: string;
  readonly mappingTxt: string | null;
  readonly inkEntries: ReadonlyArray<{
    readonly entry: string;
    readonly bytes: number;
  }>;
  readonly mediaEntries: ReadonlyArray<{
    readonly entry: string;
    readonly bytes: number;
  }>;
}): LearningPackPreviewFile[] {
  const files: LearningPackPreviewFile[] = [
    { path: "pack.json", estimatedBytes: input.packJsonBytes },
    {
      path: "summary.md",
      estimatedBytes: Buffer.byteLength(input.summaryMd, "utf8"),
    },
    {
      path: "prompt.md",
      estimatedBytes: Buffer.byteLength(input.promptMd, "utf8"),
    },
    {
      path: "schema.json",
      estimatedBytes: Buffer.byteLength(input.schemaJson, "utf8"),
    },
  ];
  if (input.mappingTxt !== null) {
    files.push({
      path: "映射.txt",
      estimatedBytes: Buffer.byteLength(input.mappingTxt, "utf8"),
    });
  }
  for (const entry of input.inkEntries) {
    files.push({ path: entry.entry, estimatedBytes: entry.bytes });
  }
  for (const entry of input.mediaEntries) {
    files.push({ path: entry.entry, estimatedBytes: entry.bytes });
  }
  return files;
}

// ---------- summary.md 渲染 ----------

/** summary.md 渲染输入（装配结果的各部分 + 展示上下文） */
interface SummaryMdInput {
  readonly request: LearningPackExportRequest;
  /**
   * pack（v1/v2 皆可）：summary 只读匿名化标志与学生名单，结构化子集
   * 避免 v1/v2 两套 meta 类型互相不适配。
   */
  readonly pack: {
    readonly meta: { readonly anonymized: boolean };
    readonly students: ReadonlyArray<{
      readonly name: string;
      readonly archived: boolean;
    }>;
  };
  /** 题目条目（v1/v2 形状皆可——只消费数量） */
  readonly questionItems: readonly object[];
  /** 讲义条目（讲义表：title 与小节数量） */
  readonly lectureItems: ReadonlyArray<{
    readonly title: string;
    readonly outline: readonly object[];
    readonly sections: ReadonlyArray<{ readonly headingIndex: number }>;
  }>;
  readonly summaryRows: readonly LearningPackAttemptSummary[];
  /** 逐题行（v1/v2 形状皆可——只消费 finalCorrect） */
  readonly responseRows: ReadonlyArray<{
    readonly finalCorrect: boolean | null;
  }>;
  readonly traceRows: readonly LearningPackQuestionTrace[];
  readonly lectureTraceRows: readonly LearningPackLectureTrace[];
  readonly inkEntries: ReadonlyArray<{ readonly entry: string }>;
  /** ::image 引用的图片条目（媒体管线第三单；无图为空数组，section 不出现） */
  readonly mediaEntries: ReadonlyArray<{ readonly entry: string }>;
  /** v2 证据图条目（T6R.12；空数组 = 未勾选或无图，section 不出现） */
  readonly evidenceEntries: ReadonlyArray<{ readonly entry: string }>;
  readonly displayNameOf: ReadonlyMap<string, string>;
  readonly nowIso: string;
}

/** 百分比展示（null → 「—」） */
function pctOf(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 1000) / 10}%`;
}

/** 秒 → 「X 分 Y 秒」展示 */
function secText(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest === 0 ? `${min} 分钟` : `${min} 分 ${rest} 秒`;
}

/** 状态中文（与作答数据页同文案） */
function statusText(status: string): string {
  if (status === "graded") return "已批改";
  if (status === "submitted") return "已交卷";
  return "进行中";
}

/**
 * 渲染 summary.md：人类可读统计摘要（AI 读 Markdown 表格效果好，架构 §5.9）。
 * 只统计勾选模块（D19）；化名贯穿全部表格（D16）；头部注明评语原文口径。
 */
function renderSummaryMd(input: SummaryMdInput): string {
  const { request, pack } = input;
  const m = request.modules;
  const lines: string[] = [];

  lines.push("# 学情数据包摘要");
  lines.push("");
  lines.push(`- 任务目标：${LEARNING_PACK_GOAL_LABELS[request.goal]}`);
  lines.push(`- 生成时间：${beijingDateTimeOf(input.nowIso)}（北京时间）`);
  lines.push(
    `- 时间范围：${
      request.scope.days === "all"
        ? "全部"
        : `最近 ${request.scope.days} 天（按交卷时间）`
    }`,
  );
  lines.push(
    pack.meta.anonymized
      ? "- 隐私：已化名（学生A/学生B…；化名对照只存在教师本地的 映射.txt）"
      : "- 隐私：包含真实姓名（教师已确认）",
  );
  lines.push(
    "- 说明：教师评语为原文（不改动），可能包含学生真实姓名；学习痕迹指标与阅读状态均为行为推断，仅供参考。",
  );
  lines.push("");

  // 学生名单（任何模块都展示——名字是全包主键）
  lines.push(`## 学生名单（${pack.students.length} 名）`);
  lines.push("");
  lines.push("| 称呼 | 状态 |");
  lines.push("| --- | --- |");
  for (const student of pack.students) {
    lines.push(`| ${student.name} | ${student.archived ? "已归档" : "在读"} |`);
  }
  lines.push("");

  if (m.lectures.length > 0) {
    lines.push("## 讲义");
    lines.push("");
    lines.push("| 讲义 | 目录小节数 | 含全文小节 |");
    lines.push("| --- | --- | --- |");
    for (const lecture of input.lectureItems) {
      lines.push(
        `| ${lecture.title} | ${lecture.outline.length} | ${
          lecture.sections.length > 0
            ? lecture.sections
                .map((section) => `第 ${section.headingIndex + 1} 节`)
                .join("、")
            : "无（仅大纲）"
        } |`,
      );
    }
    lines.push("");
  }

  if (m.questions !== undefined) {
    const levelText =
      m.questions === "stem"
        ? "仅题干（答案已隐去）"
        : m.questions === "answer"
          ? "题干 + 参考答案"
          : "题干 + 参考答案 + 详解";
    lines.push(`## 题目（${input.questionItems.length} 题，${levelText}）`);
    lines.push("");
  }

  if (m.summaries) {
    lines.push("## 作答汇总（全部历次）");
    lines.push("");
    lines.push(
      "| 学生 | 来源 | 课程 | 作业 / 单元 | 第几次 | 首次 | 状态 | 得分 | 提交时间 |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const row of input.summaryRows) {
      const name =
        input.displayNameOf.get(row.studentId) ?? row.studentId.slice(0, 8);
      const target =
        row.sourceType === "course"
          ? `${row.unitTitle ?? "—"}（课程练习）`
          : row.sourceType === "wrong"
            ? "错题重练"
            : (row.assignmentTitle ?? "—");
      lines.push(
        `| ${name} | ${row.sourceType === "course" ? "课程练习" : row.sourceType === "wrong" ? "错题重练" : "作业"} | ${
          row.courseName ?? "—"
        } | ${target} | 第 ${row.attemptNo} 次 | ${
          row.isFirst ? "是" : "否"
        } | ${statusText(row.status)} | ${
          row.scoreFinal ?? row.scoreAuto ?? "—"
        } | ${beijingDateTimeOf(row.submittedAt)} |`,
      );
    }
    lines.push("");
  }

  if (m.responses) {
    const judged = input.responseRows.filter(
      (r) => r.finalCorrect !== null,
    ).length;
    const correct = input.responseRows.filter(
      (r) => r.finalCorrect === true,
    ).length;
    const pending = input.responseRows.filter(
      (r) => r.finalCorrect === null,
    ).length;
    lines.push("## 逐题作答");
    lines.push("");
    lines.push(
      `- 共 ${input.responseRows.length} 个逐题行（全部历次）；判定：对 ${correct} / 错 ${
        judged - correct
      } / 待批 ${pending}（正确率分母不含待批）。`,
    );
    lines.push(
      "- 明细见 pack.json 的 attempts.responses（no 为该次作答内的连续题号）。",
    );
    lines.push("");
  }

  if (m.traces) {
    lines.push("## 学习痕迹");
    lines.push("");
    const active = input.traceRows.reduce(
      (sum, row) => sum + (row.activeSec ?? 0),
      0,
    );
    const offline = input.traceRows.reduce(
      (sum, row) => sum + (row.activeSec ?? 0) * row.offlineShare,
      0,
    );
    const hints = input.traceRows.reduce((sum, row) => sum + row.hintsUsed, 0);
    const changes = input.traceRows.reduce(
      (sum, row) => sum + row.changeCount,
      0,
    );
    lines.push(
      `- 有效作答总时长 ${secText(active)}；提示使用 ${hints} 次；改答 ${changes} 次；离线作答占比 ${pctOf(
        active > 0 ? offline / active : 0,
      )}。`,
    );
    if (input.lectureTraceRows.length > 0) {
      lines.push("");
      lines.push("讲义阅读地图（行为推断）：");
      lines.push("");
      lines.push("| 学生 | 讲义 | 有效阅读 | 节覆盖 | 折叠打开率 |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const row of input.lectureTraceRows) {
        lines.push(
          `| ${input.displayNameOf.get(row.studentId) ?? "—"} | ${row.title} | ${secText(
            row.map.summary.readSec,
          )} | ${pctOf(row.map.summary.sectionCoverage)} | ${pctOf(
            row.map.summary.foldOpenRate,
          )} |`,
        );
      }
    }
    lines.push("");
  }

  if (m.ink) {
    lines.push(`## 手写笔迹（${input.inkEntries.length} 张）`);
    lines.push("");
    for (const entry of input.inkEntries) {
      lines.push(`- ${entry.entry}`);
    }
    lines.push("");
  }

  // v2 逐题手写原稿（evidence 模块勾选且有图才出现）
  if (input.evidenceEntries.length > 0) {
    lines.push(`## 手写原稿（${input.evidenceEntries.length} 张）`);
    lines.push("");
    for (const entry of input.evidenceEntries) {
      lines.push(`- ${entry.entry}`);
    }
    lines.push("");
  }

  // 讲义/题目里的 ::image 配图（有图才出现；无图响应形状与现状一致）
  if (input.mediaEntries.length > 0) {
    lines.push(`## 讲义配图（${input.mediaEntries.length} 张）`);
    lines.push("");
    for (const entry of input.mediaEntries) {
      lines.push(`- ${entry.entry}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

// ---------- preview 与打包 ----------

/**
 * POST /api/teacher/export/learning-pack/preview：文件清单 + 预估大小 + 超限
 * 标志（D18：preview 不报错，向导据 overLimit 提示精简方向）。
 */
export function previewLearningPack(
  db: Db,
  dataDir: string,
  teacherId: string,
  request: LearningPackExportRequest,
  options: LearningPackServiceOptions = {},
): LearningPackPreviewData {
  const limitBytes = options.maxBytes ?? LEARNING_PACK_MAX_BYTES;
  const assembly = assembleLearningPack(
    db,
    dataDir,
    teacherId,
    request,
    options,
  );
  const overLimit = assembly.totalBytes > limitBytes;
  return {
    files: [...assembly.files],
    totalEstimatedBytes: assembly.totalBytes,
    limitBytes,
    overLimit,
    hint: overLimit
      ? `数据包预估 ${(assembly.totalBytes / (1024 * 1024)).toFixed(
          1,
        )} MB，超过 ${Math.round(limitBytes / (1024 * 1024))} MB 上限。精简方向：减少学生人数、取消手写 PNG 或证据附件、或缩小时间范围后重试。`
      : null,
  };
}

/** zip 构建结果（内存字节；路由层直出——ArrayBuffer 底座满足 DOM BodyInit 类型） */
export interface LearningPackZip {
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** 下载文件名（learning-pack-<北京时间戳>.zip） */
  readonly filename: string;
}

/**
 * POST /api/teacher/export/learning-pack：装配 + 50MB 预检（超限 413
 * EXPORT_TOO_LARGE，中文说明含精简方向，D18）+ zip 打包（T6R.14 起走
 * lib/zip-write.zipBufferOf 共享单点，与 review-pack 同管道）。
 * zip 结构（顶层）：pack.json / summary.md / prompt.md / schema.json /
 * 映射.txt（化名模式）/ ink/*.png（勾选）/ blobs/media/<hash>.<ext>
 * （md 中 ::image 引用的图片，条目名即契约 src 相对路径）。
 */
export async function buildLearningPackZip(
  db: Db,
  dataDir: string,
  teacherId: string,
  request: LearningPackExportRequest,
  options: LearningPackServiceOptions = {},
): Promise<LearningPackZip> {
  const limitBytes = options.maxBytes ?? LEARNING_PACK_MAX_BYTES;
  const assembly = assembleLearningPack(
    db,
    dataDir,
    teacherId,
    request,
    options,
  );
  if (assembly.totalBytes > limitBytes) {
    throw new HttpError(
      413,
      "EXPORT_TOO_LARGE",
      `数据包预估 ${(assembly.totalBytes / (1024 * 1024)).toFixed(
        1,
      )} MB，超过 ${Math.round(limitBytes / (1024 * 1024))} MB 上限。请减少学生人数、取消手写 PNG 或证据附件、或缩小时间范围后重试。`,
    );
  }

  // 宽松口径（warningAsError:false）= v1 学情包既有语义：读不到的附件
  // （ink/media 文件被外部删除等部署级损坏）跳过条目不致命，包照常产出
  //（warning 留服务端日志）；LEARNING_PACK_MAX_BYTES 记账在装配预检处执行
  const bytes = await zipBufferOf(
    (archive) => {
      archive.append(Buffer.from(assembly.packJson, "utf8"), {
        name: "pack.json",
      });
      archive.append(Buffer.from(assembly.summaryMd, "utf8"), {
        name: "summary.md",
      });
      archive.append(Buffer.from(assembly.promptMd, "utf8"), {
        name: "prompt.md",
      });
      archive.append(Buffer.from(assembly.schemaJson, "utf8"), {
        name: "schema.json",
      });
      if (assembly.mappingTxt !== null) {
        archive.append(Buffer.from(assembly.mappingTxt, "utf8"), {
          name: "映射.txt",
        });
      }
      for (const entry of assembly.inkEntries) {
        archive.file(entry.absPath, { name: entry.entry });
      }
      // media 条目：条目名含子目录（blobs/media/…），archiver 按路径写目录条目
      for (const entry of assembly.mediaEntries) {
        archive.file(entry.absPath, { name: entry.entry });
      }
      // v2 证据图条目（T6R.12）：evidence/<编号>-<阶段>-<页号>.png；缺失文件
      // 不在清单（manifest.missing 显式登记），不产生悬垂 zip 条目
      for (const entry of assembly.evidenceEntries) {
        archive.file(entry.absPath, { name: entry.entry });
      }
    },
    { warningAsError: false },
  );
  const nowDate =
    options.now !== undefined
      ? new Date(
          typeof options.now === "string"
            ? Date.parse(options.now)
            : options.now,
        )
      : new Date();
  return {
    bytes,
    filename: `learning-pack-${beijingExportStampOf(nowDate)}.zip`,
  };
}
