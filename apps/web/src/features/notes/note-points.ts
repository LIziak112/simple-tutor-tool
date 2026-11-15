/**
 * 草稿全稿点数的维护（T6R.9 复审⑤）：书写热路径上不重扫全稿。
 *
 * 引擎每次变更都给全稿。只有「尾部追加」——原来的最后一笔还在原位（按笔画
 * id 认），后面多了几笔——在旧总数上累加新笔，并逐笔校验单笔上限。其余形态
 * 一律全量重算，不依赖累加的前提：撤销 / 重做 / 擦除 / 清空 / 等长替换
 * （复审⑫），以及笔数变多却不是追加的两种——局部擦除把一笔切成几段、撤销把
 * 擦掉的一笔放回原位。旧稿笔画没有 id，认不出是不是追加，也重算。
 *
 * 超限只告警不阻断：服务端 413 是预算权威（方案 §7「矢量超限保留本机」）。
 */
import {
  NOTE_MAX_POINTS_PER_STROKE,
  NOTE_MAX_TOTAL_POINTS,
} from "@tutor/contract";

interface CountedStroke {
  id?: string | undefined;
  points: readonly unknown[];
}

/** 全稿点数求和 */
export function countPoints(strokes: readonly CountedStroke[]): number {
  let total = 0;
  for (const stroke of strokes) total += stroke.points.length;
  return total;
}

/** next 是否只是在 prev 后面追加了几笔 */
function isTailAppend(
  prev: readonly CountedStroke[],
  next: readonly CountedStroke[],
): boolean {
  if (next.length <= prev.length) return false;
  const tail = prev.at(-1);
  if (tail === undefined) return true;
  return tail.id !== undefined && next[prev.length - 1]?.id === tail.id;
}

/**
 * 正文从 prev 换成 next 之后的全稿点数；prevTotal 是 prev 的点数。
 * 追加的一笔超过单笔上限时不计入（它过不了服务端校验，算进去只会让全稿预算
 * 的告警跟着误报）。
 */
export function totalPointsAfterWrite(
  prev: readonly CountedStroke[],
  next: readonly CountedStroke[],
  prevTotal: number,
): number {
  if (!isTailAppend(prev, next)) return countPoints(next);
  let total = prevTotal;
  for (let i = prev.length; i < next.length; i++) {
    const added = next[i];
    if (
      added === undefined ||
      added.points.length > NOTE_MAX_POINTS_PER_STROKE
    ) {
      console.warn("草稿新笔超单笔点数上限（保留本机，同步由服务端裁决）");
    } else {
      total += added.points.length;
    }
  }
  if (total > NOTE_MAX_TOTAL_POINTS) {
    console.warn("草稿累计点数超全稿预算（保留本机，同步由服务端裁决）");
  }
  return total;
}
