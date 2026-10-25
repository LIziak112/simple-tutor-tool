/**
 * 上传前预检的「就地修复」纯函数测试（圈画审查 P0-1，失败测试先行）：
 * 修复只做无损可推断的修正（夹紧坐标/丢非法点/丢坏笔/补默认值），
 * 结构性损坏（version 错、无 strokes）返回 null 交回服务端裁决。
 */
import { describe, expect, it } from "vitest";
import { docOf, stroke } from "./note-fixtures.ts";
import { repairNoteDoc } from "./note-doc-repair.ts";

const validDoc = () => docOf([stroke([[10, 20], [40, 60]])]);

describe("repairNoteDoc：可修复的坏数据", () => {
  it("合法文档返回物化后的等价文档（不改动内容）", () => {
    const doc = validDoc();
    const repaired = repairNoteDoc(doc);
    expect(repaired).not.toBeNull();
    expect(repaired?.ink.strokes.length).toBe(1);
    expect(repaired?.ink.strokes[0]?.points.length).toBe(2);
  });

  it("越界坐标被夹紧到合法域：x→[0,1000]、y→[0,3000]、p→[0,1]、t≥0", () => {
    const repaired = repairNoteDoc({
      ...validDoc(),
      ink: {
        width: 1000,
        strokes: [
          stroke([
            [1200, -5],
            [Infinity, 3005],
          ]),
        ],
      },
    });
    expect(repaired).not.toBeNull();
    // Infinity 点被丢弃，x=1200 夹紧 1000、y=-5 夹紧 0
    const points = repaired?.ink.strokes[0]?.points ?? [];
    expect(points.length).toBe(1);
    expect(points[0]?.x).toBe(1000);
    expect(points[0]?.y).toBe(0);
    expect(repaired && repairNoteDoc(repaired)).not.toBeNull();
  });

  it("NaN/Infinity 点被丢弃；修复产物整体通过契约 schema", () => {
    const bad = validDoc();
    bad.ink.strokes[0]!.points[0] = { x: Number.NaN, y: 20, p: 0.5, t: 0 };
    const repaired = repairNoteDoc(bad);
    expect(repaired).not.toBeNull();
    expect(repaired?.ink.strokes[0]?.points.length).toBe(1);
  });

  it("weight≤0 / 非法 tool / 空 color 的笔整笔丢弃；点全被滤掉的笔丢弃", () => {
    const repaired = repairNoteDoc({
      ...validDoc(),
      ink: {
        width: 1000,
        strokes: [
          { ...stroke([[1, 1]]), weight: 0 },
          { ...stroke([[2, 2]]), tool: "chisel" as "pen" },
          { ...stroke([[3, 3]]), color: "" },
          {
            ...stroke([[4, 4]]),
            points: [
              { x: Number.NaN, y: Number.NaN, p: 0.5, t: 0 },
            ],
          },
          stroke([[5, 5]]),
        ],
      },
    });
    expect(repaired).not.toBeNull();
    expect(repaired?.ink.strokes.length).toBe(1);
  });

  it("纸张高越界夹紧、非法背景回默认、宽度恒 1000", () => {
    const repaired = repairNoteDoc({
      ...validDoc(),
      version: 1,
      paperHeightLogical: 9999,
      background: "dotted" as "grid",
      ink: { width: 999, strokes: [stroke([[1, 1]])] },
    });
    expect(repaired?.paperHeightLogical).toBe(3000);
    expect(repaired?.background).toBe("grid");
    expect(repaired?.ink.width).toBe(1000);
  });

  it("单笔超点数截断到契约上限", () => {
    const points = Array.from({ length: 2500 }, (_, i) => ({
      x: (i % 1000) + 0.5,
      y: (i % 2000) + 0.5,
      p: 0.5,
      t: i,
    }));
    const repaired = repairNoteDoc({
      ...validDoc(),
      ink: { width: 1000, strokes: [{ ...stroke([[1, 1]]), points }] },
    });
    expect(repaired).not.toBeNull();
    expect(repaired?.ink.strokes[0]?.points.length).toBe(2000);
  });
});

describe("repairNoteDoc：不可修复返回 null", () => {
  it("version 不是 1 → null", () => {
    expect(repairNoteDoc({ ...validDoc(), version: 2 })).toBeNull();
  });

  it("ink/strokes 结构烂 → null", () => {
    expect(repairNoteDoc({ ...validDoc(), ink: undefined })).toBeNull();
    expect(
      repairNoteDoc({ ...validDoc(), ink: { width: 1000 } as never }),
    ).toBeNull();
  });
});
