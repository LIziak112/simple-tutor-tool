import type { AttemptContextMaterial } from "@tutor/contract";
import { useMemo } from "react";
import {
  type GroupContextSegment,
  groupSegmentsOfUnit,
  questionMaterialsOf,
} from "@/features/attempt/attempt-context-view";
import { useAttemptContext } from "@/features/attempt/attempt-queries";
import type { lessonQuestionOrder } from "./lesson-question-order";
/**
 * QM-14 组段呈现：冻结上下文（/attempts/:id/context）经 groupSegmentsOfUnit
 * （数据解释单源，与作答/结果视图同一实现）解释成组段——组头+共享材料在
 * **首个成员**题卡之前渲染一次（LessonGroupBlock 只承担讲练单列排版）。
 * P1-2：solo 题的题级 ::ref 材料经 questionMaterialsOf 解析，随题卡之前
 * 自然阅读（LessonQuestionMaterials）；组段材料并入成员题级引用（组∪题级
 * 单源）。context 未到位/为空（legacy 卷或旧部署）→ 空映射，渲染零变化；
 * 失败非阻断（题面渲染不依赖本载荷，页面层就地提示 + 重试）。
 */
export function useLessonGroupAnchors(
  attemptId: string,
  order: ReturnType<typeof lessonQuestionOrder>,
): {
  anchors: ReadonlyMap<string, GroupContextSegment>;
  soloMaterials: ReadonlyMap<string, readonly AttemptContextMaterial[]>;
  contextError: string | null;
  contextRetry: () => void;
  contextFetching: boolean;
} {
  const contextQuery = useAttemptContext(attemptId);
  const [anchors, soloMaterials] = useMemo(() => {
    if (contextQuery.data === undefined)
      return [EMPTY_ANCHORS, EMPTY_SOLO_MATERIALS] as const;
    const map = new Map<string, GroupContextSegment>();
    const solo = new Map<string, readonly AttemptContextMaterial[]>();
    // P1-2：题级引用映射（学生题目投影携带）——组段并集 + solo 块共用
    const questionRefs = new Map<
      string,
      readonly { readonly material: string }[]
    >([]);
    for (const slot of order.ordered) {
      const refs = slot.question.materialRefs;
      if (refs !== undefined && refs.length > 0)
        questionRefs.set(slot.question.id, refs);
    }
    for (const segment of groupSegmentsOfUnit(
      contextQuery.data,
      order.ordered.map((slot) => slot.question.id),
      questionRefs,
    )) {
      if (segment.kind === "group") {
        const first = segment.questionIds[0];
        if (first !== undefined) map.set(first, segment);
        continue;
      }
      for (const questionId of segment.questionIds) {
        const slot = order.byId.get(questionId);
        if (slot === undefined) continue;
        const materials = questionMaterialsOf(contextQuery.data, slot.question);
        if (materials.length > 0) solo.set(questionId, materials);
      }
    }
    return [map, solo] as const;
  }, [contextQuery.data, order]);
  return {
    anchors,
    soloMaterials,
    // 固定文案（不透出 error.message：网络层异常是技术信息，如 fetch failed）
    contextError: contextQuery.isError
      ? "共享材料加载失败，不影响作答题目。"
      : null,
    contextRetry: () => void contextQuery.refetch(),
    contextFetching: contextQuery.isFetching,
  };
}

/** 空题级材料映射（模块级稳定引用：无 context 时 useMemo 返回同一实例） */
const EMPTY_SOLO_MATERIALS: ReadonlyMap<
  string,
  readonly AttemptContextMaterial[]
> = new Map();

/** 空锚点映射（模块级稳定引用：无 context 时 useMemo 返回同一实例） */
const EMPTY_ANCHORS: ReadonlyMap<string, GroupContextSegment> = new Map();
