/** 师生目录共用遍历；路径只由调用者已经获准读取的节点构成。 */
export interface CatalogNode {
  id: string;
  parentId?: string | null | undefined;
  kind: "section" | "lecture" | "unit";
  title: string;
}
export function catalogTreeRows<T extends CatalogNode>(
  items: readonly T[],
): { item: T; depth: number; path: string; ancestors: string[] }[] {
  const children = new Map<string | null, T[]>();
  let legacyParent: string | null = null;
  for (const item of items) {
    const key =
      item.parentId === undefined
        ? item.kind === "section"
          ? null
          : legacyParent
        : item.parentId;
    if (item.kind === "section") legacyParent = item.id;
    children.set(key, [...(children.get(key) ?? []), item]);
  }
  const result: {
    item: T;
    depth: number;
    path: string;
    ancestors: string[];
  }[] = [];
  const visited = new Set<string>();
  function visit(
    parentId: string | null,
    ancestors: string[],
    names: string[],
  ) {
    for (const item of children.get(parentId) ?? []) {
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      result.push({
        item,
        depth: ancestors.length,
        path: [...names, item.title].join(" / "),
        ancestors,
      });
      if (item.kind === "section")
        visit(item.id, [...ancestors, item.id], [...names, item.title]);
    }
  }
  visit(null, [], []);
  return result;
}
