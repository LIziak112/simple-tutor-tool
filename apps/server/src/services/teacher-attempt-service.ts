import {
  type Question,
  type TeacherAttemptCard,
  type TeacherAttemptDetailData,
  type TeacherAttemptDetailQuestion,
  type TeacherAttemptInkInfo,
  type TeacherAttemptListData,
  type TeacherAttemptListQuery,
  type TeacherAttemptSource,
  type WrongScope,
  wrongPracticeScopeSchema,
  wrongScopeLabelOf,
} from "@tutor/contract";
import { studentStemMd } from "@tutor/md-dsl";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  assignments,
  attempts,
  courses,
  type InkRow,
  ink,
  questions,
  type ResponseRow,
  responses,
  students,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  answerOf,
  attemptQuestionRows,
  attemptResponseRows,
  attemptUnitIds,
  ensureAttemptFrozen,
  lessonSourceContextOf,
  unitGroupedRows,
} from "./attempt-service";
import {
  pendingMarkCount,
  pendingMarkCountsByStudent,
  practiceSubmittedCounts,
} from "./pending-mark";
import { attemptResultCounts } from "./result-counts";
import { selfReviewStateOf } from "./review-state.ts";
import { releaseOfSnapshot, snapshotOfRow } from "./snapshot";

/**
 * TeacherAttemptService（T3.1，Phase3 清单 D5–D8）——教师端作答数据页业务层：
 * - listTeacherAttempts：attempt → student → teacherId 归属过滤（乙教师查不到
 *   甲学生的作答）+ 筛选组合 + 按最近活动时间（submittedAt ?? startedAt）倒序
 *   + 分页 limit/offset 与 total；来源上下文名经 join 组装（assignments.title /
 *   units.title / courses.title / attemptNo）；
 * - getTeacherAttemptDetail：D7 全字段逐题视图。draft 亦可用（D5）——题目列表
 *   取当前库该 attempt 单元的 live 题目（与学生草稿视图同源，未答题也有行），
 *   整卷不下发参考答案/详解；已交卷取 responses.questionSnapshotJson（含答案
 *   与详解）；手写信息一律按 ink 表 (attemptId, questionId) 关联（D7：不读
 *   responses.inkId——该列从未写入，draft 也可能有笔迹）；全卷连续题号按
 *   attempt 单元顺序 × 题目顺序编排。
 *
 * 权限口径（T2B 域隔离红线）：attempt 归属链 attempt → student → teacherId，
 * 非本人学生的作答按不存在处理（404 ATTEMPT_NOT_FOUND，不暴露存在性）。
 * 题目/单元读取按该 teacherId 域内进行（attemptTeacherId 同源推导）。
 */

/**
 * 判定展示口径（D2/D3 前置约定）：`finalCorrect ?? autoCorrect`——教师批改
 * （T3.2 落地）优先，否则回落自动判定。汇总计数（详情头对/错/待批）统一用它；
 * 本阶段 finalCorrect 恒 null，等价于 autoCorrect。
 */
export function effectiveCorrect(
  finalCorrect: boolean | null,
  autoCorrect: boolean | null,
): boolean | null {
  return finalCorrect ?? autoCorrect;
}

/** 最近活动时间排序键（D6/D10 同一口径：submittedAt ?? startedAt） */
const lastActivitySql = sql`coalesce(${attempts.submittedAt}, ${attempts.startedAt})`;

// answerOf/jsonOf 已收敛唯一实现：attempt-service.answerOf（null 语义）与
// snapshot.jsonOf——本文件经顶部 import 使用，不再留平行副本

/** 手写信息投影（D7：ink 行存在才返回；pngUrl 指向教师端 PNG 直出接口）；
 * T3.2b 起导出——待批队列卡片拼装复用（mark-response.ts） */
export function inkInfoOf(
  row: InkRow | undefined,
): TeacherAttemptInkInfo | null {
  if (row === undefined) return null;
  return {
    inkId: row.id,
    pngUrl: `/api/teacher/ink/${row.id}.png`,
    hasStrokes: row.strokeCount > 0,
  };
}

/**
 * 来源上下文（列表卡片与详情头共用）：assignment=作业标题（+可选课程名）；
 * course=单元标题 + 课程名 + attemptNo（「单元标题 · 第 n 次」）；wrong=错题
 * 重练（2026-10：courseId/assignmentId/unitId 全 null，展示「错题重练 ·
 * 第 n 次」，由前端/CSV 拼串）；lesson=讲练页（2026-10 讲练一体：unitId 为
 * 嵌入单元快照值，**unitTitle 承载讲义标题**——记录/教师列表的展示标题
 * 口径「标题=讲义标题」，契约形态字段已可表达（teacherAttemptSourceSchema
 * 注释），讲义行异常缺失时兜底嵌入单元标题/attempt.unitId）。
 * 单元/课程按 teacherId 域内读；assignment 行经 FK 必存在（含已软删作业——
 * 作答记录不随作业删除消失，标题为布置时快照），异常缺失时兜底占位文案。
 * T3.2b 起导出——待批队列卡片拼装复用（mark-response.ts）。
 */

/**
 * 错题重练范围展示形态（#6980-2，sourceOf 与师生两端标题单源共用）：
 * label 取建卷存的 scope 快照（历史卷无存档为 null）；questionCount=卷内
 * 冻结 responses 行数；originUnits=冻结 responses→questions→units 反查的
 * 归属单元分布（题/单元已删除自然缺项；按次数倒序、同数次数字典序稳定）。
 */
export function wrongScopeOf(db: Db, attempt: Attempt): WrongScope {
  const rows = db
    .select({ id: responses.id })
    .from(responses)
    .where(eq(responses.attemptId, attempt.id))
    .all();
  const unitRows = db
    .select({ title: units.title })
    .from(responses)
    .innerJoin(questions, eq(responses.questionId, questions.id))
    .innerJoin(units, eq(questions.unitId, units.id))
    .where(eq(responses.attemptId, attempt.id))
    .all();
  const unitCounts = new Map<string, number>();
  for (const row of unitRows) {
    unitCounts.set(row.title, (unitCounts.get(row.title) ?? 0) + 1);
  }
  const originUnits = [...unitCounts.entries()]
    .map(([title, count]) => ({ title, count }))
    .sort(
      (a, b) =>
        b.count - a.count || a.title.localeCompare(b.title, "zh-Hans-CN"),
    );
  let label: string | null = null;
  if (attempt.practiceScopeJson !== null) {
    try {
      const parsed = wrongPracticeScopeSchema.safeParse(
        JSON.parse(attempt.practiceScopeJson),
      );
      label = parsed.success ? wrongScopeLabelOf(parsed.data) : null;
    } catch {
      label = null;
    }
  }
  return { label, questionCount: rows.length, originUnits };
}

export function sourceOf(
  db: Db,
  attempt: Attempt,
  teacherId: string,
): TeacherAttemptSource {
  if (attempt.sourceType === "wrong") {
    return {
      sourceType: "wrong",
      courseId: null,
      courseName: null,
      assignmentId: null,
      assignmentTitle: null,
      unitId: null,
      unitTitle: null,
      attemptNo: attempt.attemptNo,
      wrongScope: wrongScopeOf(db, attempt),
    };
  }
  if (attempt.sourceType === "lesson") {
    // 讲练页（2026-10）：courseId 可空（打开时来自哪门课），不挂作业；
    // unitId = 嵌入单元快照值（分组键），unitTitle = 讲义标题（展示口径）。
    // 上下文与学生侧 attemptSourceMeta 同一实现（lessonSourceContextOf：
    // 讲义标题 → 嵌入单元标题 → attempt.unitId 的人文兜底链）
    const { title, courseName } = lessonSourceContextOf(db, attempt, teacherId);
    return {
      sourceType: "lesson",
      courseId: attempt.courseId,
      courseName,
      assignmentId: null,
      assignmentTitle: null,
      unitId: attempt.unitId,
      unitTitle: title,
      attemptNo: attempt.attemptNo,
    };
  }
  if (attempt.sourceType === "course") {
    const course =
      attempt.courseId !== null
        ? db
            .select({ title: courses.title })
            .from(courses)
            .where(eq(courses.id, attempt.courseId))
            .get()
        : undefined;
    const unit =
      attempt.unitId !== null
        ? db
            .select({ title: units.title })
            .from(units)
            .where(
              and(eq(units.teacherId, teacherId), eq(units.id, attempt.unitId)),
            )
            .get()
        : undefined;
    return {
      sourceType: "course",
      courseId: attempt.courseId,
      courseName: course?.title ?? null,
      assignmentId: null,
      assignmentTitle: null,
      unitId: attempt.unitId,
      // 单元软删不删行（D16），标题仍可读；异常缺失兜底用单元 id
      unitTitle: unit?.title ?? attempt.unitId ?? "",
      attemptNo: attempt.attemptNo,
    };
  }
  const assignment =
    attempt.assignmentId !== null
      ? db
          .select({ title: assignments.title, courseId: assignments.courseId })
          .from(assignments)
          .where(eq(assignments.id, attempt.assignmentId))
          .get()
      : undefined;
  // attempt.courseId 在创建时即取作业所属课程（T2A.7）；兜底再读作业行
  const courseId = attempt.courseId ?? assignment?.courseId ?? null;
  const course =
    courseId !== null
      ? db
          .select({ title: courses.title })
          .from(courses)
          .where(eq(courses.id, courseId))
          .get()
      : undefined;
  return {
    sourceType: "assignment",
    courseId,
    courseName: course?.title ?? null,
    assignmentId: attempt.assignmentId,
    assignmentTitle: assignment?.title ?? "（作业已不存在）",
    unitId: null,
    unitTitle: null,
    attemptNo: attempt.attemptNo,
  };
}

/** attempt 的笔迹行索引：questionId → ink 行（(attemptId, questionId) 唯一）；
 * T3.2b 起导出——待批队列卡片拼装复用（mark-response.ts） */
export function inkByQuestionOf(
  db: Db,
  attemptId: string,
): Map<string, InkRow> {
  return new Map(
    db
      .select()
      .from(ink)
      .where(eq(ink.attemptId, attemptId))
      .all()
      .map((row) => [row.questionId, row] as const),
  );
}

/** 单元 id → 标题（teacherId 域内；软删单元行保留，标题仍可读，D16）。
 * T3.4 起导出——CSV 导出行组装复用（export-csv.ts） */
export function unitTitleByIdOf(
  db: Db,
  teacherId: string,
  unitIds: readonly string[],
): Map<string, string> {
  if (unitIds.length === 0) return new Map();
  return new Map(
    db
      .select({ id: units.id, title: units.title })
      .from(units)
      .where(
        and(eq(units.teacherId, teacherId), inArray(units.id, [...unitIds])),
      )
      .all()
      .map((row) => [row.id, row.title] as const),
  );
}

// ---------- GET /api/teacher/attempts ----------

/**
 * 教师端作答列表（D6 三视图与来源筛选共用）：
 * - 归属：attempt → student → teacherId（域内过滤，乙教师查不到甲数据）；
 * - 筛选可任意组合：studentId / courseId / assignmentId / unitId（DSL id，只命中
 *   course 来源——assignment 来源不落单单元）/ sourceType / status / from / to
 *   （时间范围按最近活动时间 submittedAt ?? startedAt，与排序同一时间轴）；
 * - 排序：最近活动时间倒序（并按 id 倒序兜底稳定）；
 * - 分页：limit（默认 50，≤200）/ offset；total 为筛选后总条数；
 * - 卡片：来源上下文、单元数 / 题数（draft=当前 live 题数，已交卷=responses
 *   冻结行数）、得分双字段（scoreAuto / scoreFinal 透传，展示口径由前端取
 *   scoreFinal ?? scoreAuto，D2）、待批数（pending-mark 共享谓词，D4）。
 */
export function listTeacherAttempts(
  db: Db,
  teacherId: string,
  query: TeacherAttemptListQuery,
): TeacherAttemptListData {
  const filters = [
    query.studentId !== undefined
      ? eq(attempts.studentId, query.studentId)
      : undefined,
    query.courseId !== undefined
      ? eq(attempts.courseId, query.courseId)
      : undefined,
    query.assignmentId !== undefined
      ? eq(attempts.assignmentId, query.assignmentId)
      : undefined,
    query.unitId !== undefined ? eq(attempts.unitId, query.unitId) : undefined,
    query.sourceType !== undefined
      ? eq(attempts.sourceType, query.sourceType)
      : undefined,
    query.status !== undefined ? eq(attempts.status, query.status) : undefined,
    query.from !== undefined
      ? sql`${lastActivitySql} >= ${query.from}`
      : undefined,
    query.to !== undefined ? sql`${lastActivitySql} <= ${query.to}` : undefined,
  ].filter((item): item is NonNullable<typeof item> => item !== undefined);

  const where = and(
    eq(students.teacherId, teacherId),
    // 作废卷（2026-10 讲练随时重开）不进教师作答列表（行保留审计）
    isNull(attempts.abandonedAt),
    ...filters,
  );
  const totalRow = db
    .select({ n: sql<number>`count(*)` })
    .from(attempts)
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(where)
    .get();
  const rows = db
    .select({ attempt: attempts, studentName: students.displayName })
    .from(attempts)
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(where)
    .orderBy(desc(lastActivitySql), desc(attempts.id))
    .limit(query.limit)
    .offset(query.offset)
    .all();

  const resultCounts = attemptResultCounts(
    db,
    rows.map((row) => row.attempt),
  );
  // T-PR4：行级已提交数（学生主页作答记录区「已提交 n / 共 m」用；与 v1 逐题
  // 进度同一实现 practiceSubmittedCounts——draft 按行级事实、已收尾收敛整卷）
  const submittedCounts = practiceSubmittedCounts(
    db,
    rows.map((row) => row.attempt),
  );
  const cards: TeacherAttemptCard[] = rows.map(({ attempt, studentName }) => ({
    attemptId: attempt.id,
    studentId: attempt.studentId,
    studentName,
    ...sourceOf(db, attempt, teacherId),
    unitCount: attemptUnitIds(db, attempt).length,
    // 题数（T6R.3）：wrong（建卷即有自有行）、已交卷、已冻结的 draft 均以
    // responses 冻结行数为准（**快照非空**——幽灵行不计数，与视图/待批谓词
    // 同口径）；升级遗留的未冻结 draft 过渡期用当前 live 题数（学生首次恢复
    // 访问即冻结，随之切换到行数口径）
    questionCount:
      attempt.sourceType === "wrong" ||
      attempt.status !== "draft" ||
      attempt.frozenAt !== null
        ? (db
            .select({ n: sql<number>`count(*)` })
            .from(responses)
            .where(
              and(
                eq(responses.attemptId, attempt.id),
                isNotNull(responses.questionSnapshotJson),
              ),
            )
            .get()?.n ?? 0)
        : attemptQuestionRows(db, attempt).length,
    status: attempt.status,
    resultCounts: resultCounts.get(attempt.id) ?? null,
    scoreAuto: attempt.scoreAuto,
    scoreFinal: attempt.scoreFinal,
    // D4 共享待批谓词（finalCorrect IS NULL；draft 恒 0）——与详情/矩阵/单元卡片同口径
    pendingCount: pendingMarkCount(db, attempt),
    submittedCount: submittedCounts.get(attempt.id)?.submitted ?? 0,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    activeSec: attempt.activeSec,
  }));
  return { attempts: cards, total: totalRow?.n ?? 0 };
}

/**
 * 教师侧「可盘点作答行」共享谓词（教师迭代 T-PR2 抽出；T-PR3 已提交行放行与
 * 学生主页聚合端点同用）：排作废卷（abandonedAt 非空）；进行中（draft）卷只纳入
 * 单题已提交的行（responses.submittedAt 非空——讲练一体 2026-10 起的单题提交
 * 时刻），整卷未交的 draft 行判定列不可信、不对外盘点；快照缺失的「历史题目
 * 缺失」幽灵行（T6R.3）一并排除，与 D4 待批谓词同口径。使用方必须同时 join
 * attempts 与 responses 两表。
 */
export function teacherVisibleResponsesWhere() {
  return [
    isNull(attempts.abandonedAt),
    isNotNull(responses.questionSnapshotJson),
    or(ne(attempts.status, "draft"), isNotNull(responses.submittedAt)),
  ];
}

// ---------- GET /api/teacher/attempts/:id ----------

/**
 * attempt → 学生归属链查行（**不抛**；null = 不存在或域外，不区分——不暴露
 * 存在性）。T6R.5 复审②从 requireTeacherAttempt 拆出：note-service 教师端
 * 版本/图片授权需要同一归属判定但错误码不同（NOTE_NOT_FOUND），共用本原语
 * + 各自错误码的薄抛层，保证域判定口径永不漂移。
 */
export function findTeacherAttempt(
  db: Db,
  teacherId: string,
  attemptId: string,
): { attempt: Attempt; studentName: string } | null {
  const row = db
    .select({
      attempt: attempts,
      studentName: students.displayName,
      ownerTeacherId: students.teacherId,
    })
    .from(attempts)
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(eq(attempts.id, attemptId))
    .get();
  if (row === undefined || row.ownerTeacherId !== teacherId) {
    return null;
  }
  return { attempt: row.attempt, studentName: row.studentName };
}

/**
 * attempt 行（经学生归属链）：不存在或非本人学生的作答 → 404（不暴露存在性）。
 * 判定原语在 findTeacherAttempt；本函数是 ATTEMPT_NOT_FOUND 口径的薄抛层
 * （note-service 以 NOTE_NOT_FOUND 口径复用同一原语）。
 */
export function requireTeacherAttempt(
  db: Db,
  teacherId: string,
  attemptId: string,
): { attempt: Attempt; studentName: string } {
  const row = findTeacherAttempt(db, teacherId, attemptId);
  if (row === null) {
    throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
  }
  return row;
}

// 快照解析统一走 services/snapshot.ts 的 snapshotOfRow（T6R.3 全服务端唯一
// 实现，含坏数据 warn 留痕）——本文件与 mark-response/wrong-practice 均经其
// 读取，不再各自 safeParse。

/**
 * Web-3 / T-PR3 行级放行谓词（teacherVisibleResponsesWhere 的行级读法，同一口径）：
 * draft 卷内学生已逐题提交（submitted_at 非空）的行按已交卷投影（判定 + 参考
 * 答案 + 笔迹）；未提交行维持 D5 draft 口径；作废卷（abandonedAt 非空）整卷
 * 不放行。非 draft 卷恒放行（判定下发本就不受 D5 约束）。
 */
function rowVisibleInDraftOf(attempt: Attempt) {
  const draftOpen = attempt.status === "draft" && attempt.abandonedAt === null;
  return (submittedAt: string | null): boolean =>
    attempt.status !== "draft" || (draftOpen && submittedAt !== null);
}

/**
 * 详情单题条目组装（wrong 与非 wrong 分支共用——原两份 40 行孪生收敛）：
 * - draft（未放行行，Web-3 起按行判定）：题干经 studentStemMd 学生端投影
 *   （详情不下发参考答案）、判定字段 null（判定列显示「未交卷」）、不提供
 *   批注定位 responseId；已逐题提交的放行行走已交卷分支；
 * - submitted/graded：快照题干原文 + 参考答案/详解，responseId=冻结行 id
 *   （详情页内联批改 POST /responses/:id/mark 定位用）；
 * - unitId/unitTitle 由调用方给（wrong=题目当前单元〔错题「来自哪个练习」的
 *   展示口径〕，非 wrong=冻结分组；title 传组标题占位，下方统一回填覆盖）。
 */
function detailItemOf(
  row: ResponseRow,
  snapshot: Question,
  opts: {
    isDraft: boolean;
    unitId: string;
    unitTitle: string;
    ink: TeacherAttemptInkInfo | null;
  },
): Omit<TeacherAttemptDetailQuestion, "no"> {
  const isDraft = opts.isDraft;
  return {
    questionId: row.questionId,
    responseId: isDraft ? null : row.id,
    unitId: opts.unitId,
    unitTitle: opts.unitTitle,
    type: snapshot.type,
    difficulty: snapshot.difficulty,
    knowledge: snapshot.knowledge,
    stemMd: isDraft ? studentStemMd(snapshot) : snapshot.stemMd,
    ...(snapshot.options !== undefined
      ? { options: snapshot.options.map((option) => option.text) }
      : {}),
    answer: answerOf(row.answerJson),
    autoCorrect: isDraft ? null : row.autoCorrect,
    finalCorrect: isDraft ? null : row.finalCorrect,
    // #6980-3：是否有实际作答（draft 行恒默认 false，判定区仅已交卷消费）
    answered: row.answered,
    // #6980-4：做题时学生自标「不会」（draft 亦下发，教师可提前看到）
    studentFlag: row.studentFlag === "unsure" ? "unsure" : null,
    ...(!isDraft ? { selfReview: selfReviewStateOf(row, snapshot) } : {}),
    teacherMark: isDraft
      ? null
      : row.teacherMark === "correct" || row.teacherMark === "wrong"
        ? row.teacherMark
        : null,
    teacherComment: isDraft ? null : row.teacherComment,
    activeSec: row.activeSec,
    hintsUsed: row.hintsUsed,
    changeCount: row.changeCount,
    ink: opts.ink,
    ...(isDraft ? {} : releaseOfSnapshot(snapshot)),
  };
}

/**
 * 教师端作答详情（D7 全字段；draft 亦可用，D5；T6R.3 起三来源统一读冻结行）：
 * - draft：题目取该 attempt 的冻结快照行（与学生草稿视图同源——懒冻结兜底
 *   升级遗留草稿；教师改题库不影响学生当前这卷，教师看到的即学生看到的），
 *   题干经 studentStemMd 学生端投影（详情不下发参考答案，题干标记里的答案与
 *   [x] 正确项同样不外露）；未提交行判定字段 null（判定列显示「未交卷」；
 *   Web-3/T-PR3 行级放行：已逐题提交的行按已交卷投影，见 rowVisibleInDraftOf）；
 *   未放行行 answers / solutionMd 字段缺省不发；快照缺失的历史行按「历史题目
 *   缺失」跳过；
 * - submitted / graded：逐题取 responses 冻结行（快照题干原文含 [[答案]] 标记、
 *   参考答案与详解照常下发——教师端不受泄露约束，改判与待批卡片都要用）；
 *   分组与排序经 unitGroupedRows 从冻结行自身重建（与学生结果视图同一实现；
 *   升级前已交卷的遗留行沿用域内 join 口径，questions 行缺失的响应行进末尾
 *   兜底组不丢弃——修正旧 inner join 直接丢行的行为）；
 * - 手写信息：ink 表 (attemptId, questionId) 关联（draft 也可能有笔迹无行）；
 * - 全卷连续题号：attempt 单元顺序 × 题目顺序，1 起；
 * - 计数：effectiveCorrect（finalCorrect ?? autoCorrect）口径；draft 全 0。
 */
export function getTeacherAttemptDetail(
  db: Db,
  teacherId: string,
  attemptId: string,
): TeacherAttemptDetailData {
  const { attempt: attemptRow, studentName } = requireTeacherAttempt(
    db,
    teacherId,
    attemptId,
  );
  // T6R.3：统一取懒冻结后的最新行（draft 幂等冻结并返回新对象——后续
  // unitGroupedRows 按 legacyUnverified 分派展示序，旧对象的标记是过期值；
  // 已交卷/已冻结时原样返回）
  const attempt = ensureAttemptFrozen(db, attemptRow);
  // Web-3 / T-PR3：draft 卷内已逐题提交（submitted_at 非空）的行放行判定、
  // 参考答案与笔迹；未提交行维持 D5 draft 口径；作废卷整卷不放行
  const draftRowVisible = rowVisibleInDraftOf(attempt);
  const source = sourceOf(db, attempt, teacherId);
  const inkByQuestion = inkByQuestionOf(db, attemptId);

  // 逐题条目（先按单元归属排序，再统一编号）
  const items: Omit<TeacherAttemptDetailQuestion, "no">[] = [];
  if (attempt.sourceType === "wrong") {
    // wrong（2026-10）：题目集合 = attempt 自有 responses 行（建卷时冻结的错题
    // 快照，按插入序 = 组卷题序）；draft 与已交卷同源（不查当前题库出题——
    // 教师改题不影响已建的卷）。draft 题干公开化、无判定与参考答案（与
    // assignment/course 的 draft 口径一致）；已交卷快照原文 + 参考答案/详解。
    // 单元列取题目当前归属单元（域内读，软删行仍在——错题「来自哪个练习」的
    // 展示口径，与错题本 originUnit 同源）；题目行缺失回退 questionId 占位。
    const ownRows = attemptResponseRows(db, attemptId);
    const unitByQuestion = new Map(
      ownRows.length > 0
        ? db
            .select({ id: questions.id, unitId: questions.unitId })
            .from(questions)
            .where(
              and(
                eq(questions.teacherId, teacherId),
                inArray(
                  questions.id,
                  ownRows.map((row) => row.questionId),
                ),
              ),
            )
            .all()
            .map((row) => [row.id, row.unitId] as const)
        : [],
    );
    for (const row of ownRows) {
      const snapshot = snapshotOfRow(row);
      if (snapshot === null) continue; // 坏快照按缺失计（建卷即冻结，理论不可达）
      const originUnitId = unitByQuestion.get(row.questionId) ?? row.questionId;
      items.push(
        detailItemOf(row, snapshot, {
          isDraft: !draftRowVisible(row.submittedAt),
          unitId: originUnitId,
          unitTitle: originUnitId, // 占位，下方统一回填（题目行缺失回退 questionId）
          ink: inkInfoOf(inkByQuestion.get(row.questionId)),
        }),
      );
    }
  } else {
    // 非 wrong（T6R.3）：draft 与 submitted/graded 统一消费 unitGroupedRows——
    // 分组与顺序从冻结行自身重建（unitId 首现序分组 + rowid 组内序）；升级前
    // 已交卷的遗留行沿用域内 join 口径。旧已交卷实现 inner join 会把 questions
    // 行缺失的响应行直接丢弃——统一为末尾兜底组展示（修正，不丢数据）。
    // draft 与学生草稿视图同源：题干经 studentStemMd 学生端投影（详情不下发
    // 参考答案，题干标记里的答案与 [x] 正确项同样不外露）、未提交行判定字段
    // null（判定列显示「未交卷」）；已逐题提交的行按已交卷投影（Web-3）。
    // 已交卷快照原文 + 参考答案/详解。快照缺失的
    // 历史行按「历史题目缺失」跳过；draft 进门先懒冻结（教师路径不经
    // requireUsableAttempt）。
    for (const group of unitGroupedRows(db, attempt)) {
      for (const row of group.rows) {
        const snapshot = snapshotOfRow(row);
        if (snapshot === null) continue; // 历史题目缺失跳过
        items.push(
          detailItemOf(row, snapshot, {
            isDraft: !draftRowVisible(row.submittedAt),
            // 兜底组（unitId=null，正常不可达）：unitId 用 questionId 稳定占位，
            // 标题占位用组标题「未分组题目」（人文文案，不露 id）
            unitId: group.unitId ?? row.questionId,
            unitTitle: group.unitId ?? group.title,
            ink: inkInfoOf(inkByQuestion.get(row.questionId)),
          }),
        );
      }
    }
  }

  // 单元标题统一回填（域内读，含软删单元；draft 与已交卷同口径）
  const unitTitles = unitTitleByIdOf(
    db,
    teacherId,
    items.map((item) => item.unitId),
  );
  const questionsOut: TeacherAttemptDetailQuestion[] = items.map(
    (item, index) => ({
      ...item,
      // 域内查到单元标题则覆盖占位；查不到（兜底组）保留占位文案（「未分组
      // 题目」/wrong 的 questionId 占位），不再回退裸 id
      unitTitle: unitTitles.get(item.unitId) ?? item.unitTitle,
      no: index + 1,
    }),
  );

  // 判定计数（effectiveCorrect 口径）；draft 卷只汇总已放行（逐题已提交）行、
  // 作废卷全 0（Web-3/T-PR3，此前 D5 整卷全 0）。
  // #6980-3：错次不含未做行——answered=false 的判错在详情里灰显「未做」，
  // 与学生结果视图、错题本 wrongCount 同口径。人工显式判定（teacherMark /
  // selfCorrect，审查修复 P0-1）不被「未做」掩盖：显式判错的行计入错次。
  // 计数从 responses 原始行取——questionsOut 投影不含 selfCorrect，且 draft
  // 投影会把判定置 null（isDraft 时 finalCorrect/autoCorrect 恒 null）。
  const judgedRows =
    attempt.status === "draft" && attempt.abandonedAt !== null
      ? []
      : db
          .select({
            finalCorrect: responses.finalCorrect,
            autoCorrect: responses.autoCorrect,
            answered: responses.answered,
            teacherMark: responses.teacherMark,
            selfCorrect: responses.selfCorrect,
          })
          .from(responses)
          .where(
            attempt.status === "draft"
              ? and(
                  eq(responses.attemptId, attempt.id),
                  isNotNull(responses.submittedAt),
                )
              : eq(responses.attemptId, attempt.id),
          )
          .all()
          .map((row) => ({
            verdict: effectiveCorrect(row.finalCorrect, row.autoCorrect),
            answered: row.answered,
            marked: row.teacherMark !== null || row.selfCorrect !== null,
          }));
  return {
    attemptId: attempt.id,
    studentId: attempt.studentId,
    studentName,
    ...source,
    resultCounts: attemptResultCounts(db, [attempt]).get(attempt.id) ?? null,
    status: attempt.status,
    scoreAuto: attempt.scoreAuto,
    scoreFinal: attempt.scoreFinal,
    correctCount: judgedRows.filter((row) => row.verdict === true).length,
    wrongCount: judgedRows.filter(
      (row) => row.verdict === false && (row.answered || row.marked),
    ).length,
    // #6980-3（审查修复 P1-4）：详情汇总补「未做」计数——判错但无实际作答且
    // 无人工判定，此前不进任何计数，四数对不上总题数
    notDoneCount: judgedRows.filter(
      (row) => row.verdict === false && !row.answered && !row.marked,
    ).length,
    pendingCount: judgedRows.filter((row) => row.verdict === null).length,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    activeSec: attempt.activeSec,
    questions: questionsOut,
  };
}

// ---------- T-PR4 Web-4：学生列表「活动三列」聚合 ----------

/** 学生活动三列（Web-4 学生列表）：最近作答时间 / 待批数 / 进行中讲练数 */
export interface StudentActivitySummary {
  /** 非作废 attempts 的最近活动时间（submittedAt ?? startedAt）；无作答为 null */
  lastActivityAt: string | null;
  /** D4 共享待批谓词计数（pendingMarkCountsByStudent，跨该生全部非作废卷） */
  pendingCount: number;
  /** draft 且非作废的 lesson（讲练）卷数 */
  inProgressLessonCount: number;
}

/**
 * 一批学生的活动三列聚合（listStudents 的数据源）：两条 attempt 级分组 SQL +
 * 待批谓词一条（D4 单一口径 pendingMarkCountsByStudent），无逐学生 N+1；
 * 无活动的学生补零值 / null。
 */
export function studentActivitySummaries(
  db: Db,
  studentIds: readonly string[],
): Map<string, StudentActivitySummary> {
  const map = new Map<string, StudentActivitySummary>();
  for (const id of studentIds) {
    map.set(id, {
      lastActivityAt: null,
      pendingCount: 0,
      inProgressLessonCount: 0,
    });
  }
  const ids = [...studentIds];
  if (ids.length === 0) return map;
  // 最近作答时间：max(coalesce(submittedAt, startedAt))，与作答列表排序同一时间轴
  for (const row of db
    .select({
      studentId: attempts.studentId,
      last: sql<string>`max(coalesce(${attempts.submittedAt}, ${attempts.startedAt}))`,
    })
    .from(attempts)
    .where(and(inArray(attempts.studentId, ids), isNull(attempts.abandonedAt)))
    .groupBy(attempts.studentId)
    .all()) {
    const entry = map.get(row.studentId);
    if (entry !== undefined) entry.lastActivityAt = row.last;
  }
  // 进行中讲练数：draft 且非作废的 lesson 卷
  for (const row of db
    .select({ studentId: attempts.studentId, n: sql<number>`count(*)` })
    .from(attempts)
    .where(
      and(
        inArray(attempts.studentId, ids),
        isNull(attempts.abandonedAt),
        eq(attempts.status, "draft"),
        eq(attempts.sourceType, "lesson"),
      ),
    )
    .groupBy(attempts.studentId)
    .all()) {
    const entry = map.get(row.studentId);
    if (entry !== undefined) entry.inProgressLessonCount = row.n;
  }
  // 待批数：D4 共享谓词（pending-mark 单一口径）
  for (const [studentId, n] of pendingMarkCountsByStudent(db, ids)) {
    const entry = map.get(studentId);
    if (entry !== undefined) entry.pendingCount = n;
  }
  return map;
}
