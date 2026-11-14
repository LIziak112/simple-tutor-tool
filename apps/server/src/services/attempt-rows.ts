import {
  ALL_ENABLED_CAPABILITIES,
  type CapabilitySwitch,
  canonicalAssignmentDueAt,
  type Question,
} from "@tutor/contract";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Assignment,
  type Attempt,
  type Course,
  courses,
  lectures,
  questions,
  type ResponseRow,
  type Unit,
  units,
} from "../db/schema";
import { requireAssignmentRow } from "./attempt-access.ts";
import { attemptResponseRows } from "./attempt-freeze.ts";
import { attemptTeacherId, attemptUnitIds } from "./attempt-question-set.ts";
import { getCapabilityProfile } from "./capability-profile-service";
import { snapshotOfRow } from "./snapshot";

// ---------- 题目集合按来源分派（T2A.6；T2A.7 多单元化） ----------

/**
 * T7.7：attempt → 所属教师的有效辅助能力启用集（草稿/结果视图同口径下发）。
 * 无教师域的异常学生行兜底全启用——与题目域的 fail closed（空结果）不同：
 * 开关只影响 steps 揭晓与手写入口的渲染，不是安全边界，兜底到「多给辅助」
 * 一侧不改变正式作答与判分（方案 §4.5）。2026-10 讲练一体起导出：
 * lesson-service 开卷投影同口径复用。
 */
export function attemptEnabledCapabilities(
  db: Db,
  attempt: Attempt,
): CapabilitySwitch[] {
  const teacherId = attemptTeacherId(db, attempt);
  return teacherId === null
    ? [...ALL_ENABLED_CAPABILITIES]
    : getCapabilityProfile(db, teacherId).enabledCapabilities;
}

/**
 * 错题重练卷的统一标题（2026-10）：答题页/结果页 h1、草稿视图与结果视图的
 * 单组标题、来源 meta 均用它；「错题重练 · 第 n 次」的次数串由前端拼。
 */
export const WRONG_PRACTICE_TITLE = "错题重练";

/** unitId 为 null 的兜底组标题（结构元信息缺失/卷无单元语义时的展示文案） */
export const UNGROUPED_TITLE = "未分组题目";

/** 冻结行条目：行 + 冻结单元归属（null = 无归属信息，消费方归兜底组） */
export interface FrozenRowEntry {
  readonly row: ResponseRow;
  readonly unitId: string | null;
}

/**
 * 冻结行的分组与展示序（T6R.3，方案 §5.1「题目集合、顺序与完整快照」全部冻结）：
 * - wrong 来源：建卷插入序（rowid）单组（卷无单元语义，unitId 恒 null）；
 * - **建卷即冻结的卷**（legacyUnverified=false 且行带冻结 unitId，建卷时
 *   写入）：**结构与顺序完全从冻结行自身重建**——组序 = unitId 在 rowid 序中
 *   的首现序（建卷组卷的单元序）、组内序 = rowid（建卷题序）。教师此后重排
 *   题目/移动单元不影响已建卷的结构（单元标题才查 units 表，仅展示文案）；
 * - **懒冻结的存量卷（legacyUnverified=true）与升级前已交卷的遗留行**：沿用
 *   域内 questions join 提供归属与排序的既有口径（存量卷的 rowid 序≠组卷序，
 *   按当前题库序展示与升级前一致；不在 attempt 单元集合内的行追加在末尾，
 *   不丢数据）；
 * - 混合行集（理论不可达——懒冻结补写快照时一并填 unitId，仅损坏快照的遗留
 *   行保持 null）：冻结行按首现序在前，null 行按 rowid 追加末尾。
 */
export function frozenRowsInDisplayOrder(
  db: Db,
  attempt: Attempt,
  /** 预载行（交卷链路免二次装载；缺省自查） */
  preloadedRows?: readonly ResponseRow[],
): FrozenRowEntry[] {
  if (attempt.sourceType === "wrong") {
    return (preloadedRows ?? attemptResponseRows(db, attempt.id)).map(
      (row) => ({
        row,
        unitId: null as string | null,
      }),
    );
  }
  const ownRows = preloadedRows ?? attemptResponseRows(db, attempt.id);
  const useFrozenOrder =
    !attempt.legacyUnverified && ownRows.some((row) => row.unitId !== null);
  if (useFrozenOrder) {
    // 冻结路径（建卷即冻结的卷）：rowid 序即建卷序，组序由消费方按 unitId
    // 首现序收集
    return ownRows.map((row) => ({ row, unitId: row.unitId }));
  }
  // 遗留路径（懒冻结的存量卷 legacyUnverified=true / 升级前已交卷）：域内
  // join 提供归属与排序——存量卷 rowid 序 ≠ 组卷序（升级前草稿行先于懒冻结
  // 补插行），按当前题库序展示与升级前一致；懒冻结补写的 unitId 仅作数据
  // 完备，不用于排序
  const teacherId = attemptTeacherId(db, attempt);
  if (teacherId === null) {
    return ownRows.map((row) => ({ row, unitId: null as string | null }));
  }
  const metaByQuestion =
    ownRows.length === 0
      ? new Map<string, { unitId: string; order: number }>()
      : new Map(
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
                  ownRows.map((row) => row.questionId),
                ),
              ),
            )
            .all()
            .map(
              (row) =>
                [row.id, { unitId: row.unitId, order: row.order }] as const,
            ),
        );
  const unitIds = attemptUnitIds(db, attempt);
  const unitIndex = new Map(unitIds.map((unitId, i) => [unitId, i] as const));
  const fallbackRank = unitIds.length; // 不在 attempt 单元集合内的行追加末尾
  return ownRows
    .map((row) => {
      const meta = metaByQuestion.get(row.questionId);
      return {
        row,
        unitId: meta?.unitId ?? null,
        unitRank:
          meta !== undefined && unitIndex.has(meta.unitId)
            ? (unitIndex.get(meta.unitId) as number)
            : fallbackRank,
        order: meta?.order ?? Number.MAX_SAFE_INTEGER,
      };
    })
    .sort(
      (a, b) =>
        a.unitRank - b.unitRank ||
        a.order - b.order ||
        (a.row.questionId < b.row.questionId
          ? -1
          : a.row.questionId > b.row.questionId
            ? 1
            : 0),
    )
    .map(({ row, unitId }) => ({ row, unitId }));
}

/** unitGroupedRows 的一组：冻结单元归属 + 当前标题（展示文案）+ 组内行（有序） */
export interface UnitGroupedRows {
  readonly unitId: string | null;
  readonly title: string;
  readonly rows: ResponseRow[];
}

/**
 * 冻结行的单元分组（分组与顺序的**统一实现**，四类消费方共用：草稿/取卷的
 * 公开投影、学生结果视图、教师作答详情、导出——都在 frozenRowsInDisplayOrder
 * 之上）：按 unitId 收集（Map 保首现序 = 建卷单元序），组内保持行序；unitId
 * 为 null 的行归**末尾兜底组**（组 id 用 attemptId，不指涉资源；wrong 卷行全
 * 部落此组、标题「错题重练」，其余来源标题「未分组题目」——防御性分组）。
 * 标题查 units 表当前值（D1 引用语义，仅展示文案——结构冻结、文案不冻结）。
 */
export function unitGroupedRows(
  db: Db,
  attempt: Attempt,
  /** 预载行（交卷链路免二次装载；缺省自查） */
  preloadedRows?: readonly ResponseRow[],
): UnitGroupedRows[] {
  const entries = frozenRowsInDisplayOrder(db, attempt, preloadedRows);
  const teacherId = attemptTeacherId(db, attempt);
  const unitIdsNeeded = [
    ...new Set(
      entries
        .map((entry) => entry.unitId)
        .filter((unitId): unitId is string => unitId !== null),
    ),
  ];
  const titleByUnit = new Map(
    teacherId !== null && unitIdsNeeded.length > 0
      ? db
          .select({ id: units.id, title: units.title })
          .from(units)
          .where(
            and(
              eq(units.teacherId, teacherId),
              inArray(units.id, unitIdsNeeded),
            ),
          )
          .all()
          .map((row) => [row.id, row.title] as const)
      : [],
  );
  const rowsByUnit = new Map<string, ResponseRow[]>();
  const fallbackRows: ResponseRow[] = [];
  for (const { row, unitId } of entries) {
    if (unitId === null) {
      fallbackRows.push(row);
      continue;
    }
    const list = rowsByUnit.get(unitId);
    if (list === undefined) rowsByUnit.set(unitId, [row]);
    else list.push(row);
  }
  const groups: UnitGroupedRows[] = [...rowsByUnit.entries()].map(
    ([unitId, rows]) => ({
      unitId,
      title: titleByUnit.get(unitId) ?? unitId,
      rows,
    }),
  );
  if (fallbackRows.length > 0) {
    // 兜底组标题参数化：wrong 卷行全落此组（标题「错题重练」）；其余来源为
    // 正常链路不可达的防御性分组（标题「未分组题目」——人文文案，不露 id）
    groups.push({
      unitId: null,
      title:
        attempt.sourceType === "wrong" ? WRONG_PRACTICE_TITLE : UNGROUPED_TITLE,
      rows: fallbackRows,
    });
  }
  return groups;
}

/** groupedSnapshotRows 的输出组：组 id（unitId ?? attemptId）+ 标题 + 投影条目 */
export interface GroupedSnapshotRows<T> {
  readonly id: string;
  readonly title: string;
  readonly items: T[];
}

/**
 * 分组行的快照投影（四消费方共用的三连习语收敛：**跳过快照缺失行 + 组 id
 * 回退 attemptId + 空组过滤**——草稿/取卷公开投影、草稿答案/提示回显收集、
 * 学生结果视图、教师详情都在 unitGroupedRows 之上走这一层）：
 * - snapshotOf 可注入（交卷链路传判分已 parse 的快照，缺省 snapshotOfRow）；
 * - project 收 (row, snapshot, group)——消费方借 group.unitId/title 做占位。
 */
export function groupedSnapshotRows<T>(
  db: Db,
  attempt: Attempt,
  project: (row: ResponseRow, snapshot: Question, group: UnitGroupedRows) => T,
  opts?: {
    preloadedRows?: readonly ResponseRow[];
    snapshotOf?: (row: ResponseRow) => Question | null;
  },
): GroupedSnapshotRows<T>[] {
  const snapshotOf = opts?.snapshotOf ?? snapshotOfRow;
  return unitGroupedRows(db, attempt, opts?.preloadedRows)
    .map((group) => {
      const items = group.rows.flatMap((row) => {
        const snapshot = snapshotOf(row);
        return snapshot === null ? [] : [project(row, snapshot, group)];
      });
      return { id: group.unitId ?? attempt.id, title: group.title, items };
    })
    .filter((group) => group.items.length > 0);
}

/** 答题页顶部展示的来源信息（assignment=作业标题+截止+公布时机；course=单元标题+课程名） */
interface AttemptSourceMeta {
  title: string;
  courseName: string | null;
  dueAt: string | null;
  /**
   * 公布时机（2026-10-21 交卷前置预期）：assignment = 作业行原值；course/wrong
   * 恒 'on_submit'（D11 交卷即公布）；lesson attempt 级不适用（当题释放恒题级
   * 粒度）同样投影 'on_submit'。草稿视图据此下发，交卷弹窗展示「截止后统一
   * 公布」预期；结果视图权威 gate 仍是 answersReleased（读时判定）。
   */
  answerRelease: Assignment["answerRelease"];
}

/**
 * lesson 来源的上下文单源（2026-10 讲练一体收敛；本模块 attemptSourceMeta
 * 学生侧与 teacher-attempt-service.sourceOf 教师侧两投影共用，不再各自查行）：
 * - 标题链（以教师侧既有三级链为准，更完备）：讲义标题（D1 引用语义，随行
 *   当前值）→ 嵌入单元标题（teacherId 域内，讲义行异常缺失时兜底）→
 *   attempt.unitId →「讲练练习」（人文文案兜底，不露异常）；
 * - 课程名随 courseId 行（打开时来自哪门课；可空 → null）。
 */
export function lessonSourceContextOf(
  db: Db,
  attempt: Attempt,
  teacherId: string | null,
): { title: string; courseName: string | null } {
  const lecture =
    attempt.lectureId !== null
      ? db
          .select({ title: lectures.title })
          .from(lectures)
          .where(eq(lectures.id, attempt.lectureId))
          .get()
      : undefined;
  const course =
    attempt.courseId !== null
      ? db
          .select({ title: courses.title })
          .from(courses)
          .where(eq(courses.id, attempt.courseId))
          .get()
      : undefined;
  const unit =
    lecture === undefined && attempt.unitId !== null && teacherId !== null
      ? db
          .select({ title: units.title })
          .from(units)
          .where(
            and(eq(units.teacherId, teacherId), eq(units.id, attempt.unitId)),
          )
          .get()
      : undefined;
  return {
    // 讲义标题 → 嵌入单元标题 → attempt.unitId →「讲练练习」
    title: lecture?.title ?? unit?.title ?? attempt.unitId ?? "讲练练习",
    courseName: course?.title ?? null,
  };
}

export function attemptSourceMeta(db: Db, attempt: Attempt): AttemptSourceMeta {
  if (attempt.sourceType === "wrong") {
    // 错题重练（2026-10）：标题固定「错题重练」，无课程/截止
    //（「错题重练 · 第 n 次」的来源行由前端从 attemptNo 拼）
    return {
      title: WRONG_PRACTICE_TITLE,
      courseName: null,
      dueAt: null,
      answerRelease: "on_submit",
    };
  }
  if (attempt.sourceType === "lesson") {
    // 讲练页（2026-10）：标题 = 讲练页讲义当前标题（D1 引用语义），不限截止
    //（lesson 当题释放恒题级粒度，不适用 answerRelease，见 attemptSourceSchema）；
    // courseId 可空（打开时来自哪门课），课程名随行。上下文与教师侧 sourceOf
    // 同一实现（lessonSourceContextOf，标题兜底链以教师侧三级链为准）
    const { title, courseName } = lessonSourceContextOf(
      db,
      attempt,
      attemptTeacherId(db, attempt),
    );
    return { title, courseName, dueAt: null, answerRelease: "on_submit" };
  }
  if (attempt.sourceType === "course") {
    // 课程练习：标题 = 单元当前标题（D1 引用而非复制）；不限截止（D11 交卷即公布）。
    // T2B.5：单元标题按 attempt → student.teacherId 域内读（D10）
    const teacherId = attemptTeacherId(db, attempt);
    const unit: Unit | undefined =
      attempt.unitId !== null && teacherId !== null
        ? db
            .select()
            .from(units)
            .where(
              and(eq(units.teacherId, teacherId), eq(units.id, attempt.unitId)),
            )
            .get()
        : undefined;
    const course: Course | undefined =
      attempt.courseId !== null
        ? db
            .select()
            .from(courses)
            .where(eq(courses.id, attempt.courseId))
            .get()
        : undefined;
    return {
      title: unit?.title ?? "课程练习",
      courseName: course?.title ?? null,
      dueAt: null,
      answerRelease: "on_submit",
    };
  }
  const assignment = requireAssignmentRow(db, attempt.assignmentId ?? "");
  // T2A.7：作业挂了课程时返回课程名（来源行「作业 · 课程名」）；无课程为 null
  const course: Course | undefined =
    assignment.courseId !== null
      ? db
          .select()
          .from(courses)
          .where(eq(courses.id, assignment.courseId))
          .get()
      : undefined;
  return {
    title: assignment.title,
    courseName: course?.title ?? null,
    dueAt: canonicalAssignmentDueAt(assignment.dueAt),
    answerRelease:
      assignment.answerRelease === "on_submit" ? "on_submit" : "after_due",
  };
}
