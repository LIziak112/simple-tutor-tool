import { describe, expect, it } from "vitest";
import { questionProcessBatchSchema } from "./question-process.ts";

const base = {
  version: 1,
  recordingId: "863de11a-f212-46e1-b876-d3a29e07df55",
  questionId: "q",
  revisionId: "revision",
  segmentId: "11111111-1111-4111-8111-111111111111",
  startedAt: 1000,
};
const surface = { width: 1000, height: 800, strokes: [] };
describe("单题过程正式手写契约", () => {
  it("正式作答层兼容起始快照与逐笔事件", () => {
    const parsed = questionProcessBatchSchema.parse({
      ...base,
      events: [
        {
          seq: 0,
          at: 0,
          kind: "start",
          answer: null,
          hints: [],
          layers: { answer: surface },
        },
        {
          seq: 1,
          at: 100,
          kind: "ink",
          layer: "answer",
          operation: "stroke",
          removed: [],
          added: [],
        },
      ],
    });
    expect(parsed.events[0]).toMatchObject({ layers: { answer: surface } });
    expect(parsed.events[1]).toMatchObject({ layer: "answer" });
  });
  it("历史Excalidraw场景作为冻结快照，旧的双层快照仍兼容", () => {
    const legacy = {
      scene: {
        elements: [{ id: "rectangle-one", type: "rectangle", x: 1, y: 2 }],
      },
    };
    const parsed = questionProcessBatchSchema.parse({
      ...base,
      events: [
        {
          seq: 0,
          at: 0,
          kind: "start",
          answer: null,
          hints: [],
          layers: { answer: { ...surface, legacy } },
        },
      ],
    });
    expect(parsed.events[0]).toMatchObject({ layers: { answer: { legacy } } });
    expect(
      questionProcessBatchSchema.safeParse({
        ...base,
        events: [
          {
            seq: 0,
            at: 0,
            kind: "start",
            answer: null,
            hints: [],
            layers: { annotation: surface, scratch: surface },
          },
        ],
      }).success,
    ).toBe(true);
  });
});
