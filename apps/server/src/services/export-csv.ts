import type { ExportCsvQuery, QuestionType } from "@tutor/contract";
import {
  HANDWRITTEN_QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
} from "@tutor/contract";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  attempts,
  questions,
  type ResponseRow,
  responses,
  students,
} from "../db/schema";
import { knowledgeNamesByQuestion } from "./assignment-service";
import { attemptUnitIds } from "./attempt-service";
import { serializeStudentAnswer } from "./mark-response";
import {
  answerOf,
  inkByQuestionOf,
  snapshotOf,
  sourceOf,
  unitTitleByIdOf,
} from "./teacher-attempt-service";

/**
 * CSV 导出业务层（T3.4，Phase3 清单 §2 D13）：
 * GET /api/teacher/export/csv?studentId&courseId&assignmentId&sourceType&from&to
 * ——全部来源（作业 + 课程练习）、**仅已交卷 attempt**、每题一行。
 *
 * 返回 CSV 字符串（不含 BOM；UTF-8 BOM / Content-Type / Content-Disposition
 * 文件名等响应头由路由层包装——文件名时间戳取请求时刻，属 HTTP 关注点）。
 *
 * 行组装完全复用 T3.1/T3.2b 的函数（不复制口径）：
 * - 归属过滤：attempt → student → teacherId（乙教师导不出甲学生的行，T2B 域红线）；
 * - 筛选：六参数语义与列表接口同轴（from/to 按「最近活动时间」
 *   submittedAt ?? startedAt 过滤；已交卷 attempt 即 submittedAt）；
 * - 来源上下文 / 题目快照 / 答案序列化 / ink 关联：sourceOf / snapshotOf /
 *   answerOf + serializeStudentAnswer（待批卡片同一序列化口径）/ inkByQuestionOf；
 * - 题号：与 T3.1 详情同口径的全卷连续题号（attempt 单元顺序 × 单元内题序，1 起）；
 * - 考点取自题目快照（responses.questionSnapshotJson）；快照缺失按题目 id 从
 *   当前库关联兜底（knowledgeNamesByQuestion，teacherId 域内；题型/难度同样
 *   回落当前 questions 行）。逐题 join 用 leftJoin——题目行缺失（理论不可达：
 *   有作答记录的题禁止 purge）也不丢行，追加在末尾。
 *
 * 排序：attempt 按提交时间升序（与待批队列「先交先批」同方向，导出报表按
 * 时间线阅读）；行内顺序即列序（见 CSV_COLUMNS）。
 */

/**
 * UTF-8 BOM 字符（响应体前缀，路由层使用）：让 Excel 直接打开 CSV 中文不乱码
 * （D13）。写成转义序列常量，避免源码里出现不可见字符。
 */
export const CSV_UTF8_BOM = "\uFEFF";

/** D13 列头（顺序即列序，与 Phase3 清单 §2 D13 逐项对应） */
export const CSV_COLUMNS: readonly string[] = [
  "学生",
  "来源类型",
  "课程",
  "作业或单元",
  "提交时间",
  "单元标题",
  "全卷题号",
  "题型",
  "难度",
  "考点",
  "学生答案",
  "自动判定",
  "最终判定",
  "判定来源",
  "用时（秒）",
  "提示数",
  "改答案次数",
  "教师评语",
  "手写笔迹链接",
];

/** 展示时区（§0.3：库存/传输 UTC；CSV 面向教师阅读 → Asia/Shanghai 北京时间） */
const DISPLAY_TZ = "Asia/Shanghai";

/** 北京时间部件提取器（formatToParts 自行拼装，不依赖 locale 的整体格式串） */
const beijingPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Date → 北京时间各部件（两位补零） */
function beijingPartsOf(
  date: Date,
): Record<"year" | "month" | "day" | "hour" | "minute" | "second", string> {
  const record: Partial<
    Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>
  > = {};
  for (const part of beijingPartsFormatter.formatToParts(date)) {
    switch (part.type) {
      case "year":
      case "month":
      case "day":
      case "hour":
      case "minute":
      case "second":
        record[part.type] = part.value;
        break;
      // literal（分隔符）忽略
    }
  }
  const pick = (
    type: "year" | "month" | "day" | "hour" | "minute" | "second",
  ): string => {
    const value = record[type];
    if (value === undefined) {
      // 理论不可达（formatter 显式请求了全部六部件）；防御性兜底
      throw new Error(`北京时间格式化缺少部件：${type}`);
    }
    return value;
  };
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

/**
 * UTC ISO 字符串 → 北京时间「YYYY-MM-DD HH:mm:ss」（提交时间列）。
 * 与界面 formatCnTime 同一时区口径（服务端无 dayjs 先例，按 Intl 实现）。
 */
export function beijingDateTimeOf(utcIso: string): string {
  const p = beijingPartsOf(new Date(utcIso));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** 请求时刻 → 北京时间文件名时间戳「YYYYMMDD-HHmmss」（tutor-export-*.csv） */
export function beijingExportStampOf(date: Date = new Date()): string {
  const p = beijingPartsOf(date);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

/**
 * 单元格文本 → CSV 安全文本（先公式注入防护，再 RFC 4180 转义）：
 * 1. 公式注入防护（D13，防在转义前基于原始内容判断——学生答案与教师评语是
 *    不可信输入，Excel 打开时可能被当成公式执行）：原始内容以 = + - @、
 *    制表符（\t）、回车/换行（\r / \n）开头 → 内容前加「'」；
 * 2. RFC 4180 转义：含逗号 / 双引号 / 换行的字段用双引号包裹，内部引号翻倍。
 */
export function csvCell(raw: string): string {
  const guarded = /^[=+\-@\t\r\n]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(guarded)
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
}

/** 判定单元格文本（与详情页判定区同口径：答对/答错；null 的展示区分两列） */
function autoCorrectText(autoCorrect: boolean | null): string {
  if (autoCorrect === null) return "—"; // 不能自动判定（待批或无标准答案）
  return autoCorrect ? "答对" : "答错";
}

function finalCorrectText(finalCorrect: boolean | null): string {
  if (finalCorrect === null) return "待批";
  return finalCorrect ? "答对" : "答错";
}

/**
 * 组装 CSV（不含 BOM 与响应头）。已交卷 attempt 逐题一行；换行 \r\n。
 * publicUrl 用于手写笔迹 PNG 绝对链接（教师端导出的 CSV 可能被转发/
 * 在本机打开，相对路径不可用——用部署根地址拼 /api/teacher/ink/{inkId}.png）。
 */
export function exportCsv(
  db: Db,
  teacherId: string,
  publicUrl: string,
  query: ExportCsvQuery,
): string {
  // 部署根地址去尾斜杠（拼绝对链接用）
  const base = publicUrl.replace(/\/+$/, "");
  // from/to 与列表接口同一「最近活动时间」轴（已交卷 attempt 即 submittedAt）
  const lastActivitySql = sql`coalesce(${attempts.submittedAt}, ${attempts.startedAt})`;
  const where = and(
    eq(students.teacherId, teacherId),
    // D13：仅已交卷 attempt（draft 不产生行）
    ne(attempts.status, "draft"),
    query.studentId !== undefined
      ? eq(attempts.studentId, query.studentId)
      : undefined,
    query.courseId !== undefined
      ? eq(attempts.courseId, query.courseId)
      : undefined,
    query.assignmentId !== undefined
      ? eq(attempts.assignmentId, query.assignmentId)
      : undefined,
    query.sourceType !== undefined
      ? eq(attempts.sourceType, query.sourceType)
      : undefined,
    query.from !== undefined
      ? sql`${lastActivitySql} >= ${query.from}`
      : undefined,
    query.to !== undefined ? sql`${lastActivitySql} <= ${query.to}` : undefined,
  );
  const attemptRows = db
    .select({ attempt: attempts, studentName: students.displayName })
    .from(attempts)
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(where)
    .orderBy(asc(lastActivitySql), asc(attempts.id))
    .all();

  const lines: string[] = [CSV_COLUMNS.map(csvCell).join(",")];
  // 考点兜底表（快照缺失时按题目 id 从当前库关联；懒加载一次，正常数据不触发）
  let knowledgeFallback: Map<string, string[]> | null = null;

  for (const { attempt, studentName } of attemptRows) {
    const source = sourceOf(db, attempt, teacherId);
    const inkByQuestion = inkByQuestionOf(db, attempt.id);

    // wrong 来源（2026-10 错题重练）：逐题行 = attempt 自有冻结行，按建卷插入序
    // （rowid，限定 responses 表防 join 二义）；单元列取题目当前归属单元（域内，
    // 与教师端详情/错题本 originUnit 同口径），行缺失留空。不走按单元分组的
    // 主路径（那里的题序取当前题库 order，会打乱组卷题序）。
    if (attempt.sourceType === "wrong") {
      const ownRows = db
        .select({
          response: responses,
          questionUnitId: questions.unitId,
          questionType: questions.type,
          questionDifficulty: questions.difficulty,
        })
        .from(responses)
        .leftJoin(
          questions,
          and(
            eq(responses.questionId, questions.id),
            eq(questions.teacherId, teacherId),
          ),
        )
        .where(eq(responses.attemptId, attempt.id))
        .orderBy(sql`responses.rowid`)
        .all();
      const unitTitles = unitTitleByIdOf(db, teacherId, [
        ...new Set(
          ownRows
            .map((row) => row.questionUnitId)
            .filter((unitId): unitId is string => unitId !== null),
        ),
      ]);
      const submittedText = beijingDateTimeOf(
        attempt.submittedAt ?? attempt.startedAt,
      );
      let wrongNo = 0;
      for (const row of ownRows) {
        wrongNo += 1;
        const snapshot = snapshotOf(row.response);
        const type = snapshot?.type ?? row.questionType ?? null;
        const difficulty =
          snapshot?.difficulty ?? row.questionDifficulty ?? null;
        const knowledge =
          snapshot?.knowledge ??
          (knowledgeFallback ??= knowledgeNamesByQuestion(db, teacherId)).get(
            row.response.questionId,
          ) ??
          [];
        const answerText =
          serializeStudentAnswer(answerOf(row.response.answerJson)) ?? "";
        const inkRow = inkByQuestion.get(row.response.questionId);
        const inkUrl =
          type !== null &&
          HANDWRITTEN_QUESTION_TYPES.includes(type) &&
          inkRow !== undefined
            ? `${base}/api/teacher/ink/${inkRow.id}.png`
            : "";
        lines.push(
          [
            studentName,
            "错题重练",
            "",
            `第 ${attempt.attemptNo} 次`,
            submittedText,
            row.questionUnitId !== null
              ? (unitTitles.get(row.questionUnitId) ?? row.questionUnitId)
              : "",
            String(wrongNo),
            type === null ? "" : (QUESTION_TYPE_LABELS[type] ?? type),
            difficulty === null ? "" : String(difficulty),
            knowledge.join("；"),
            answerText,
            autoCorrectText(row.response.autoCorrect),
            finalCorrectText(row.response.finalCorrect),
            row.response.teacherMark === "correct" ||
            row.response.teacherMark === "wrong"
              ? "教师"
              : "自动",
            row.response.activeSec === null
              ? ""
              : String(row.response.activeSec),
            String(row.response.hintsUsed),
            String(row.response.changeCount),
            row.response.teacherComment ?? "",
            inkUrl,
          ]
            .map(csvCell)
            .join(","),
        );
      }
      continue;
    }

    const unitIds = attemptUnitIds(db, attempt);

    // 已交卷逐题：leftJoin 当前 questions（teacherId 域）提供单元归属与题序
    // （T3.1 详情同口径；leftJoin 保证当前库缺行也不丢导出行，行追加在末尾）
    const rows = db
      .select({
        response: responses,
        order: questions.order,
        questionUnitId: questions.unitId,
        questionType: questions.type,
        questionDifficulty: questions.difficulty,
      })
      .from(responses)
      .leftJoin(
        questions,
        and(
          eq(responses.questionId, questions.id),
          eq(questions.teacherId, teacherId),
        ),
      )
      .where(eq(responses.attemptId, attempt.id))
      .all();

    // 按 attempt 单元顺序分组（组内按 (order, questionId) 升序）；
    // 题目单元不在 attempt 单元集合内的异常行与当前库缺行的孤儿行追加在末尾
    const unitIndex = new Map(unitIds.map((unitId, i) => [unitId, i]));
    const groups = new Map<
      string,
      {
        response: ResponseRow;
        order: number | null;
        type: QuestionType | null;
        difficulty: number | null;
      }[]
    >();
    const ORPHAN_UNIT_KEY = "\u0000orphan";
    for (const row of rows) {
      const key = row.questionUnitId ?? ORPHAN_UNIT_KEY;
      const entry = {
        response: row.response,
        order: row.order,
        type: row.questionType,
        difficulty: row.questionDifficulty,
      };
      const list = groups.get(key);
      if (list === undefined) groups.set(key, [entry]);
      else list.push(entry);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => {
        const orderA = a.order ?? Number.MAX_SAFE_INTEGER;
        const orderB = b.order ?? Number.MAX_SAFE_INTEGER;
        return orderA !== orderB
          ? orderA - orderB
          : a.response.questionId < b.response.questionId
            ? -1
            : 1;
      });
    }
    const orderedUnitIds = [
      ...unitIds,
      ...[...groups.keys()].filter(
        (key) => key !== ORPHAN_UNIT_KEY && !unitIndex.has(key),
      ),
      ...(groups.has(ORPHAN_UNIT_KEY) ? [ORPHAN_UNIT_KEY] : []),
    ];

    // 单元标题统一解析（域内读，含软删单元；孤儿行回退 attempt 单元——
    // course 来源即练习单元，assignment 来源无单元则空）
    const orphanUnitId = attempt.unitId ?? "";
    const unitTitles = unitTitleByIdOf(
      db,
      teacherId,
      orderedUnitIds.filter((key) => key !== ORPHAN_UNIT_KEY),
    );

    // 来源列的固定值（整份 attempt 一致）
    const sourceTypeText = source.sourceType === "course" ? "课程练习" : "作业";
    const courseText = source.courseName ?? "";
    const assignmentOrUnitText =
      source.sourceType === "course"
        ? `${source.unitTitle} · 第 ${source.attemptNo} 次`
        : (source.assignmentTitle ?? "");
    const submittedText = beijingDateTimeOf(
      attempt.submittedAt ?? attempt.startedAt,
    );

    let no = 0;
    for (const unitId of orderedUnitIds) {
      const group = groups.get(unitId);
      if (group === undefined) continue;
      const unitTitle =
        unitId === ORPHAN_UNIT_KEY
          ? (unitTitles.get(orphanUnitId) ?? orphanUnitId)
          : (unitTitles.get(unitId) ?? unitId);
      for (const { response, type: qType, difficulty: qDifficulty } of group) {
        no += 1;
        // 快照优先；缺失回落当前 questions 行（考点经关联表兜底）
        const snapshot = snapshotOf(response);
        const type = snapshot?.type ?? qType ?? null;
        const difficulty = snapshot?.difficulty ?? qDifficulty ?? null;
        let knowledge: string[];
        if (snapshot !== null) {
          knowledge = snapshot.knowledge;
        } else {
          knowledgeFallback ??= knowledgeNamesByQuestion(db, teacherId);
          knowledge = knowledgeFallback.get(response.questionId) ?? [];
        }
        const answerText =
          serializeStudentAnswer(answerOf(response.answerJson)) ?? "";
        const inkRow = inkByQuestion.get(response.questionId);
        const inkUrl =
          type !== null &&
          HANDWRITTEN_QUESTION_TYPES.includes(type) &&
          inkRow !== undefined
            ? `${base}/api/teacher/ink/${inkRow.id}.png`
            : "";
        const cells = [
          studentName,
          sourceTypeText,
          courseText,
          assignmentOrUnitText,
          submittedText,
          unitTitle,
          String(no),
          type === null ? "" : (QUESTION_TYPE_LABELS[type] ?? type),
          difficulty === null ? "" : String(difficulty),
          knowledge.join("；"),
          answerText,
          autoCorrectText(response.autoCorrect),
          finalCorrectText(response.finalCorrect),
          response.teacherMark === "correct" || response.teacherMark === "wrong"
            ? "教师"
            : "自动",
          response.activeSec === null ? "" : String(response.activeSec),
          String(response.hintsUsed),
          String(response.changeCount),
          response.teacherComment ?? "",
          inkUrl,
        ];
        lines.push(cells.map(csvCell).join(","));
      }
    }
  }
  return lines.join("\r\n");
}
