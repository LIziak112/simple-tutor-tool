import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { lectures, units } from "../db/schema.ts";

/**
 * 讲练嵌入单元的唯一判定（讲练一体 2026-10 的「讲练页一件事」）：
 * 嵌入单元 = units.lectureId 指向 kind='lesson' 讲义。判定**不看软删**——讲义
 * 软删恢复后单元仍是嵌入单元，调用方自行按各自的未删口径过滤外层行。
 *
 * 资源库单元列表、文件夹计数、课程目录/详情/计数、D8 配套展开共用这一谓词。
 * 2026-10-20 的两处回归（课程目录里多出「讲义 + 66 题」两个条目、文件夹计数
 * 把一篇讲练页算成 2）都是因为新读取面各自手写过滤时漏掉了这里。
 */

/** 本教师域内 kind='lesson' 讲义 id 集（含软删：判定不随 deletedAt 漂移） */
function lessonLectureIds(db: Db, teacherId: string): Set<string> {
  return new Set(
    db
      .select({ id: lectures.id })
      .from(lectures)
      .where(
        and(eq(lectures.teacherId, teacherId), eq(lectures.kind, "lesson")),
      )
      .all()
      .map((row) => row.id),
  );
}

/**
 * 从已加载的行派生嵌入单元 id 集（调用方已读全 units/lectures 时用它，
 * 避免为判定再查一次库）。
 */
export function embeddedUnitIdsFrom(
  unitRows: Iterable<{ id: string; lectureId: string | null }>,
  lessonLectureIdSet: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const row of unitRows) {
    if (row.lectureId !== null && lessonLectureIdSet.has(row.lectureId)) {
      ids.add(row.id);
    }
  }
  return ids;
}

/** 本教师域内嵌入单元 id 集（未加载资源行时的直接查询） */
export function lessonEmbeddedUnitIds(db: Db, teacherId: string): Set<string> {
  return embeddedUnitIdsFrom(
    db
      .select({ id: units.id, lectureId: units.lectureId })
      .from(units)
      .where(eq(units.teacherId, teacherId))
      .all(),
    lessonLectureIds(db, teacherId),
  );
}

/** 课程目录条目是否指向嵌入单元（教师端各读取面统一用它过滤） */
export function isEmbeddedUnitItem(
  item: { readonly kind: string; readonly refId: string | null },
  embeddedUnitIds: ReadonlySet<string>,
): boolean {
  return (
    item.kind === "unit" &&
    item.refId !== null &&
    embeddedUnitIds.has(item.refId)
  );
}

/**
 * 多 live 嵌入单元择主的候选形态（开卷侧由 lesson-service 从 units/questions
 * 的 live 行组装）。事故背景（演示站 2026-10-28）：教师重导改名单元会在同一
 * 讲练页留下新旧两个 live 嵌入单元，读侧按 order ASC 取最前会选中与讲义
 * md 题槽对不上的旧单元（开卷冻结后题目全堆页尾）。
 */
export interface CanonicalEmbeddedUnitCandidate {
  /** 单元 id（units.id） */
  readonly id: string;
  /** 单元主题（units.topic；未标注为 null） */
  readonly topic: string | null;
  /** 课程内排序（units.order，小在前） */
  readonly order: number;
  /** 最近更新时间（units.updatedAt，UTC ISO 字符串——同格式字符串比较即时间序） */
  readonly updatedAt: string;
  /** 该单元当前 live（未软删）题目 id 集 */
  readonly liveQuestionIds: ReadonlySet<string>;
}

/**
 * 择主逐项比较：交集大者胜 → updatedAt 字符串降序（新者优先）→ order 升序
 * → id 升序。返回 candidate 是否顶替 incumbent（完全同名 id 不可能，末项必分胜负）。
 */
function supersedes(
  candidate: CanonicalEmbeddedUnitCandidate,
  candidateScore: number,
  incumbent: CanonicalEmbeddedUnitCandidate,
  incumbentScore: number,
): boolean {
  if (candidateScore !== incumbentScore) return candidateScore > incumbentScore;
  if (candidate.updatedAt !== incumbent.updatedAt) {
    return candidate.updatedAt > incumbent.updatedAt;
  }
  if (candidate.order !== incumbent.order)
    return candidate.order < incumbent.order;
  return candidate.id < incumbent.id;
}

/**
 * 多 live 嵌入单元择主（纯函数，开卷侧择主与 backfill 存量去重同一出处）：
 * 取 liveQuestionIds ∩ slotQuestionIds 交集最大者（与讲义 md 题槽一致性优先）；
 * 平局或全零 → updatedAt 字符串降序（新者优先）→ order 升序 → id 升序。
 * 空数组 → undefined；单候选恒返回它（交集为零也返回——md 缺注入 id 的
 * 兜底场景不能选成 undefined）。
 */
export function canonicalEmbeddedUnitOf<
  T extends CanonicalEmbeddedUnitCandidate,
>(
  candidates: readonly T[],
  slotQuestionIds: ReadonlySet<string>,
): T | undefined {
  let incumbent: T | undefined;
  let incumbentScore = 0;
  for (const candidate of candidates) {
    let score = 0;
    for (const id of candidate.liveQuestionIds) {
      if (slotQuestionIds.has(id)) score += 1;
    }
    if (
      incumbent === undefined ||
      supersedes(candidate, score, incumbent, incumbentScore)
    ) {
      incumbent = candidate;
      incumbentScore = score;
    }
  }
  return incumbent;
}
