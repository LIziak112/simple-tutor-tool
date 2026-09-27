import { describe, expect, it, vi } from "vitest";
import { buildAtramentDoc, emptyAtramentDoc, parseAtramentDoc } from "./doc.ts";
import { InkStore } from "./history.ts";
import type { InkStroke } from "./types.ts";

/** 构造一笔测试笔画（坐标已是逻辑单位） */
function stroke(points: Array<[number, number]>): InkStroke {
  return {
    tool: "pen",
    color: "#1f2328",
    weight: 4,
    points: points.map(([x, y], i) => ({ x, y, p: 0.5, t: i * 16 })),
  };
}

/** 撤销/重做测试（验收项：含擦除的撤销） */
describe("InkStore 撤销/重做", () => {
  it("新增笔画：undo 移除、redo 恢复", () => {
    const store = new InkStore();
    store.commitAdd([
      stroke([
        [10, 10],
        [20, 20],
      ]),
    ]);
    store.commitAdd([stroke([[30, 30]])]);
    expect(store.getStrokes()).toHaveLength(2);

    expect(store.undo()).toBe(true);
    expect(store.getStrokes()).toHaveLength(1);

    expect(store.undo()).toBe(true);
    expect(store.getStrokes()).toHaveLength(0);

    expect(store.redo()).toBe(true);
    expect(store.redo()).toBe(true);
    expect(store.getStrokes()).toHaveLength(2);
    // 内容完整（深比较）
    expect(store.getStrokes()).toEqual([
      stroke([
        [10, 10],
        [20, 20],
      ]),
      stroke([[30, 30]]),
    ]);
  });

  it("空栈 undo/redo 是 no-op 且不通知", () => {
    const store = new InkStore();
    const cb = vi.fn();
    store.subscribe(cb);
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it("整笔橡皮：一次拖动删多笔合并为一个历史条目", () => {
    const store = new InkStore();
    store.commitAdd([stroke([[10, 10]])]);
    store.commitAdd([stroke([[50, 50]])]);
    store.commitAdd([stroke([[90, 90]])]);

    // 橡皮一次拖动先后命中 b 和 a（下标 1、0）
    store.commitErase([1]);
    store.commitErase([0]);
    expect(store.getStrokes()).toEqual([stroke([[90, 90]])]);
    // 两次 commit 产生两个条目：分别撤销验证
    store.undo();
    store.undo();
    expect(store.getStrokes()).toHaveLength(3);
  });

  it("擦除后撤销恢复被擦笔画（原位置原顺序），重做再擦除", () => {
    const store = new InkStore();
    const a = stroke([
      [10, 10],
      [11, 11],
    ]);
    const b = stroke([
      [50, 50],
      [51, 51],
    ]);
    const c = stroke([
      [90, 90],
      [91, 91],
    ]);
    store.commitAdd([a]);
    store.commitAdd([b]);
    store.commitAdd([c]);

    // 一次拖动同时命中 a、c → 一个 remove 条目
    store.commitErase([0, 2]);
    expect(store.getStrokes()).toEqual([b]);

    // 撤销：a、c 按原下标 0、2 插回
    expect(store.undo()).toBe(true);
    expect(store.getStrokes()).toEqual([a, b, c]);

    // 重做：再次删除 a、c
    expect(store.redo()).toBe(true);
    expect(store.getStrokes()).toEqual([b]);

    // 再撤销一次后继续写：重做栈应被清空
    store.undo(); // 回到 [a,b,c]
    store.commitAdd([stroke([[200, 200]])]);
    expect(store.redo()).toBe(false); // 新提交清空重做栈
    expect(store.getStrokes()).toEqual([a, b, c, stroke([[200, 200]])]);
  });

  it("清空：撤销恢复全部、重做再清空", () => {
    const store = new InkStore();
    store.commitAdd([stroke([[1, 1]]), stroke([[2, 2]])]);
    store.commitClear();
    expect(store.getStrokes()).toHaveLength(0);

    store.undo();
    expect(store.getStrokes()).toHaveLength(2);

    store.redo();
    expect(store.getStrokes()).toHaveLength(0);
  });

  it("replace（load）：撤销回到旧内容、重做回到新内容", () => {
    const store = new InkStore();
    store.commitAdd([stroke([[1, 1]])]);
    store.replace([stroke([[9, 9]])], 123456);
    expect(store.getStrokes()).toEqual([stroke([[9, 9]])]);
    expect(store.getUpdatedAt()).toBe(123456);

    store.undo();
    expect(store.getStrokes()).toEqual([stroke([[1, 1]])]);

    store.redo();
    expect(store.getStrokes()).toEqual([stroke([[9, 9]])]);
  });

  it("load 相同内容（load(getData()) 往返）不产生历史噪音", () => {
    const store = new InkStore();
    store.commitAdd([stroke([[1, 1]])]);
    store.replace(store.getStrokes(), 999); // 内容一致
    expect(store.getUpdatedAt()).toBe(999);
    // 撤销栈只有最初的 add 一条
    store.undo();
    expect(store.getStrokes()).toHaveLength(0);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(true); // 只能重做 add
  });

  it("对空画布 commitClear 是 no-op 且不产生历史", () => {
    const store = new InkStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.commitClear();
    expect(cb).not.toHaveBeenCalled();
    expect(store.canUndo()).toBe(false);
  });
});

describe("InkStore 变更通知（onChange 次数与时机）", () => {
  it("每次 commit/undo/redo 恰好触发一次；取消订阅后不再触发", () => {
    const store = new InkStore();
    const cb = vi.fn();
    const off = store.subscribe(cb);

    store.commitAdd([stroke([[1, 1]])]);
    expect(cb).toHaveBeenCalledTimes(1);

    store.undo();
    expect(cb).toHaveBeenCalledTimes(2);

    store.redo();
    expect(cb).toHaveBeenCalledTimes(3);

    store.commitClear();
    expect(cb).toHaveBeenCalledTimes(4);

    off();
    store.commitAdd([stroke([[2, 2]])]);
    expect(cb).toHaveBeenCalledTimes(4);
  });

  it("通知携带最新快照；快照与后续操作隔离（不可变）", () => {
    const store = new InkStore();
    let seen: readonly InkStroke[] = [];
    store.subscribe((s) => {
      seen = s;
    });
    store.commitAdd([stroke([[1, 1]])]);
    expect(seen).toHaveLength(1);
    // 持有的快照不被后续修改污染
    store.commitAdd([stroke([[2, 2]])]);
    expect(seen).toHaveLength(2);
    const held = store.getStrokes();
    store.commitAdd([stroke([[3, 3]])]);
    expect(held).toHaveLength(2);
  });
});

/** load(getData()) 往返一致（验收项，纯数据层层面） */
describe("InkDoc 往返一致", () => {
  it("store → getData → load → getData 深比较一致（含 updatedAt）", () => {
    const store = new InkStore();
    store.commitAdd([
      stroke([
        [10.5, 20.25],
        [100, 200.5],
        [500, 500],
      ]),
      {
        tool: "highlighter",
        color: "rgba(250, 204, 21, 0.45)",
        weight: 16,
        points: [{ x: 1, y: 2, p: 0.8, t: 0 }],
      },
    ]);
    const doc1 = buildAtramentDoc(store);

    const store2 = new InkStore();
    store2.replace(parseAtramentDoc(doc1), doc1.updatedAt);
    const doc2 = buildAtramentDoc(store2);

    expect(doc2).toEqual(doc1); // 深比较整个 InkDoc
  });

  it("空文档往返一致", () => {
    const empty = emptyAtramentDoc();
    const store = new InkStore();
    store.replace(parseAtramentDoc(empty), empty.updatedAt);
    expect(buildAtramentDoc(store).data).toEqual(empty.data);
  });

  it("engine 不匹配时 load 抛错（防两种引擎数据混用）", () => {
    const wrong = {
      engine: "excalidraw",
      version: 1,
      data: { scene: {} },
      updatedAt: 1,
    } as unknown as Parameters<typeof parseAtramentDoc>[0];
    expect(() => parseAtramentDoc(wrong)).toThrow(/引擎不匹配/);
  });
});
