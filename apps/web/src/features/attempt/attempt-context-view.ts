import type {
  AttemptContextData,
  AttemptContextGroup,
  AttemptContextMaterial,
  MaterialRef,
} from "@tutor/contract";

/**
 * 共用数据解释（TT-08a / QM-08 验收行）：/attempts/:id/context 冻结投影 →
 * 单元组段模型的**单一出处**。作答视图（AttemptSession）与结果回看
 * （AttemptResultView）都经本函数把题目序解释成「独立题段 / 题组段」——
 * 不在两个视图各写一遍组归属与材料解析（不三写）；教师预览走 markdown
 * 管线渲染源文，材料/组投影语义同源于契约（materialPublicSchema /
 * questionGroupPublicSchema），与本模型消费同一冻结白名单键集。
 *
 * 解释规则（与 lint「组是单元题序子序列」的既有口径对齐）：
 * - **材料多版本分别保留（QM-15 细项 4）**：wrong 重练可把不同历史卷的同
 *   名材料双版本冻进一卷（tt-07a 去重键含 (kind, id, version)）；引用只携
 *   带 id、无按版本绑定通道，展示口径为「每 id 的全部冻结版本都保留、按
 *   版本升序排列」——两版都是冻结内容，绝不按 materialId 取最新覆盖旧版
 *   （设计方案 §5.3），消费方键用 materialVersionKey(id|version)。**组仍每
 *   id 一段取最高冻结版**：组是结构键（成员区间/组头归属），材料才是学生
 *   阅读的内容主体；多版本材料面板由 materialVersionNotesOf 逐版标注。
 * - **组块在首位卷内成员处出现一次**：段内题目 = 首尾成员之间的全部卷内
 *   题（成员区间内的非成员题随段渲染，真实语料成员连续，此规则保证一组
 *   一块、不因 lint 允许的子序列空洞重开组块）。
 * - **一题多组（数据异常防御）**：按条目稳定序（id 升序）首个组收编，
 *   判定确定。
 * - **组材料按引用序解析**（同 id 各版本按版本升序依次收进）；引用缺快照
 *   条目（闭包保证外的坏数据）→ 跳过该材料不崩溃；组仍渲染（materials
 *   可为空数组）。
 * - 卷外成员（wrong 剔除/跨单元）不进段；零卷内成员的组不渲染。
 */

/** 独立题段（无组归属的连续题目） */
export interface SoloContextSegment {
  readonly kind: "solo";
  readonly questionIds: readonly string[];
}

/** 题组段：组块 + 解析后的共享材料 + 本卷内成员序 */
export interface GroupContextSegment {
  readonly kind: "group";
  readonly group: AttemptContextGroup;
  readonly materials: readonly AttemptContextMaterial[];
  readonly questionIds: readonly string[];
}

export type UnitContextSegment = SoloContextSegment | GroupContextSegment;

/** 同 id 多版本 → 最高 sourceVersion（稳定排序后的末条；输入可为空） */
function latestById<T extends { id: string; sourceVersion: number }>(
  entries: readonly T[],
): Map<string, T> {
  const byId = new Map<string, T>();
  for (const entry of entries) {
    const prior = byId.get(entry.id);
    if (prior === undefined || entry.sourceVersion > prior.sourceVersion)
      byId.set(entry.id, entry);
  }
  return byId;
}

/**
 * 同 id 的全部版本按 sourceVersion 升序（QM-15 细项 4：多版本分别保留，
 * 不按 materialId 覆盖；缺条目 id 为空数组由调用方跳过）
 */
function versionsById<T extends { id: string; sourceVersion: number }>(
  entries: readonly T[],
): Map<string, T[]> {
  const byId = new Map<string, T[]>();
  for (const entry of entries) {
    const list = byId.get(entry.id) ?? [];
    list.push(entry);
    byId.set(entry.id, list);
  }
  for (const list of byId.values()) {
    list.sort((a, b) => a.sourceVersion - b.sourceVersion);
  }
  return byId;
}

/**
 * 单元题目序 → 组段列表。questionIds 是**本单元在本卷内**的题目 id 序列
 * （作答/结果两视图都持有序列，不查 live）。context 为 undefined（legacy
 * 卷未请求/未冻结）时全部 solo，渲染零变化。
 *
 * questionRefs（P1-2）：题级 ::ref 引用映射（学生题目投影的 materialRefs，
 * 可选）——组段材料并入**本段成员**的题级引用（组引用先、题级后，按材料
 * id 去重），与服务端 frozenMaterialsForQuestion 组∪题级闭包同源口径；
 * 不传时既有组材料解释零变化。solo 题的题级材料经 questionMaterialsOf
 * 单独解析（无组归属，不进组段）。
 */
export function groupSegmentsOfUnit(
  context: AttemptContextData | undefined,
  questionIds: readonly string[],
  questionRefs?: ReadonlyMap<string, readonly MaterialRef[]>,
): readonly UnitContextSegment[] {
  if (context === undefined || questionIds.length === 0) {
    return questionIds.length === 0 ? [] : [{ kind: "solo", questionIds }];
  }
  // 材料按 id 收全版本（QM-15：不覆盖）；组仍每 id 取最高冻结版（结构键）
  const materialsById = versionsById(context.materials);
  // 组 → 卷内成员区间（首/尾成员下标；按 id 稳定序，重叠区间首个组收编）
  const indexById = new Map(questionIds.map((id, i) => [id, i] as const));
  const groups = [...latestById(context.groups).values()]
    .map((group) => {
      const indexes = group.questionIds
        .map((id) => indexById.get(id))
        .filter((i): i is number => i !== undefined);
      return indexes.length === 0
        ? null
        : { group, first: Math.min(...indexes), last: Math.max(...indexes) };
    })
    .filter(
      (
        span,
      ): span is { group: AttemptContextGroup; first: number; last: number } =>
        span !== null,
    )
    .sort((a, b) => a.group.id.localeCompare(b.group.id));
  // 每题归属：区间包含该题的组里按 id 序首个；无区间 → solo
  const ownerOf: Array<AttemptContextGroup | null> = questionIds.map(
    () => null,
  );
  for (const span of groups) {
    for (let i = span.first; i <= span.last; i += 1) {
      if (ownerOf[i] === null) ownerOf[i] = span.group;
    }
  }

  const segments: UnitContextSegment[] = [];
  let i = 0;
  while (i < questionIds.length) {
    const owner = ownerOf[i] ?? null;
    if (owner === null) {
      // 连续 solo 题（到下一个有归属的题为止）
      let end = i;
      while (end < questionIds.length && ownerOf[end] === null) end += 1;
      segments.push({ kind: "solo", questionIds: questionIds.slice(i, end) });
      i = end;
      continue;
    }
    // 连续同组题归一段（区间边界一致时整段即区间；防御重叠时按归属数组切分）
    let end = i;
    while (end < questionIds.length && ownerOf[end]?.id === owner.id) end += 1;
    const memberIds = questionIds.slice(i, end);
    // 组∪题级闭包（P1-2）：成员题级引用按卷内题序并入（组引用先、题级后）
    const unionRefs: readonly MaterialRef[] =
      questionRefs === undefined
        ? owner.materialRefs
        : [
            ...owner.materialRefs,
            ...memberIds.flatMap((id) => questionRefs.get(id) ?? []),
          ];
    segments.push({
      kind: "group",
      group: owner,
      materials: resolveRefs(materialsById, unionRefs),
      questionIds: memberIds,
    });
    i = end;
  }
  return segments;
}

/** 组材料引用 → 冻结材料实例（引用序按 id 去重；同 id 多版本全收、版本
 *  升序——QM-15 细项 4；缺条目跳过） */
function resolveRefs(
  materialsById: ReadonlyMap<string, readonly AttemptContextMaterial[]>,
  refs: readonly MaterialRef[],
): readonly AttemptContextMaterial[] {
  const resolved: AttemptContextMaterial[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.material)) continue;
    seen.add(ref.material);
    resolved.push(...(materialsById.get(ref.material) ?? []));
  }
  return resolved;
}

/**
 * 题级 ::ref 材料 → 冻结材料实例（P1-2 单源）：solo 题（无组归属）的材料
 * 入口数据解释——引用序按 id 去重、同 id 多版本全收升序、缺快照条目跳过，
 * 与组段材料同一解析纪律。question 携带学生题目投影的 materialRefs（公开
 * 白名单内容，2026-10-25 审查 P2-2 起随题下发）；无引用或无上下文 → 空
 * （不渲染锚点，旧卷零变化）。
 */
export function questionMaterialsOf(
  context: AttemptContextData | undefined,
  question: { readonly materialRefs?: readonly MaterialRef[] | undefined },
): readonly AttemptContextMaterial[] {
  const refs = question.materialRefs;
  if (context === undefined || refs === undefined || refs.length === 0) {
    return [];
  }
  return resolveRefs(versionsById(context.materials), refs);
}
