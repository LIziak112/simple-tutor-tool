import { describe, expect, it } from "vitest";
import {
  type ActivityEvent,
  computeAttemptActivity,
} from "./question-activity";

/**
 * 题内活动用时 v1 口径（契约 attempt-activity.ts）逐条锁定：
 * 有动作才归题 / 只看过算 observed / 隐藏与空闲扣除 / 多端重叠不归属 /
 * 同题多端只算一次 / 去重 / submit 截止 / 无聚焦有动作按动作归属。
 */

const T0 = 1_700_000_000_000;
const ev = (
  type: string,
  sec: number,
  questionId: string | null = null,
  viewId: string | null = null,
): ActivityEvent => ({ type, clientTs: T0 + sec * 1000, questionId, viewId });

describe("题内活动用时：单端", () => {
  it("有答案变更的聚焦时段计 active，只看不动的计 observed，隐藏区间扣除", () => {
    const result = computeAttemptActivity([
      ev("attempt_start", 0),
      ev("question_view", 0, "q1"),
      ev("question_view", 0, "q2"),
      ev("question_focus", 0, "q1"),
      ev("answer_change", 30, "q1"),
      ev("page_hidden", 60),
      ev("page_visible", 120), // 隐藏 60 秒不计
      ev("question_focus", 150, "q2"), // q1 共 0–60 + 120–150 = 90 秒，有动作
      ev("question_blur", 170, "q2"), // q2 只看 20 秒
      ev("submit", 180),
    ]);
    expect(result.byQuestion.q1).toEqual({
      activeSec: 90,
      observedSec: 0,
      actions: 1,
      viewed: true,
    });
    expect(result.byQuestion.q2).toEqual({
      activeSec: 0,
      observedSec: 20,
      actions: 0,
      viewed: true,
    });
    expect(result.activeSecTotal).toBe(90);
    expect(result.observedSecTotal).toBe(20);
    expect(result.unattributedSec).toBe(0);
    expect(result.sessions).toBe(1);
    expect(result.version).toBe(1);
  });

  it("空闲区间扣除；动作到来即恢复计时；submit 之后的事件不计", () => {
    const result = computeAttemptActivity([
      ev("question_focus", 0, "q1"),
      ev("idle_start", 100),
      ev("ink_stroke_batch", 400, "q1"), // 空闲 300 秒不计，动作即恢复
      ev("idle_end", 401),
      ev("submit", 500),
      ev("answer_change", 600, "q1"), // 迟到动作：不计时长也不计次数
      ev("question_focus", 700, "q3"),
    ]);
    expect(result.byQuestion.q1).toEqual({
      activeSec: 200,
      observedSec: 0,
      actions: 1,
      viewed: true,
    });
    expect(result.byQuestion.q3).toBeUndefined();
  });

  it("只有 question_view 的题 viewed=true、时长 0；没聚焦直接动作按动作归属", () => {
    const result = computeAttemptActivity([
      ev("question_view", 0, "q1"),
      ev("question_view", 0, "q2"),
      ev("answer_change", 10, "q2"),
      ev("answer_change", 40, "q2"),
      ev("question_blur", 70, "q2"),
    ]);
    expect(result.byQuestion.q1).toEqual({
      activeSec: 0,
      observedSec: 0,
      actions: 0,
      viewed: true,
    });
    expect(result.byQuestion.q2).toEqual({
      activeSec: 60,
      observedSec: 0,
      actions: 2,
      viewed: true,
    });
  });

  it("完全相同的事件（离线补发 / 双发）只算一条", () => {
    const base = [
      ev("question_focus", 0, "q1"),
      ev("answer_change", 10, "q1"),
      ev("question_blur", 30, "q1"),
    ];
    const result = computeAttemptActivity([...base, ...base]);
    expect(result.byQuestion.q1?.actions).toBe(1);
    expect(result.byQuestion.q1?.activeSec).toBe(30);
  });
});

describe("题内活动用时：多端", () => {
  it("两台设备同时聚焦不同题的重叠时段归「未归属」，各自独占的时段照归", () => {
    const result = computeAttemptActivity([
      // iPad：0–100 做 q1
      ev("question_focus", 0, "q1", "ipad"),
      ev("answer_change", 20, "q1", "ipad"),
      ev("question_blur", 100, "q1", "ipad"),
      // 手机：60–160 看 q2（与 iPad 重叠 60–100）
      ev("question_focus", 60, "q2", "phone"),
      ev("question_blur", 160, "q2", "phone"),
    ]);
    expect(result.sessions).toBe(2);
    expect(result.byQuestion.q1).toEqual({
      activeSec: 60,
      observedSec: 0,
      actions: 1,
      viewed: true,
    });
    expect(result.byQuestion.q2).toEqual({
      activeSec: 0,
      observedSec: 60,
      actions: 0,
      viewed: true,
    });
    expect(result.unattributedSec).toBe(40);
  });

  it("两端同时聚焦同一题只算一次；重叠区间任一端有动作即 active，独占区间按各自口径", () => {
    const result = computeAttemptActivity([
      ev("question_focus", 0, "q1", "a"), // a：0–100 只看
      ev("question_blur", 100, "q1", "a"),
      ev("question_focus", 50, "q1", "b"), // b：50–150 有动作
      ev("hint_open", 60, "q1", "b"),
      ev("question_blur", 150, "q1", "b"),
    ]);
    // 0–50 仅 a（observed 50）；50–100 两端重叠同题只算一次且 b 有动作（active 50）；
    // 100–150 仅 b（active 50）
    expect(result.byQuestion.q1).toEqual({
      activeSec: 100,
      observedSec: 50,
      actions: 1,
      viewed: true,
    });
    expect(result.unattributedSec).toBe(0);
  });

  it("旧客户端事件（无 viewId）与新事件各成一组：单端回放不会被当成重叠", () => {
    const result = computeAttemptActivity([
      ev("question_focus", 0, "q1"),
      ev("answer_change", 5, "q1"),
      ev("question_blur", 50, "q1"),
      ev("question_focus", 60, "q2", "new"),
      ev("question_blur", 90, "q2", "new"),
    ]);
    expect(result.sessions).toBe(2);
    expect(result.byQuestion.q1?.activeSec).toBe(50);
    expect(result.byQuestion.q2?.observedSec).toBe(30);
    expect(result.unattributedSec).toBe(0);
  });
});
