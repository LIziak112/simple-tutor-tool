import type {
  InkDeletedStroke,
  InkMaterialFacet,
  InkStroke,
} from "@tutor/contract";
import {
  AI_MAX_POINTS_PER_MATERIAL,
  AI_STROKE_EPSILON_RATIO,
  learningRecordSchema,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  compactInkMaterial,
  learningRecordAiViewOf,
  rdpIndices,
} from "./learning-record-ai.ts";

/** 直线上 n 个等距采样（全部共线） */
function linePoints(n: number): InkStroke["points"] {
  const out: InkStroke["points"] = [];
  for (let i = 0; i < n; i++) {
    out.push({ x: i, y: i, p: 0.5, t: i * 10 });
  }
  return out;
}

/** 锯齿线（±5 抖动，RDP 保不住大多数中间点） */
function jaggedPoints(n: number): InkStroke["points"] {
  const out: InkStroke["points"] = [];
  for (let i = 0; i < n; i++) {
    out.push({ x: i, y: i % 2 === 0 ? 0 : 5, p: 0.5, t: i * 10 });
  }
  return out;
}

function strokeOf(id: string, points: InkStroke["points"]): InkStroke {
  return {
    tool: "pen",
    color: "#1f2328",
    weight: 4,
    id,
    startedAt: 1727392800000,
    pointer: "pen",
    points,
  };
}

function facetOf(
  strokes: InkStroke[],
  deleted: InkDeletedStroke[],
): InkMaterialFacet {
  const pointCount = (list: { points: unknown[] }[]) =>
    list.reduce((sum, s) => sum + s.points.length, 0);
  return {
    kind: "draft",
    present: true,
    phase: "scratch",
    frame: { kind: "paper", width: 1000, height: 800 },
    strokes,
    deleted,
    stats: {
      strokeCount: strokes.length,
      pointCount: pointCount(strokes),
      deletedCount: pointCount(deleted),
      firstAt: null,
      lastAt: null,
      writingMs: null,
      pauses: [],
      timingCoverage: "none",
    },
    images: [],
  };
}

describe("rdpIndices（LR-PR5 §7.3）", () => {
  it("共线中间点全丢，端点保留；拐角保留；保留点携带原始 p/t", () => {
    const straight = linePoints(50);
    expect(rdpIndices(straight, 3)).toEqual([0, 49]);
    const corner = [
      { x: 0, y: 0, p: 0.5, t: 0 },
      { x: 50, y: 0, p: 0.6, t: 100 },
      { x: 50, y: 100, p: 0.7, t: 200 },
    ];
    expect(rdpIndices(corner, 3)).toEqual([0, 1, 2]);
  });

  it("ε=0 或 ≤2 点原样保留", () => {
    const pts = linePoints(5);
    expect(rdpIndices(pts, 0)).toEqual([0, 1, 2, 3, 4]);
    expect(rdpIndices(pts.slice(0, 2), 100)).toEqual([0, 1]);
  });
});

describe("compactInkMaterial（LR-PR5 §7.3）", () => {
  it("纸面域 ε = 1000 × 0.003：共线笔压到两端，p/t 随原始采样", () => {
    const stroke = strokeOf("s1", linePoints(40));
    const result = compactInkMaterial(facetOf([stroke], []));
    expect(result.compacted).toBe(false);
    expect(result.keptPoints).toBe(2);
    expect(result.originalPoints).toBe(40);
    const kept = result.strokes[0]?.points ?? [];
    expect(kept[0]).toEqual({ x: 0, y: 0, p: 0.5, t: 0 });
    expect(kept[1]).toEqual({ x: 39, y: 39, p: 0.5, t: 390 });
    expect(result.strokes[0]?.id).toBe("s1");
    expect(result.strokes[0]?.startedAt).toBe(1727392800000);
  });

  it("超限抽稀：总量收敛 ≤ 预算、首末保留、id/次序不变、compacted=true", () => {
    const strokes = [
      strokeOf("s1", jaggedPoints(3000)),
      strokeOf("s2", jaggedPoints(3000)),
      strokeOf("s3", jaggedPoints(3000)),
    ];
    const result = compactInkMaterial(facetOf(strokes, []));
    expect(result.originalPoints).toBe(9000);
    expect(result.compacted).toBe(true);
    expect(result.keptPoints).toBeLessThanOrEqual(AI_MAX_POINTS_PER_MATERIAL);
    expect(result.strokes.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    for (const stroke of result.strokes) {
      expect(stroke.points.length).toBeGreaterThanOrEqual(2);
      expect(stroke.points[0]?.x).toBe(0);
      expect(stroke.points.at(-1)?.x).toBe(2999);
    }
  });

  it("墓碑计入总点数与预算；anchors 语义不受影响（id 原样）", () => {
    const tomb: InkDeletedStroke = {
      tool: "pen",
      color: "#1f2328",
      weight: 4,
      id: "gone",
      startedAt: 1727392800000,
      pointer: "pen",
      deletedAt: 1727392900000,
      deletedBy: "eraser",
      points: jaggedPoints(7000),
    };
    const result = compactInkMaterial(facetOf([], [tomb]));
    expect(result.originalPoints).toBe(7000);
    expect(result.compacted).toBe(true);
    expect(result.keptPoints).toBeLessThanOrEqual(AI_MAX_POINTS_PER_MATERIAL);
    expect(result.deleted[0]?.id).toBe("gone");
    expect(result.deleted[0]?.deletedBy).toBe("eraser");
  });

  it("圈画底图域按 pixelWidth 取 ε 基准；默认常量与契约一致", () => {
    // 偏差量 4 夹在两个 ε 之间：纸面 ε=3 保留拐点、底图(1440) ε=4.32 丢弃
    const bump: InkStroke["points"] = [
      { x: 0, y: 0, p: 0.5, t: 0 },
      { x: 100, y: 4, p: 0.6, t: 100 },
      { x: 200, y: 0, p: 0.5, t: 200 },
    ];
    const paper = compactInkMaterial(facetOf([strokeOf("s1", bump)], []));
    expect(paper.keptPoints).toBe(3);
    const wide = {
      ...facetOf([strokeOf("s1", bump)], []),
      frame: {
        kind: "base" as const,
        pixelWidth: 1440,
        pixelHeight: 800,
        anchoredRatio: 1,
      },
    };
    const based = compactInkMaterial(wide);
    expect(based.keptPoints).toBe(2);
    expect(AI_STROKE_EPSILON_RATIO).toBe(0.003);
  });
});

describe("learningRecordAiViewOf（LR-PR5 §7.3）", () => {
  function aiRecordFixture() {
    return learningRecordSchema.parse({
      recordVersion: 1,
      role: "ai",
      generatedAt: "2026-10-26T12:00:00Z",
      identity: {
        questionRevisionId: "rev-0001",
        questionNo: 1,
        attemptStatus: "draft",
        source: "assignment",
      },
      question: {
        snapshotPresent: true,
        type: "choice",
        stemMd: "选择正确答案。",
        nodesVersion: 1,
        nodes: [{ key: "root", kind: "root", order: 0 }],
      },
      answer: {
        current: null,
        answerText: null,
        answerRevision: 0,
        history: [],
      },
      ink: [
        {
          ...facetOf([strokeOf("stroke-s1", linePoints(50))], []),
          images: [
            {
              kind: "snapshot" as const,
              pageIndex: 0,
              pixelWidth: 100,
              pixelHeight: 80,
              state: "ready" as const,
            },
          ],
        },
      ],
      timeline: {
        entries: [
          {
            at: 1727392800000,
            kind: "ai_task",
            source: "ai",
            detail: { taskId: "task-uuid-x", beforeSubmit: true },
          },
        ],
        clock: { basis: "client", serverSkewMs: null },
        truncated: false,
      },
      grading: { answered: false, hintsUsed: 0, hintsOpened: [] },
    });
  }

  it("压缩进视图 + 台账 + resolveImageUrl 填充；契约 fail-closed", () => {
    const record = aiRecordFixture();
    const view = learningRecordAiViewOf(record, {
      resolveImageUrl: (kind) =>
        kind === "draft" ? "https://t.test/x.png" : undefined,
    });
    expect(view.record.role).toBe("ai");
    expect(view.compaction.materials).toHaveLength(1);
    expect(view.compaction.materials[0]).toMatchObject({
      kind: "draft",
      originalPoints: 50,
      compacted: false,
    });
    // 共线笔 RDP 压到端点
    expect(view.record.ink[0]?.strokes[0]?.points).toHaveLength(2);
    expect(view.record.ink[0]?.images[0]?.downloadUrl).toBe(
      "https://t.test/x.png",
    );
    // timeline detail 的 taskId 全通道剥离（对账标识不进模型载荷）
    expect(view.record.timeline.entries[0]?.detail?.taskId).toBeUndefined();
    expect(view.record.timeline.entries[0]?.detail?.beforeSubmit).toBe(true);
    // 非 ai 记录在 schema 层拒绝（防误投学生/教师记录）
    expect(() =>
      learningRecordAiViewOf({
        ...record,
        role: "student",
      }),
    ).toThrow();
  });
});
