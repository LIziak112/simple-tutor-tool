import { listDirectives } from "@tutor/contract";

/**
 * 近似名建议（T1.5）：给 UNKNOWN_DIRECTIVE / INVALID_DIRECTIVE_ATTRS 的 message
 * 附「你是不是想用 :::xxx？」，供「复制错误给 AI」闭环一眼看懂怎么改。
 * 依据：docs/技术架构与实施方案.md §5.1.1(3)（未知指令 warning + 近似名建议）。
 *
 * 设计约定：自实现小型编辑距离函数，零新增依赖；阈值按名字长度放宽
 * （短名字容忍 2，长名字容忍 3），无相近候选时返回 undefined（建议查规范文档）。
 */

/** 经典 Levenshtein 编辑距离（滚动数组；指令名/属性名都很短） */
export function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        (previous[j] ?? 0) + 1, // 删除
        (current[j - 1] ?? 0) + 1, // 插入
        substitution, // 替换
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** 近似名建议允许的最大编辑距离：≤4 字符容忍 2，更长容忍 3 */
export function maxSuggestionDistance(name: string): number {
  return name.length <= 4 ? 2 : 3;
}

/**
 * 从注册表全部主名 + 别名中找编辑距离最小的候选。
 * 距离并列时取更短者（steps/step 这类前缀族优先短名之外的同距短名）；
 * 超过阈值返回 undefined（不硬凑建议）。
 */
export function suggestDirectiveName(input: string): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const definition of listDirectives()) {
    for (const candidate of [definition.name, ...(definition.aliases ?? [])]) {
      const distance = levenshtein(input, candidate);
      if (
        best === undefined ||
        distance < best.distance ||
        (distance === best.distance && candidate.length < best.name.length)
      ) {
        best = { name: candidate, distance };
      }
    }
  }
  if (best !== undefined && best.distance <= maxSuggestionDistance(input)) {
    return best.name;
  }
  return undefined;
}

/** 属性名近似建议（与指令名同一套阈值；known 为该指令的已知属性名列表） */
export function suggestAttrKey(
  input: string,
  known: readonly string[],
): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of known) {
    const distance = levenshtein(input, candidate);
    if (
      best === undefined ||
      distance < best.distance ||
      (distance === best.distance && candidate.length < best.name.length)
    ) {
      best = { name: candidate, distance };
    }
  }
  if (best !== undefined && best.distance <= maxSuggestionDistance(input)) {
    return best.name;
  }
  return undefined;
}
