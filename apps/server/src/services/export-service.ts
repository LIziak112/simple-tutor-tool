import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  LearningPack,
  LearningPackAttemptSummary,
  LearningPackExportRequest,
  LearningPackLecture,
  LearningPackLectureTrace,
  LearningPackPreviewData,
  LearningPackPreviewFile,
  LearningPackQuestion,
  LearningPackQuestionTrace,
  LearningPackResponse,
  LearningPackStudentSummary,
  LearningPackSummarySection,
} from "@tutor/contract";
import {
  LEARNING_PACK_GOAL_LABELS,
  LEARNING_PACK_MAX_BYTES,
  learningPackAliasOf,
  learningPackJsonSchema,
  learningPackSchema,
  renderLearningPackPrompt,
} from "@tutor/contract";
import { analyzeLectureStructure, publicStemMd } from "@tutor/md-dsl";
import { ZipArchive } from "archiver";
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
import { HttpError } from "../lib/http-error";
import { attemptUnitIds } from "./attempt-service";
import { beijingDateTimeOf, beijingExportStampOf } from "./export-csv";
import { lectureReadingMapFor } from "./lecture-insights";
import { serializeStudentAnswer } from "./mark-response";
import { answerOf, snapshotOf, sourceOf } from "./teacher-attempt-service";
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
 * - 题目三层（D14）：stem 层题干经 publicStemMd 公开化（不给答案）；
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

/** inArray 分块迭代（SQLite 变量上限防御，与 analytics-service 同款） */
function chunk<T>(items: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

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

// ---------- ::image 图片引用提取（学习包 media 条目） ----------

/**
 * 从进入 pack 的 markdown 文本提取 ::image 引用的图片 src（严格契约形态）。
 * 导出层用单一正则扫指令行的 src 值、不引入 md-dsl 解析器依赖——这里只需要
 * 「哪些文件要打进 zip」这一份清单，完整指令语义（未知属性降级等）由解析/
 * 渲染层负责；正则按契约 MEDIA_SRC_PATTERN 的严格形态匹配（64 位小写 hex +
 * 白名单扩展名），旧式 blobs/fig-1.png 等无内容寻址文件可寻的引用静默跳过。
 */
export function extractMediaImageSrcs(markdowns: readonly string[]): string[] {
  // 字面量求值即新对象（非模块级共享）：/g 正则被 matchAll 提前中止会留下
  // 非零 lastIndex，共享实例会跨调用串状态
  const pattern =
    /::image\{[^}\n]*?\bsrc="(blobs\/media\/[0-9a-f]{64}\.(?:png|jpe?g|webp|gif))"/g;
  const seen = new Set<string>();
  for (const md of markdowns) {
    for (const match of md.matchAll(pattern)) {
      const src = match[1];
      if (src !== undefined) seen.add(src);
    }
  }
  // Set 保插入序：同图多处引用只收集一次，条目顺序稳定可测
  return [...seen];
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
   * 条目）；缺文件已跳过（同 ink 口径）。
   */
  readonly mediaEntries: ReadonlyArray<{
    readonly entry: string;
    readonly absPath: string;
    readonly bytes: number;
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
        a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id),
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
    const inkRoot = resolve(dataDir, "blobs", "ink");
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
        const absPath = resolve(dataDir, row.pngPath);
        if (!absPath.startsWith(inkRoot)) {
          throw new HttpError(500, "INK_UNREADABLE", "笔迹文件路径非法");
        }
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

  // —— content.questions（快照优先；stem 层题干公开化不给答案 D14） ——
  const questionItems: LearningPackQuestion[] = [];
  if (m.questions !== undefined) {
    // 最新一次提交的快照为准（题目视角同口径）；当前库元信息提供排序与单元归属
    const latestSnapshot = new Map<string, { row: ResponseRow; at: string }>();
    for (const attempt of orderedAttempts) {
      const at = attempt.submittedAt ?? "";
      for (const row of responsesByAttempt.get(attempt.id) ?? []) {
        const prev = latestSnapshot.get(row.questionId);
        if (prev === undefined || at >= prev.at) {
          latestSnapshot.set(row.questionId, { row, at });
        }
      }
    }
    const metaOf = new Map(
      db
        .select({
          id: questions.id,
          unitId: questions.unitId,
          order: questions.order,
          stemMd: questions.stemMd,
        })
        .from(questions)
        .where(eq(questions.teacherId, teacherId))
        .all()
        .map((row) => [row.id, row] as const),
    );
    for (const [questionId, { row }] of latestSnapshot) {
      const snapshot = snapshotOf(row);
      const meta = metaOf.get(questionId);
      // 快照缺失按当前库题干兜底（题目统计同口径；两者皆缺按空题干行追加在末尾）
      const stemMd = snapshot?.stemMd ?? meta?.stemMd ?? "";
      const item: LearningPackQuestion = {
        questionId,
        unitId: meta?.unitId ?? null,
        unitTitle: null, // 下方统一回填
        type: snapshot?.type ?? "fill",
        difficulty: snapshot?.difficulty ?? 2,
        knowledge: snapshot?.knowledge ?? [],
        stemMd: m.questions === "stem" ? publicStemMd(stemMd) : stemMd,
      };
      if (snapshot?.options !== undefined) {
        item.options = snapshot.options.map((option) => option.text);
      }
      if (m.questions !== "stem" && snapshot?.answers !== undefined) {
        item.answers = snapshot.answers;
      }
      if (m.questions === "solution" && snapshot?.solutionMd !== undefined) {
        item.solutionMd = snapshot.solutionMd;
      }
      questionItems.push(item);
    }
    // 单元标题统一回填（域内 units 表，含软删——历史统计不消失）+ 排序（单元内题序）
    const unitIds = [
      ...new Set(
        questionItems
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
    for (const item of questionItems) {
      if (item.unitId !== null) {
        item.unitTitle = titleById.get(item.unitId) ?? item.unitId;
      }
    }
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

  // —— media 条目（媒体管线第三单：::image 引用的图片打进 zip，条目名 = src 原相对路径） ——
  const mediaEntries: Array<{ entry: string; absPath: string; bytes: number }> =
    [];
  {
    // 扫描**进入 pack 的全部 md 文本**（讲义切片全文、题干与详解——按勾选
    // 模块实际收录的文本扫，未勾选模块的 md 不进包也不带图）
    const mdTexts: string[] = [];
    for (const item of lectureItems) {
      for (const section of item.sections) mdTexts.push(section.markdown);
    }
    if (m.questions !== undefined) {
      for (const item of questionItems) {
        mdTexts.push(item.stemMd);
        if (item.solutionMd !== undefined) mdTexts.push(item.solutionMd);
      }
    }
    const mediaRoot = resolve(dataDir, "blobs", "media");
    for (const src of extractMediaImageSrcs(mdTexts)) {
      const absPath = resolve(dataDir, ...src.split("/"));
      // 理论不可达（扫描正则已限定单段内容寻址形态，无穿越空间）：路径必须
      // 落在 blobs/media/ 内，越界按缺文件跳过（不炸，与缺文件同口径）
      if (!absPath.startsWith(mediaRoot)) continue;
      let bytes: number;
      try {
        bytes = statSync(absPath).size;
      } catch {
        continue; // 图片文件缺失（未上传过/已清理）：跳过该条目（同 ink 缺文件口径）
      }
      mediaEntries.push({ entry: src, absPath, bytes });
    }
  }

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

  /** 该 attempt 的逐题行序（attempt 单元顺序 × 单元内题序，与作答详情同口径） */
  const orderedResponsesOf = (attempt: Attempt): ResponseRow[] => {
    const rows = responsesByAttempt.get(attempt.id) ?? [];
    if (rows.length === 0) return rows;
    const unitIds = attemptUnitIds(db, attempt);
    const orderById = new Map(
      db
        .select({
          id: questions.id,
          unitId: questions.unitId,
          order: questions.order,
        })
        .from(questions)
        .where(
          and(
            eq(questions.teacherId, teacherId),
            inArray(
              questions.id,
              rows.map((row) => row.questionId),
            ),
          ),
        )
        .all()
        .map((row) => [row.id, row] as const),
    );
    const unitIndex = new Map(unitIds.map((unitId, i) => [unitId, i] as const));
    const unitOf = (questionId: string): string | null =>
      orderById.get(questionId)?.unitId ?? null;
    return [...rows].sort((a, b) => {
      const unitA = unitOf(a.questionId);
      const unitB = unitOf(b.questionId);
      const idxA =
        unitA !== null
          ? (unitIndex.get(unitA) ?? unitIds.length)
          : unitIds.length + 1;
      const idxB =
        unitB !== null
          ? (unitIndex.get(unitB) ?? unitIds.length)
          : unitIds.length + 1;
      if (idxA !== idxB) return idxA - idxB;
      const ordA =
        orderById.get(a.questionId)?.order ?? Number.MAX_SAFE_INTEGER;
      const ordB =
        orderById.get(b.questionId)?.order ?? Number.MAX_SAFE_INTEGER;
      return ordA !== ordB
        ? ordA - ordB
        : a.questionId.localeCompare(b.questionId);
    });
  };

  // —— attempts.responses（D15 全部历次；评语原文不改动 D16） ——
  const responseRows: LearningPackResponse[] = [];
  if (m.responses) {
    for (const attempt of orderedAttempts) {
      let no = 0;
      for (const row of orderedResponsesOf(attempt)) {
        no += 1;
        const inkFile = inkEntryByAttemptQuestion.get(
          `${attempt.id}:${row.questionId}`,
        );
        responseRows.push({
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
        });
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
      for (const row of orderedResponsesOf(attempt)) {
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
          a.title.localeCompare(b.title) ||
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

  // —— pack.json（未勾选的 section 不出现，D19） ——
  const pack: LearningPack = {
    meta: {
      version: 1,
      generatedAt: nowIso,
      goal: request.goal,
      days: request.scope.days,
      from: fromIso,
      to: nowIso,
      anonymized,
      modules: {
        lectures: m.lectures.length > 0,
        questions: m.questions ?? null,
        responses: m.responses,
        summaries: m.summaries,
        ink: m.ink,
        traces: m.traces,
      },
      note: "评语为教师原文（不改动），可能包含学生真实姓名；学习痕迹指标与阅读状态均为行为推断，仅供参考。",
    },
    students: roster.map((student) => ({
      id: student.id,
      name: displayNameOf.get(student.id) ?? student.displayName,
      archived: student.archived,
    })),
    ...(m.lectures.length > 0 || m.questions !== undefined
      ? {
          content: {
            ...(m.lectures.length > 0 ? { lectures: lectureItems } : {}),
            ...(m.questions !== undefined ? { questions: questionItems } : {}),
          },
        }
      : {}),
    ...(m.responses || m.summaries
      ? {
          attempts: {
            ...(m.responses ? { responses: responseRows } : {}),
            ...(m.summaries ? { summaries: summaryRows } : {}),
          },
        }
      : {}),
    ...(m.traces
      ? {
          traces: {
            questions: traceRows,
            lectures: lectureTraceRows,
          },
        }
      : {}),
    ...(summarySection !== undefined ? { summary: summarySection } : {}),
  };
  // 服务端自检：序列化往返必须通过自身 schema（测试同款断言，契约漂移即失败）
  const packJson = `${JSON.stringify(pack, null, 2)}\n`;
  learningPackSchema.parse(JSON.parse(packJson));

  // —— prompt.md（D17 单一来源渲染） ——
  const promptMd = renderLearningPackPrompt({
    goal: request.goal,
    lectures: m.lectures.length > 0,
    questionLevel: m.questions ?? null,
    responses: m.responses,
    summaries: m.summaries,
    ink: m.ink,
    traces: m.traces,
    anonymized,
    ...(request.customPrompt !== undefined && request.customPrompt.length > 0
      ? { customPrompt: request.customPrompt }
      : {}),
  });

  // —— schema.json（与 schema:export 产物逐字节一致，D19） ——
  const schemaJson = `${JSON.stringify(learningPackJsonSchema(), null, 2)}\n`;

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

  // —— summary.md（人类可读；只统计勾选模块，D19） ——
  const summaryMd = renderSummaryMd({
    request,
    pack,
    lectureItems,
    questionItems,
    summaryRows,
    responseRows,
    traceRows,
    lectureTraceRows,
    inkEntries,
    mediaEntries,
    displayNameOf,
    nowIso,
  });

  // —— 文件清单与合计（D18 预检与 preview 共用；不含 zip 容器开销） ——
  const files: LearningPackPreviewFile[] = [
    { path: "pack.json", estimatedBytes: Buffer.byteLength(packJson, "utf8") },
    {
      path: "summary.md",
      estimatedBytes: Buffer.byteLength(summaryMd, "utf8"),
    },
    { path: "prompt.md", estimatedBytes: Buffer.byteLength(promptMd, "utf8") },
    {
      path: "schema.json",
      estimatedBytes: Buffer.byteLength(schemaJson, "utf8"),
    },
  ];
  if (mappingTxt !== null) {
    files.push({
      path: "映射.txt",
      estimatedBytes: Buffer.byteLength(mappingTxt, "utf8"),
    });
  }
  for (const entry of inkEntries) {
    files.push({ path: entry.entry, estimatedBytes: entry.bytes });
  }
  // media 条目（::image 引用的图片）：preview 清单与大小预检与 ink 同口径
  for (const entry of mediaEntries) {
    files.push({ path: entry.entry, estimatedBytes: entry.bytes });
  }
  const totalBytes = files.reduce((sum, file) => sum + file.estimatedBytes, 0);

  return {
    packJson,
    summaryMd,
    promptMd,
    schemaJson,
    mappingTxt,
    inkEntries,
    mediaEntries,
    files,
    totalBytes,
    displayNameOf,
  };
}

// ---------- summary.md 渲染 ----------

/** summary.md 渲染输入（装配结果的各部分 + 展示上下文） */
interface SummaryMdInput {
  readonly request: LearningPackExportRequest;
  readonly pack: LearningPack;
  readonly lectureItems: readonly LearningPackLecture[];
  readonly questionItems: readonly LearningPackQuestion[];
  readonly summaryRows: readonly LearningPackAttemptSummary[];
  readonly responseRows: readonly LearningPackResponse[];
  readonly traceRows: readonly LearningPackQuestionTrace[];
  readonly lectureTraceRows: readonly LearningPackLectureTrace[];
  readonly inkEntries: ReadonlyArray<{ readonly entry: string }>;
  /** ::image 引用的图片条目（媒体管线第三单；无图为空数组，section 不出现） */
  readonly mediaEntries: ReadonlyArray<{ readonly entry: string }>;
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
        )} MB，超过 ${Math.round(limitBytes / (1024 * 1024))} MB 上限。精简方向：减少学生人数、取消手写 PNG、或缩小时间范围后重试。`
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
 * EXPORT_TOO_LARGE，中文说明含精简方向，D18）+ archiver 打包。
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
      )} MB，超过 ${Math.round(limitBytes / (1024 * 1024))} MB 上限。请减少学生人数、取消手写 PNG、或缩小时间范围后重试。`,
    );
  }

  // archiver v8 类 API：new ZipArchive（技术栈清单内依赖，原生 ESM）
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", () => resolve());
    archive.on("error", (err: Error) => reject(err));
  });
  archive.append(Buffer.from(assembly.packJson, "utf8"), { name: "pack.json" });
  archive.append(Buffer.from(assembly.summaryMd, "utf8"), {
    name: "summary.md",
  });
  archive.append(Buffer.from(assembly.promptMd, "utf8"), { name: "prompt.md" });
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
  await archive.finalize();
  await done;
  const bytes = Buffer.concat(chunks);
  const nowDate =
    options.now !== undefined
      ? new Date(
          typeof options.now === "string"
            ? Date.parse(options.now)
            : options.now,
        )
      : new Date();
  return {
    bytes: new Uint8Array(bytes),
    filename: `learning-pack-${beijingExportStampOf(nowDate)}.zip`,
  };
}
