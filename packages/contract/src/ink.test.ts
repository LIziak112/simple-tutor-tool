import { describe, expect, it } from "vitest";
import {
  INK_LOGICAL_WIDTH,
  INK_MAX_UPLOAD_BYTES,
  inkAtramentDataSchema,
  inkDocSchema,
  inkErrorCodeSchema,
  inkExcalidrawDataSchema,
  inkFetchDataSchema,
  inkMetaSchema,
  inkStrokeSchema,
  inkUploadDataSchema,
  inkUploadOkSchema,
} from "./ink.ts";

/**
 * 手写笔迹契约自测（T2.8）：锁定 InkDoc 判别联合形状与上传/取回/元数据响应——
 * - atrament 文档：width 恒 1000、笔画字段齐全；坐标越界（y > 1000）合法
 *   （答题区向下延伸）；压力 0–1、时间戳非负；
 * - excalidraw 文档：scene.elements 是对象数组（内部不解释）；
 * - engine 判别：未知 engine / version、缺 data 拒绝；
 * - 上传回执与元数据形态；错误码集合（INK_TOO_LARGE 为 T2.8 验收项对应码）。
 */

const ATRAMENT_DOC = {
  engine: "atrament",
  version: 1,
  data: {
    width: INK_LOGICAL_WIDTH,
    strokes: [
      {
        tool: "pen",
        color: "#1f2328",
        weight: 4,
        points: [
          { x: 100, y: 200, p: 0.5, t: 0 },
          { x: 120, y: 1240, p: 0.8, t: 30 },
        ],
      },
      {
        tool: "highlighter",
        color: "rgba(250, 204, 21, 0.45)",
        weight: 16,
        points: [{ x: 0, y: 0, p: 0.5, t: 0 }],
      },
    ],
  },
  updatedAt: 1727392800000,
} as const;

const EXCALIDRAW_DOC = {
  engine: "excalidraw",
  version: 1,
  data: {
    scene: {
      elements: [
        { id: "el1", type: "freedraw", points: [[0, 0], [10, 10]] },
        { id: "el2", type: "rectangle", x: 1, y: 2 },
      ],
    },
  },
  updatedAt: 1727392800001,
} as const;

describe("inkDocSchema：atrament 分支", () => {
  it("接受合法文档；y 超过 1000 合法（答题区向下延伸）", () => {
    const parsed = inkDocSchema.parse(ATRAMENT_DOC);
    expect(parsed.engine).toBe("atrament");
    if (parsed.engine === "atrament") {
      expect(parsed.data.strokes).toHaveLength(2);
      expect(parsed.data.strokes[0]?.points[1]?.y).toBe(1240);
    }
  });

  it("width 只接受 1000（归一化基准是往返一致的前提）", () => {
    expect(
      inkAtramentDataSchema.safeParse({
        ...ATRAMENT_DOC.data,
        width: 800,
      }).success,
    ).toBe(false);
  });

  it("压力越界 / 负时间戳 / 未知工具 / 空颜色拒绝", () => {
    expect(
      inkStrokeSchema.safeParse({
        tool: "pen",
        color: "#000",
        weight: 4,
        points: [{ x: 0, y: 0, p: 1.5, t: 0 }],
      }).success,
    ).toBe(false);
    expect(
      inkStrokeSchema.safeParse({
        tool: "pen",
        color: "#000",
        weight: 4,
        points: [{ x: 0, y: 0, p: 0.5, t: -1 }],
      }).success,
    ).toBe(false);
    expect(
      inkStrokeSchema.safeParse({
        tool: "eraser",
        color: "#000",
        weight: 4,
        points: [],
      }).success,
    ).toBe(false);
    expect(
      inkStrokeSchema.safeParse({
        tool: "pen",
        color: "",
        weight: 4,
        points: [],
      }).success,
    ).toBe(false);
  });
});

describe("inkDocSchema：excalidraw 分支与判别", () => {
  it("接受合法文档；elements 为对象数组即可（内部不解释）", () => {
    const parsed = inkDocSchema.parse(EXCALIDRAW_DOC);
    if (parsed.engine === "excalidraw") {
      expect(parsed.data.scene.elements).toHaveLength(2);
    }
    expect(
      inkExcalidrawDataSchema.safeParse({ scene: { elements: [42] } }).success,
    ).toBe(false);
  });

  it("未知 engine / 不支持 version / 缺 data / 缺 updatedAt 拒绝", () => {
    expect(
      inkDocSchema.safeParse({ ...ATRAMENT_DOC, engine: "pencilkit" }).success,
    ).toBe(false);
    expect(
      inkDocSchema.safeParse({ ...ATRAMENT_DOC, version: 2 }).success,
    ).toBe(false);
    expect(
      inkDocSchema.safeParse({
        engine: "atrament",
        version: 1,
        updatedAt: 0,
      }).success,
    ).toBe(false);
    const { updatedAt: _omit, ...noUpdatedAt } = ATRAMENT_DOC;
    expect(inkDocSchema.safeParse(noUpdatedAt).success).toBe(false);
  });
});

describe("上传/取回/元数据响应", () => {
  it("上传回执：strokeCount/width/height 非负整数 + UTC ISO updatedAt", () => {
    const upload = {
      questionId: "练习四-7",
      inkId: "77777777-7777-4777-8777-777777777777",
      strokeCount: 3,
      width: 1024,
      height: 768,
      updatedAt: "2026-09-27T02:00:00.000Z",
    };
    expect(inkUploadDataSchema.parse(upload).strokeCount).toBe(3);
    expect(inkUploadOkSchema.safeParse({ ok: true, data: upload }).success).toBe(
      true,
    );
    expect(
      inkUploadDataSchema.safeParse({ ...upload, strokeCount: -1 }).success,
    ).toBe(false);
  });

  it("取回响应 data 直接是 InkDoc（两种 engine 都过）", () => {
    expect(inkFetchDataSchema.safeParse(ATRAMENT_DOC).success).toBe(true);
    expect(inkFetchDataSchema.safeParse(EXCALIDRAW_DOC).success).toBe(true);
  });

  it("教师元数据形态", () => {
    const meta = {
      id: "77777777-7777-4777-8777-777777777777",
      attemptId: "55555555-5555-4555-8555-555555555555",
      questionId: "p4-q7",
      width: 1024,
      height: 768,
      strokeCount: 5,
      updatedAt: "2026-09-27T02:00:00.000Z",
    };
    expect(inkMetaSchema.parse(meta).strokeCount).toBe(5);
  });

  it("错误码集合（INK_TOO_LARGE 对应 413 验收项）", () => {
    for (const code of [
      "INK_TOO_LARGE",
      "INK_INVALID",
      "INK_NOT_FOUND",
    ] as const) {
      expect(inkErrorCodeSchema.parse(code)).toBe(code);
    }
    expect(inkErrorCodeSchema.safeParse("INK_MISSING").success).toBe(false);
  });

  it("限额常量锁定：合计 2 MiB", () => {
    expect(INK_MAX_UPLOAD_BYTES).toBe(2 * 1024 * 1024);
  });
});
