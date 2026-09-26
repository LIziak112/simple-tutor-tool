import type { ContentTree, ReorderKind, ReorderRequest } from "@tutor/contract";

/**
 * 拖拽排序的纯逻辑（T1.12）：数组移动、内容树乐观更新、reorder 请求 payload 构造。
 * 与 dnd-kit 解耦（组件只负责拖拽手势，顺序计算与回滚都在这里），
 * 因此可用纯单测覆盖（含 reorder payload 构造）。
 */

/** 数组元素移动：把 from 下标的元素移到 to（等价 @dnd-kit/sortable 的 arrayMove） */
export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  const copy = [...items];
  const moved = copy.splice(from, 1)[0];
  if (moved === undefined) return copy;
  copy.splice(to, 0, moved);
  return copy;
}

/** 按 orderedIds 生成新顺序：ids 命中的按下标排，未提到的保持相对顺序排在末尾（防御） */
export function orderByIds<T>(
  items: readonly T[],
  orderedIds: readonly string[],
  idOf: (item: T) => string,
): T[] {
  const indexById = new Map(
    orderedIds.map((id, index) => [id, index] as const),
  );
  const hit: T[] = [];
  const miss: T[] = [];
  for (const item of items) {
    const index = indexById.get(idOf(item));
    if (index === undefined) miss.push(item);
    else hit.push(item);
  }
  hit.sort(
    (a, b) => (indexById.get(idOf(a)) ?? 0) - (indexById.get(idOf(b)) ?? 0),
  );
  return [...hit, ...miss];
}

/** reorder 作用域：question → 所属单元；lecture/unit → 所属课程；course → 顶层 */
export type ReorderScope =
  | { kind: "question"; unitId: string }
  | { kind: "lecture"; courseId: string }
  | { kind: "unit"; courseId: string }
  | { kind: "course" };

/**
 * 把新顺序写进内容树（乐观更新用，不请求网络）。
 * 返回新树对象（原树不变）；scope 决定重排哪一层。
 */
export function applyReorder(
  tree: ContentTree,
  scope: ReorderScope,
  orderedIds: readonly string[],
): ContentTree {
  switch (scope.kind) {
    case "course":
      return {
        courses: orderByIds(tree.courses, orderedIds, (course) => course.id),
      };
    case "lecture":
      return mapCourse(tree, scope.courseId, (course) => ({
        ...course,
        lectures: orderByIds(course.lectures, orderedIds, (l) => l.id),
      }));
    case "unit":
      return mapCourse(tree, scope.courseId, (course) => ({
        ...course,
        units: orderByIds(course.units, orderedIds, (u) => u.id),
      }));
    case "question":
      return {
        courses: tree.courses.map((course) => ({
          ...course,
          units: course.units.map((unit) =>
            unit.id === scope.unitId
              ? {
                  ...unit,
                  questions: orderByIds(
                    unit.questions,
                    orderedIds,
                    (q) => q.id,
                  ),
                }
              : unit,
          ),
        })),
      };
  }
}

function mapCourse(
  tree: ContentTree,
  courseId: string,
  patch: (
    course: ContentTree["courses"][number],
  ) => ContentTree["courses"][number],
): ContentTree {
  return {
    courses: tree.courses.map((course) =>
      course.id === courseId ? patch(course) : course,
    ),
  };
}

/** 构造 POST /api/teacher/reorder 请求体（ids 为该作用域的完整新顺序） */
export function buildReorderPayload(
  kind: ReorderKind,
  ids: readonly string[],
): ReorderRequest {
  return { kind, ids: [...ids] };
}
