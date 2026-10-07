import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  attemptEventBatchRequestSchema,
  attemptEventSchema,
  LEARNING_EVENTS_BATCH_MAX,
  learningEventSchema,
  learningEventTypeSchema,
  lectureEventBatchRequestSchema,
  lectureEventSchema,
} from "./learning-event.ts";

/**
 * 学习痕迹事件契约测试（T2.10 + T4.0a）：
 * - 事件类型枚举（既有 11 种零变化 + T4.0a 新增 11 种，共 22 种）；
 * - 单条事件：合法/非法 type、缺 questionId、answer_change 的 from/to 形态；
 * - 批量请求：200 条通过 / 201 条拒绝（任务验收：超 200 → 400 的契约层依据）；
 * - attempt 事件联合不含 lecture_expand、lecture 联合只含讲义域事件组；
 * - T4.0a：三族新事件的归属/分支锁定（host 分支、reveal 仅 lecture 带 step、
 *   端点互斥、多余键剥离——studentId 伪造无效的契约层依据）。
 */

/** 最小合法事件（按 type 补 payload） */
function eventOf(
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type, clientTs: 1_769_000_000_000, ...extra };
}

describe("learningEventTypeSchema", () => {
  it("枚举：既有 11 种零变化 + T4.0a 新增 11 种（方案 §4.3 三族）", () => {
    expect(learningEventTypeSchema.options).toEqual([
      // 既有（T2.10，顺序与语义零变化）
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
      // T4.0a 环境族
      "lecture_visible",
      "lecture_hidden",
      "net_offline",
      "net_online",
      "idle_start",
      "idle_end",
      // T4.0a 位置族
      "lecture_section_focus",
      "lecture_toc_jump",
      // T4.0a 交互族
      "directive_interact",
      "ink_edit_batch",
      "ink_fullscreen",
    ]);
  });
});

describe("learningEventSchema（单条）", () => {
  it("非法 type 拒绝", () => {
    expect(learningEventSchema.safeParse(eventOf("hacked_type")).success).toBe(
      false,
    );
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
    expect(attemptEventBatchRequestSchema.safeParse({ events }).success).toBe(
      true,
    );
    expect(
      attemptEventBatchRequestSchema.safeParse({
        events: [...events, eventOf("submit")],
      }).success,
    ).toBe(false);
    expect(
      attemptEventBatchRequestSchema.safeParse({ events: [] }).success,
    ).toBe(false);
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

// ---------- T4.0a：三族新事件（方案 §4.3） ----------

describe("T4.0a 环境族（lecture_visible/hidden、net、idle）", () => {
  it("lecture_visible/hidden 需 lectureId + viewId；缺一拒绝", () => {
    for (const type of ["lecture_visible", "lecture_hidden"] as const) {
      expect(
        learningEventSchema.safeParse(
          eventOf(type, { lectureId: "lec-1", viewId: "view-1" }),
        ).success,
      ).toBe(true);
      expect(
        learningEventSchema.safeParse(eventOf(type, { lectureId: "lec-1" }))
          .success,
      ).toBe(false);
      expect(
        learningEventSchema.safeParse(eventOf(type, { viewId: "view-1" }))
          .success,
      ).toBe(false);
    }
  });

  it("net/idle 无额外 payload；attempt 与 lecture 联合都收（两 scope 通用）", () => {
    for (const type of [
      "net_offline",
      "net_online",
      "idle_start",
      "idle_end",
    ] as const) {
      expect(attemptEventSchema.safeParse(eventOf(type)).success).toBe(true);
      expect(lectureEventSchema.safeParse(eventOf(type)).success).toBe(true);
    }
  });
});

describe("T4.0a 位置族（lecture_section_focus / lecture_toc_jump）", () => {
  it("headingIndex 非负整数；缺 lectureId 拒绝；attempt 联合不收（讲义域）", () => {
    for (const type of ["lecture_section_focus", "lecture_toc_jump"] as const) {
      expect(
        lectureEventSchema.safeParse(
          eventOf(type, { lectureId: "lec-1", headingIndex: 0 }),
        ).success,
      ).toBe(true);
      expect(
        lectureEventSchema.safeParse(
          eventOf(type, { lectureId: "lec-1", headingIndex: -1 }),
        ).success,
      ).toBe(false);
      expect(
        lectureEventSchema.safeParse(eventOf(type, { headingIndex: 2 }))
          .success,
      ).toBe(false);
      expect(attemptEventSchema.safeParse(eventOf(type)).success).toBe(false);
    }
  });
});

describe("T4.0a 交互族（directive_interact / ink_edit_batch / ink_fullscreen）", () => {
  it("host=lecture：open/close 与 reveal（reveal 必带 step≥1）；缺 lectureId 拒绝", () => {
    expect(
      lectureEventSchema.safeParse(
        eventOf("directive_interact", {
          host: "lecture",
          lectureId: "lec-1",
          name: "solution",
          index: 3,
          action: "open",
        }),
      ).success,
    ).toBe(true);
    const reveal = lectureEventSchema.safeParse(
      eventOf("directive_interact", {
        host: "lecture",
        lectureId: "lec-1",
        name: "steps",
        index: 5,
        action: "reveal",
        step: 2,
      }),
    );
    expect(reveal.success).toBe(true);
    // reveal 缺 step / step=0 拒绝（§5.0-B8：容器身份与步序号必须同时携带）
    expect(
      lectureEventSchema.safeParse(
        eventOf("directive_interact", {
          host: "lecture",
          lectureId: "lec-1",
          name: "steps",
          index: 5,
          action: "reveal",
        }),
      ).success,
    ).toBe(false);
    expect(
      lectureEventSchema.safeParse(
        eventOf("directive_interact", {
          host: "lecture",
          lectureId: "lec-1",
          name: "steps",
          index: 5,
          action: "reveal",
          step: 0,
        }),
      ).success,
    ).toBe(false);
    expect(
      lectureEventSchema.safeParse(
        eventOf("directive_interact", {
          host: "lecture",
          name: "solution",
          index: 3,
          action: "open",
        }),
      ).success,
    ).toBe(false);
  });

  it("host=question：questionId + open/close；host=result：attemptId+questionId；reveal 仅 lecture", () => {
    expect(
      attemptEventSchema.safeParse(
        eventOf("directive_interact", {
          host: "question",
          questionId: "练习四-1",
          name: "hint",
          index: 1,
          action: "open",
        }),
      ).success,
    ).toBe(true);
    expect(
      attemptEventSchema.safeParse(
        eventOf("directive_interact", {
          host: "result",
          attemptId: "att-1",
          questionId: "练习四-1",
          name: "solution",
          index: 2,
          action: "close",
        }),
      ).success,
    ).toBe(true);
    // result 宿主缺 attemptId 拒绝
    expect(
      attemptEventSchema.safeParse(
        eventOf("directive_interact", {
          host: "result",
          questionId: "练习四-1",
          name: "solution",
          index: 2,
          action: "open",
        }),
      ).success,
    ).toBe(false);
    // reveal 只允许 host=lecture：question/result 宿主带 reveal 拒绝
    for (const host of ["question", "result"] as const) {
      expect(
        attemptEventSchema.safeParse(
          eventOf("directive_interact", {
            host,
            ...(host === "result" ? { attemptId: "att-1" } : {}),
            questionId: "练习四-1",
            name: "steps",
            index: 1,
            action: "reveal",
            step: 1,
          }),
        ).success,
      ).toBe(false);
    }
  });

  it("ink_edit_batch 四计数非负整数；ink_fullscreen 布尔 on；均需 questionId", () => {
    expect(
      attemptEventSchema.safeParse(
        eventOf("ink_edit_batch", {
          questionId: "练习四-5",
          erase: 1,
          undo: 0,
          redo: 2,
          clear: 0,
        }),
      ).success,
    ).toBe(true);
    expect(
      attemptEventSchema.safeParse(
        eventOf("ink_edit_batch", {
          questionId: "练习四-5",
          erase: -1,
          undo: 0,
          redo: 0,
          clear: 0,
        }),
      ).success,
    ).toBe(false);
    expect(
      attemptEventSchema.safeParse(
        eventOf("ink_fullscreen", { questionId: "练习四-5", on: true }),
      ).success,
    ).toBe(true);
    expect(
      attemptEventSchema.safeParse(
        eventOf("ink_fullscreen", { questionId: "练习四-5", on: "yes" }),
      ).success,
    ).toBe(false);
    // 讲义端点不收交互族 attempt 域事件
    expect(
      lectureEventSchema.safeParse(
        eventOf("ink_fullscreen", { questionId: "练习四-5", on: true }),
      ).success,
    ).toBe(false);
  });

  it("端点互斥：讲义域事件进 attempt 联合拒绝、attempt 域新事件进 lecture 联合拒绝", () => {
    expect(
      attemptEventSchema.safeParse(
        eventOf("lecture_visible", { lectureId: "lec-1", viewId: "v" }),
      ).success,
    ).toBe(false);
    expect(
      attemptEventSchema.safeParse(
        eventOf("lecture_toc_jump", { lectureId: "lec-1", headingIndex: 1 }),
      ).success,
    ).toBe(false);
    expect(
      attemptEventSchema.safeParse(
        eventOf("lecture_section_focus", {
          lectureId: "lec-1",
          headingIndex: 1,
        }),
      ).success,
    ).toBe(false);
    expect(
      attemptEventSchema.safeParse(
        eventOf("lecture_hidden", { lectureId: "lec-1", viewId: "v" }),
      ).success,
    ).toBe(false);
    expect(
      lectureEventSchema.safeParse(
        eventOf("ink_edit_batch", {
          questionId: "q",
          erase: 0,
          undo: 0,
          redo: 0,
          clear: 0,
        }),
      ).success,
    ).toBe(false);
  });

  it("多余键被 Zod 剥离（伪造 studentId 无效——归属列由服务端写入，§4.2）", () => {
    const parsed = learningEventSchema.safeParse(
      eventOf("lecture_visible", {
        lectureId: "lec-1",
        viewId: "v",
        studentId: "forged",
      }),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      type: "lecture_visible",
      clientTs: 1_769_000_000_000,
      lectureId: "lec-1",
      viewId: "v",
    });
  });
});

// ---------- T6R.17：事件 payload 字段白名单守护（辅助信息纪律） ----------

describe("learningEventSchema：payload 字段白名单守护（T6R.17 辅助信息纪律）", () => {
  /**
   * 纪律出处（T6R.17 辅助信息纪律，承接 learning-event.ts 文件头安全口径
   * 与 AGENTS.md 第 3 条）：事件只存必要计数/引用——id / 序号 / 计数 / 布尔 /
   * 枚举 / 学生自报答案值；不记录额外笔画内容（笔迹本体走 T2.8 multipart
   * 通道）、不携带题目侧内容（答案/详解/提示正文）。
   *
   * 本测试遍历 learningEventSchema 全部分支的 payload 字段名，白名单外一律
   * 失败。Zod 对未知输入键是「剥离不报错」，管不住 schema 自身将来新增字段
   * 夹带内容——必须在契约层用白名单锁死：新增事件想加字段，先过这道闸。
   */
  it("全部事件分支的 payload 字段名都在白名单内", () => {
    const whitelist = new Set([
      // 通用
      "type",
      "clientTs",
      // 身份引用（id / 注册表枚举名，非内容）
      "questionId",
      "lectureId",
      "attemptId",
      "viewId",
      "name",
      "host",
      "action",
      // directive = lecture_expand 被展开的指令注册表主名（T2.10 既有事件，
      // 与 directive_interact 的 name 同语义：枚举引用非内容）——白名单必收
      "directive",
      // 序号
      "index",
      "headingIndex",
      "step",
      // 计数
      "strokes",
      "erase",
      "undo",
      "redo",
      "clear",
      // 布尔
      "on",
      // 学生自报答案值（from/to 是学生自己的输入，非标准答案）
      "from",
      "to",
      // 讲义版本定位（ISO 时间戳，可选；只做事件与讲义版本的比对锚点）
      "lectureUpdatedAt",
    ]);
    const violations: string[] = [];
    // net/idle 等两 scope 共用分支在 attempt/lecture 联合各出现一次，按引用去重
    const branches = [...new Set(learningEventSchema.options)];
    for (const branch of branches) {
      // 每个分支都是扁平 z.object（payload 不嵌套对象——嵌套的内容载体无处安放）
      let label = "(未知 type)";
      const typeSchema = branch.shape.type;
      if (typeSchema instanceof z.ZodLiteral) {
        for (const v of typeSchema.values) {
          label = `type=${String(v)}`;
          break;
        }
      }
      for (const key of Object.keys(branch.shape)) {
        if (!whitelist.has(key)) {
          violations.push(`${label} 的 payload 字段 "${key}" 不在白名单`);
        }
      }
    }
    // 守护自检：分支数须与现行 22 种事件的 schema 分支数一致（directive_interact
    // 按 host/action 拆 4 分支、net/idle 两 scope 共用同一 schema）——新增事件
    // 此数必然 +1，白名单须同步审视，这正是守护点
    expect(branches.length).toBe(25);
    expect(violations).toEqual([]);
  });
});
