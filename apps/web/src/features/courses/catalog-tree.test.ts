import { describe, expect, it } from "vitest";
import { catalogTreeRows } from "./catalog-tree";

describe("课程树", () => {
  it("保留嵌套路径和同级顺序，不把根目录内容归入前一个文件夹", () => {
    const rows = catalogTreeRows([
      { id: "a", kind: "section", title: "章" },
      { id: "c", parentId: "b", kind: "lecture", title: "讲义" },
      { id: "b", parentId: "a", kind: "section", title: "节" },
      { id: "d", parentId: null, kind: "unit", title: "根目录练习" },
    ]);
    expect(rows.map((row) => row.item.id)).toEqual(["a", "b", "c", "d"]);
    expect(rows[2]).toMatchObject({
      depth: 2,
      path: "章 / 节 / 讲义",
      ancestors: ["a", "b"],
    });
    expect(rows[3]?.ancestors).toEqual([]);
  });
});
