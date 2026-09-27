import { describe, expect, it } from "vitest";
import {
  attemptEventBatchRequestSchema,
  attemptEventSchema,
  LEARNING_EVENTS_BATCH_MAX,
  learningEventSchema,
  learningEventTypeSchema,
  lectureEventBatchRequestSchema,
} from "./learning-event.ts";

/**
 * 学习痕迹事件契约测试（T2.10）：
 * - 事件类型枚举与 §5.5 一致（11 种）；
 * - 单条事件：合法/非法 type、缺 questionId、answer_change 的 from/to 形态；
 * - 批量请求：200 条通过 / 201 条拒绝（任务验收：超 200 → 400 的契约层依据）；
 * - attempt 事件联合不含 lecture_expand、lecture 联合只含 lecture_expand。
 */

/** 最小合法事件（按 type 补 payload） */
function eventOf(
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type, clientTs: 1_769_000_000_000, ...extra };
}

describe("learningEventTypeSchema", () => {
  it("枚举与 §5.5 一致：11 种", () => {
    expect(learningEventTypeSchema.options).toEqual([
      "attempt_start",
      "question_view",
      "question_focus",
      "question_blur",
      "answer_change",
      "hint_open",
      "ink_stroke_batch",
      "page_hidden",
      "page_visible",
      "submit",
      "lecture_expand",
    ]);
  });
});

describe("learningEventSchema（单条）", () => {
  it("非法 type 拒绝", () => {
    expect(
      learningEventSchema.safeParse(eventOf("hacked_type")).success,
    ).toBe(false);
  });

  it("clientTs 非正整数拒绝（毫秒约定）", () => {
    expect(
      learningEventSchema.safeParse(
        eventOf("attempt_start", { clientTs: "1769000000000" }),
      ).success,
    ).toBe(false);
    expect(
      learningEventSchema.safeParse(eventOf("attempt_start", { clientTs: 0 }))
        .success,
    ).toBe(false);
  });

  it("带题事件缺 questionId 拒绝；question_view/question_focus/blur/hint_open/ink 合法", () => {
    expect(
      learningEventSchema.safeParse(eventOf("question_focus")).success,
    ).toBe(false);
    for (const [type, extra] of [
      ["question_view", {}],
      ["question_focus", {}],
      ["question_blur", {}],
      ["hint_open", { index: 1 }],
      ["ink_stroke_batch", { strokes: 1 }],
    ] as const) {
      expect(
        learningEventSchema.safeParse(
          eventOf(type, { questionId: "练习四-1", ...extra }),
        ).success,
      ).toBe(true);
    }
  });

  it("answer_change：from/to 为学生答案形态，可同时/单独缺省", () => {
    expect(
      learningEventSchema.safeParse(
        eventOf("answer_change", {
          questionId: "练习四-4",
          from: { kind: "fill", values: ["4"] },
          to: { kind: "fill", values: ["5"] },
        }),
      ).success,
    ).toBe(true);
    expect(
      learningEventSchema.safeParse(
        eventOf("answer_change", { questionId: "练习四-4" }),
      ).success,
    ).toBe(true);
    // 答案形态不合法（kind 未知）拒绝
    expect(
      learningEventSchema.safeParse(
        eventOf("answer_change", {
          questionId: "练习四-4",
          to: { kind: "nope" },
        }),
      ).success,
    ).toBe(false);
  });

  it("hint_open 缺 index / ink_stroke_batch 缺 strokes 拒绝", () => {
    expect(
      learningEventSchema.safeParse(
        eventOf("hint_open", { questionId: "练习四-1" }),
      ).success,
    ).toBe(false);
    expect(
      learningEventSchema.safeParse(
        eventOf("ink_stroke_batch", { questionId: "练习四-1" }),
      ).success,
    ).toBe(false);
  });

  it("lecture_expand 载荷：lectureId/directive/index", () => {
    expect(
      learningEventSchema.safeParse(
        eventOf("lecture_expand", {
          lectureId: " lec-1",
          directive: "solution",
          index: 3,
        }),
      ).success,
    ).toBe(true);
    expect(
      learningEventSchema.safeParse(eventOf("lecture_expand", { index: 3 }))
        .success,
    ).toBe(false);
  });
});

describe("批量请求 schema", () => {
  it("attempt 批量：200 条通过、201 条拒绝、0 条拒绝", () => {
    const events = Array.from({ length: LEARNING_EVENTS_BATCH_MAX }, () =>
      eventOf("attempt_start"),
    );
    expect(
      attemptEventBatchRequestSchema.safeParse({ events }).success,
    ).toBe(true);
    expect(
      attemptEventBatchRequestSchema.safeParse({
        events: [...events, eventOf("submit")],
      }).success,
    ).toBe(false);
    expect(attemptEventBatchRequestSchema.safeParse({ events: [] }).success).toBe(
      false,
    );
  });

  it("attempt 联合不含 lecture_expand；lecture 联合只含 lecture_expand", () => {
    expect(
      attemptEventSchema.safeParse(
        eventOf("lecture_expand", {
          lectureId: "lec-1",
          directive: "solution",
          index: 0,
        }),
      ).success,
    ).toBe(false);
    expect(
      lectureEventBatchRequestSchema.safeParse({
        events: [
          eventOf("lecture_expand", {
            lectureId: "lec-1",
            directive: "fold",
            index: 2,
          }),
        ],
      }).success,
    ).toBe(true);
    expect(
      lectureEventBatchRequestSchema.safeParse({ events: [eventOf("submit")] })
        .success,
    ).toBe(false);
  });
});
