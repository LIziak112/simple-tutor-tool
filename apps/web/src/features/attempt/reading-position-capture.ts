export type ReadingPosition = { questionId: string; offset: number };
type Cards = ReadonlyMap<string, HTMLElement>;
type Card = [string, HTMLElement];
type Match = { index: number; top: number };

const versions = new WeakMap<Cards, number>();

/** 题卡注册变动时让下一帧重新核对顺序，无需触发 React 渲染。 */
export function registerReadingCard(
  cards: Map<string, HTMLElement>,
  id: string,
  element: HTMLElement | null,
): void {
  if ((cards.get(id) ?? null) === element) return;
  if (element === null) cards.delete(id);
  else cards.set(id, element);
  versions.set(cards, (versions.get(cards) ?? 0) + 1);
}

function ordered(first: DOMRectReadOnly, next: DOMRectReadOnly): boolean {
  return first.top <= next.top && first.bottom <= next.bottom;
}

function nearest(
  current: Match | null,
  candidate: Match,
  target: number,
): Match {
  if (current === null) return candidate;
  const currentDistance = Math.abs(current.top - target);
  const nextDistance = Math.abs(candidate.top - target);
  return nextDistance < currentDistance ||
    (nextDistance === currentDistance && candidate.index < current.index)
    ? candidate
    : current;
}

function nearby(
  rows: readonly Card[],
  anchor: number,
  header: number,
  bottom: number,
): Match | null {
  const bounds = (index: number) => rows[index]?.[1].getBoundingClientRect();
  let index = anchor;
  let rect = bounds(index);
  const visible = (rect: DOMRectReadOnly) =>
    rect.bottom > header && rect.top < bottom;
  // 大幅滚动或空白材料区内改走全量定位，避免在两个边界之间来回搜索。
  for (let steps = 0; rect && !visible(rect) && steps < 8; steps++) {
    index += rect.bottom <= header ? 1 : -1;
    rect = bounds(index);
  }
  if (!rect || !visible(rect)) return null;

  let best = { index, top: rect.top };
  for (const step of [-1, 1]) {
    let previous = rect;
    for (let i = index + step; i >= 0 && i < rows.length; i += step) {
      const next = bounds(i);
      if (
        !next ||
        !(step < 0 ? ordered(next, previous) : ordered(previous, next))
      )
        return null;
      if (!visible(next)) break;
      best = nearest(best, { index: i, top: next.top }, header + 12);
      previous = next;
    }
  }
  return best;
}

export function createReadingPositionCapture() {
  let anchor: {
    cards: Cards;
    rows: Card[];
    version: number;
    index: number;
  } | null = null;
  return (
    cards: Cards,
    header: number,
    bottom: number,
    follow: boolean,
  ): ReadingPosition | null => {
    const version = versions.get(cards) ?? 0;
    if (
      follow &&
      anchor?.cards === cards &&
      anchor.version === version &&
      anchor.rows.length === cards.size
    ) {
      const match = nearby(anchor.rows, anchor.index, header, bottom);
      const row = match === null ? undefined : anchor.rows[match.index];
      if (match && row && cards.get(row[0]) === row[1]) {
        anchor.index = match.index;
        return { questionId: row[0], offset: match.top - header };
      }
    }

    const rows = [...cards];
    let best: Match | null = null;
    let previous: DOMRectReadOnly | null = null;
    let isOrdered = true;
    for (const [index, [, element]] of rows.entries()) {
      const rect = element.getBoundingClientRect();
      if (previous !== null && !ordered(previous, rect)) isOrdered = false;
      previous = rect;
      if (rect.bottom <= header || rect.top >= bottom) continue;
      best = nearest(best, { index, top: rect.top }, header + 12);
    }
    anchor =
      isOrdered && best !== null
        ? { cards, rows, version, index: best.index }
        : null;
    const row = best === null ? undefined : rows[best.index];
    return row && best
      ? { questionId: row[0], offset: best.top - header }
      : null;
  };
}
