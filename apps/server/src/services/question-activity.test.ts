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

  it("审查 #100-02：任一端交卷后，其他端之后的事件也不再计（交卷是全卷截止）", () => {
    const result = computeAttemptActivity([
      ev("question_focus", 0, "q1", "a"),
      ev("answer_change", 10, "q1", "a"),
      ev("question_blur", 40, "q1", "a"),
      ev("submit", 100, null, "a"),
      // 另一端：交卷前看 q2，交卷后还在做 q3
      ev("question_focus", 50, "q2", "b"),
      ev("question_blur", 90, "q2", "b"),
      ev("question_focus", 120, "q3", "b"),
      ev("answer_change", 150, "q3", "b"),
      ev("question_blur", 200, "q3", "b"),
    ]);
    expect(result.byQuestion.q1?.activeSec).toBe(40);
    expect(result.byQuestion.q2?.observedSec).toBe(40);
    expect(result.byQuestion.q3).toBeUndefined();
    expect(result.activeSecTotal).toBe(40);
    expect(result.unattributedSec).toBe(0);
  });

  it("审查 #100-02 复核：截止锚在服务端受理前到达的最后一条 submit——失败交卷后刷新重做的真实作答不被截掉，交卷后过期标签页再点的 submit 不拖后截止", () => {
    // 服务端接收时刻 = 客户端时刻（同步时钟）；受理交卷在 400 秒
    const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
    const withServerTs = (
      event: ActivityEvent,
      sec: number,
    ): ActivityEvent => ({
      ...event,
      serverTs: at(sec),
    });
    const events: ActivityEvent[] = [
      // 会话 a：做 q1，100 秒点交卷 → 409 刷新重交（submit 事件已发出）
      ev("question_focus", 0, "q1", "a"),
      ev("answer_change", 10, "q1", "a"),
      ev("question_blur", 100, "q1", "a"),
      withServerTs(ev("submit", 100, null, "a"), 100),
      // 刷新后的会话 b：接着做 q2，400 秒真正交卷
      ev("question_focus", 200, "q2", "b"),
      ev("answer_change", 210, "q2", "b"),
      ev("question_blur", 399, "q2", "b"),
      withServerTs(ev("submit", 399, null, "b"), 399),
      // 过期标签页 c：交卷后还开着，500 秒看 q3 并又点了一次交卷
      ev("question_focus", 420, "q3", "c"),
      ev("answer_change", 430, "q3", "c"),
      withServerTs(ev("submit", 500, null, "c"), 500),
    ];
    const anchored = computeAttemptActivity(events, { submittedAt: at(400) });
    expect(anchored.byQuestion.q1?.activeSec).toBe(100);
    expect(anchored.byQuestion.q2?.activeSec).toBe(199);
    expect(anchored.byQuestion.q3).toBeUndefined();
    // 不知道受理时刻：退回首条 submit（保守）
    const blind = computeAttemptActivity(events);
    expect(blind.byQuestion.q1?.activeSec).toBe(100);
    expect(blind.byQuestion.q2).toBeUndefined();
    // 没有客户端 submit 事件（逐题提交协议 / 旧客户端）：按服务端接收时刻截止
    const noSubmit = computeAttemptActivity(
      [
        withServerTs(ev("question_focus", 0, "q1", "a"), 0),
        withServerTs(ev("answer_change", 10, "q1", "a"), 10),
        withServerTs(ev("question_blur", 50, "q1", "a"), 50),
        withServerTs(ev("question_focus", 60, "q2", "a"), 60),
        withServerTs(ev("question_blur", 90, "q2", "a"), 90),
        // 受理之后才到达服务端的事件不计
        withServerTs(ev("question_focus", 100, "q3", "a"), 200),
        withServerTs(ev("answer_change", 110, "q3", "a"), 200),
      ],
      { submittedAt: at(95) },
    );
    expect(noSubmit.byQuestion.q1?.activeSec).toBe(50);
    expect(noSubmit.byQuestion.q2?.observedSec).toBe(30);
    expect(noSubmit.byQuestion.q3).toBeUndefined();
  });

  it("审查 #100-03 复核：服务端直记的 hint_open 与 question_submit 同法归入会话，单设备不再出现「多端同开」与幻影时段", () => {
    const result = computeAttemptActivity([
      ev("question_focus", 0, "q1", "a"),
      ev("question_focus", 60, "q2", "a"),
      ev("question_blur", 120, "q2", "a"),
      // 服务端为 q1 / q2 记的 hint_open：服务器时钟略晚、无 viewId
      ev("hint_open", 30.5, "q1", null),
      ev("hint_open", 90.5, "q2", null),
    ]);
    expect(result.sessions).toBe(1);
    expect(result.concurrentSessionsMax).toBe(1);
    expect(result.unattributedSec).toBe(0);
    expect(result.byQuestion.q1).toEqual({
      activeSec: 60,
      observedSec: 0,
      actions: 1,
      viewed: true,
    });
    expect(result.byQuestion.q2).toEqual({
      activeSec: 60,
      observedSec: 0,
      actions: 1,
      viewed: true,
    });
  });

  it("审查 #100-03：服务端记录的 question_submit（无 viewId）并入最近聚焦该题的会话，标记该次聚焦有动作而不是另开一段", () => {
    const result = computeAttemptActivity([
      // 端 a：0–60 做 q1（只看），60–120 做 q2
      ev("question_focus", 0, "q1", "a"),
      ev("question_focus", 60, "q2", "a"),
      ev("question_blur", 120, "q2", "a"),
      // 服务端为 q1 记的逐题提交：时钟略晚于端 a 切到 q2 的时刻、没有 viewId
      ev("question_submit", 61, "q1", null),
    ]);
    expect(result.sessions).toBe(1);
    // q1 那次聚焦因提交而算有动作（60 秒 active），q2 的聚焦不被截断
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
    expect(result.unattributedSec).toBe(0);
  });

  it("审查 #100-03：多端时 question_submit 归到最近聚焦该题的那一端", () => {
    const result = computeAttemptActivity([
      ev("question_focus", 0, "q1", "a"),
      ev("question_blur", 100, "q1", "a"),
      ev("question_focus", 200, "q1", "b"),
      ev("question_submit", 230, "q1", null),
      ev("question_blur", 260, "q1", "b"),
    ]);
    expect(result.sessions).toBe(2);
    // a 的 0–100 只看（observed）；b 的 200–260 因提交算 active
    expect(result.byQuestion.q1).toEqual({
      activeSec: 60,
      observedSec: 100,
      actions: 1,
      viewed: true,
    });
    expect(result.unattributedSec).toBe(0);
  });

  it("审查 #100-04：「同开」按同时在线的会话峰值计，先后打开的多次会话不算同开", () => {
    const sequential = computeAttemptActivity([
      ev("question_focus", 0, "q1", "a"),
      ev("question_blur", 50, "q1", "a"),
      ev("question_focus", 100, "q1", "b"), // 刷新后的新会话
      ev("question_blur", 150, "q1", "b"),
      ev("question_focus", 200, "q2", "c"),
      ev("question_blur", 250, "q2", "c"),
    ]);
    expect(sequential.sessions).toBe(3);
    expect(sequential.concurrentSessionsMax).toBe(1);

    const overlapping = computeAttemptActivity([
      ev("question_focus", 0, "q1", "a"),
      ev("question_blur", 100, "q1", "a"),
      ev("question_focus", 50, "q2", "b"),
      ev("question_blur", 150, "q2", "b"),
      ev("question_focus", 60, "q3", "c"),
      ev("question_blur", 70, "q3", "c"),
    ]);
    expect(overlapping.sessions).toBe(3);
    expect(overlapping.concurrentSessionsMax).toBe(3);
    expect(overlapping.unattributedSec).toBe(50);
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
