import type {
  AiHelpQuestionFactsContract,
  AiTeacherTaskRecord,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { aiHelpLabelOf } from "./ai-help-label";

/**
 * SAI-24 教师督学标签模型测试（B13 失败用例第一/二/三组的标签面）：
 * - 无平台记录只说「无平台作答中求助记录」——不断言「独立完成」；
 * - 有求助的任何标签不出现「盲区/重度」等推测性结论；
 * - 仅入队 / 已外发未回信 / 已回信未看 / 有查看记录四种状态文本两两可区分；
 * - 完成后复盘不计作答中辅助；提交前发起、提交后才外发如实呈现。
 */

const BASE = {
  attemptId: "1c2d3e4f-0000-4000-8000-000000000001",
  questionId: "q-alpha",
  taskCount: 1,
} as const;

function factsOf(
  over: Partial<AiHelpQuestionFactsContract>,
): AiHelpQuestionFacts {
  return {
    ...BASE,
    requested: true,
    requestedBeforeSubmit: true,
    queuedOnly: false,
    dispatched: false,
    dispatchedBeforeSubmit: false,
    replyReceived: false,
    repliedBeforeSubmit: false,
    platformOpened: false,
    platformOpenedBeforeSubmit: false,
    externalViewedUnknown: false,
    outboundStatusUnknown: false,
    ...over,
  };
}

type AiHelpQuestionFacts = AiHelpQuestionFactsContract;

const TASK_STUB = {
  taskId: "2b3c4d5e-0000-4000-8000-000000000002",
  questionId: "q-alpha",
  status: "replied",
  channel: "inapp",
  modeAtSend: "guided_only",
  beforeSubmit: true,
  question: "这道题的思路是什么？",
  hasReply: true,
  replyDeliveredAt: null,
  errorText: null,
  retryCount: 0,
  archivedAt: null,
  cancelRequestedAt: null,
  createdAt: "2026-10-15T08:00:00.000Z",
  facts: [],
} as const satisfies AiTeacherTaskRecord;

describe("SAI-24 教师督学标签（失败用例①③：不断言独立、不做推测结论）", () => {
  it("无记录只说「无平台作答中求助记录」，不含「独立」字样", () => {
    const none = aiHelpLabelOf(undefined, []);
    expect(none.text).toBe("无平台作答中求助记录");
    expect(none.kind).toBe("none");
    expect(none.text).not.toContain("独立");
    // 有任务行但没有事实分桶（防御）同样按零态呈现
    expect(
      aiHelpLabelOf(factsOf({ requested: false, queuedOnly: false }), [
        TASK_STUB,
      ]).text,
    ).not.toContain("独立");
  });

  it("所有标签都不出现「盲区/重度/已获帮助」等推测性结论字样", () => {
    const labels = [
      aiHelpLabelOf(undefined, []),
      aiHelpLabelOf(factsOf({ queuedOnly: true }), [TASK_STUB]),
      aiHelpLabelOf(
        factsOf({
          dispatched: true,
          dispatchedBeforeSubmit: true,
          replyReceived: true,
          repliedBeforeSubmit: true,
          platformOpened: true,
          platformOpenedBeforeSubmit: true,
        }),
        [TASK_STUB],
      ),
      aiHelpLabelOf(factsOf({ requestedBeforeSubmit: false }), [
        { ...TASK_STUB, beforeSubmit: false },
      ]),
    ];
    for (const label of labels) {
      expect(label.text).not.toContain("盲区");
      expect(label.text).not.toContain("重度");
      expect(label.text).not.toContain("已获帮助");
      expect(label.text).not.toContain("独立");
    }
  });

  it("完成后复盘不计作答中辅助；提交前发起、提交后才外发如实呈现", () => {
    const review = aiHelpLabelOf(factsOf({ requestedBeforeSubmit: false }), [
      { ...TASK_STUB, beforeSubmit: false },
    ]);
    expect(review.kind).toBe("review");
    expect(review.text).toContain("AI 复盘");
    expect(review.text).toContain("完成后");
    // 不染为作答中辅助：标签不以「作答中」开头（作答中求助/作答中发起均否）
    expect(review.text.startsWith("作答中")).toBe(false);

    const late = aiHelpLabelOf(
      factsOf({ dispatched: true, replyReceived: true }),
      [TASK_STUB],
    );
    expect(late.kind).toBe("late-outbound");
    expect(late.text).toContain("提交后");
    expect(late.text).not.toContain("作答中 AI 求助");
  });
});

describe("SAI-24 教师督学标签（失败用例②：四态可区分）", () => {
  it("仅入队 / 已外发未回信 / 已回信未看 / 有查看记录四种文本两两可区分", () => {
    const queued = aiHelpLabelOf(factsOf({ queuedOnly: true }), [TASK_STUB]);
    const dispatched = aiHelpLabelOf(
      factsOf({ dispatched: true, dispatchedBeforeSubmit: true }),
      [TASK_STUB],
    );
    const replied = aiHelpLabelOf(
      factsOf({
        dispatched: true,
        dispatchedBeforeSubmit: true,
        replyReceived: true,
        repliedBeforeSubmit: true,
      }),
      [TASK_STUB],
    );
    const opened = aiHelpLabelOf(
      factsOf({
        dispatched: true,
        dispatchedBeforeSubmit: true,
        replyReceived: true,
        repliedBeforeSubmit: true,
        platformOpened: true,
        platformOpenedBeforeSubmit: true,
      }),
      [TASK_STUB],
    );
    // 四态语义锚点
    expect(queued.text).toContain("未处理");
    expect(dispatched.text).toContain("已外发");
    expect(dispatched.text).toContain("回信未到达");
    expect(replied.text).toContain("已回信");
    expect(replied.text).toContain("学生未查看");
    expect(opened.text).toContain("学生已查看");
    // 文本两两不同（可区分性）
    const texts = [queued, dispatched, replied, opened].map((l) => l.text);
    expect(new Set(texts).size).toBe(4);
  });

  it("作答中 AI 求助携带当时模式（仅启发/开放），出站状态未确认单独呈现", () => {
    const guided = aiHelpLabelOf(
      factsOf({
        dispatched: true,
        dispatchedBeforeSubmit: true,
        replyReceived: true,
        repliedBeforeSubmit: true,
      }),
      [TASK_STUB],
    );
    expect(guided.text).toContain("仅启发");
    const open = aiHelpLabelOf(
      factsOf({
        dispatched: true,
        dispatchedBeforeSubmit: true,
      }),
      [{ ...TASK_STUB, modeAtSend: "open_study" }],
    );
    expect(open.text).toContain("开放");
    const unknown = aiHelpLabelOf(factsOf({ outboundStatusUnknown: true }), [
      { ...TASK_STUB, status: "uncertain" },
    ]);
    expect(unknown.kind).toBe("unknown-outbound");
    expect(unknown.text).toContain("出站状态未确认");
  });
});
