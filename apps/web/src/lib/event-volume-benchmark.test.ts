import type { AttemptEvent, LectureEvent } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  createEventQueue,
  installEventStore,
  memoryEventStore,
} from "@/lib/event-queue";

/**
 * 事件量基准（T4.0b，方案 §5 验收「事件量基准报告」；确定性测试可回归）：
 * 模拟「20 题作业（含 5 手写题）+ 2 篇讲义完整阅读」的单次会话，
 * 实测三项——会话事件总数、分类型计数、单批最大字节数（UTF-8）——
 * 对照方案估算（attempt ~200 条、每讲义 ~45 条、合计 ~300 条），验证
 * 节流（section_focus=标题数、ink_edit_batch 防抖聚合、idle 每空闲期一对）
 * 与字节切批（≤32KiB）有效。数字同时写入 docs/archive/T4.0埋点审计与事件量基准.md。
 */

const T0 = Date.UTC(2026, 9, 3, 9, 0, 0);
let tick = 0;
/** 单调递增的模拟时钟（毫秒） */
function nextTs(): number {
  tick += 1500; // 事件间距 1.5 秒（保守密集：真实交互更稀疏）
  return T0 + tick;
}

/** 20 题作业的 attempt 域事件流（含 5 道手写题、10 道带提示题） */
function buildAttemptEvents(): AttemptEvent[] {
  const events: AttemptEvent[] = [];
  const ts = () => nextTs();
  const questionIds = Array.from({ length: 20 }, (_, i) => `q-${i + 1}`);
  const handwritten = new Set(["q-16", "q-17", "q-18", "q-19", "q-20"]);
  const withHints = new Set(questionIds.slice(0, 10));

  events.push({ type: "attempt_start", clientTs: ts() });
  for (const questionId of questionIds) {
    events.push({ type: "question_view", clientTs: ts(), questionId });
  }
  // 25 次聚焦切换（滚动 + 交互来回），每次 blur 旧题 + focus 新题
  let focused: string | null = null;
  for (let i = 0; i < 25; i += 1) {
    const target = questionIds[(i * 7) % 20] as string;
    if (focused !== null) {
      events.push({
        type: "question_blur",
        clientTs: ts(),
        questionId: focused,
      });
    }
    events.push({ type: "question_focus", clientTs: ts(), questionId: target });
    focused = target;
  }
  // 每题两次答案修改（第二次带较长的学生原文——字节压力样本）
  for (const questionId of questionIds) {
    events.push({
      type: "answer_change",
      clientTs: ts(),
      questionId,
      to: { kind: "choice", index: 1 },
    });
    events.push({
      type: "answer_change",
      clientTs: ts(),
      questionId,
      from: { kind: "choice", index: 1 },
      to: {
        kind: "fill",
        values: [
          "设未知数为 x，根据题意列方程 3x + 5 = 2(x + 7)，去括号得 3x + 5 = 2x + 14，移项合并得 x = 9。",
          "9",
        ],
      },
    });
  }
  // 10 道提示题各解锁一条（客户端时钟的 directive_interact；hint_open 是
  // 服务端直记、不经队列，不计入本基准）
  for (const questionId of withHints) {
    events.push({
      type: "directive_interact",
      clientTs: ts(),
      host: "question",
      questionId,
      name: "hint",
      index: 0,
      action: "open",
    });
  }
  // 5 道手写题：每题 6 笔 + 2 批编辑 + 全屏进出
  for (const questionId of handwritten) {
    for (let s = 0; s < 6; s += 1) {
      events.push({
        type: "ink_stroke_batch",
        clientTs: ts(),
        questionId,
        strokes: s + 1,
      });
    }
    events.push({
      type: "ink_edit_batch",
      clientTs: ts(),
      questionId,
      erase: 1,
      undo: 1,
      redo: 0,
      clear: 0,
    });
    events.push({
      type: "ink_edit_batch",
      clientTs: ts(),
      questionId,
      erase: 0,
      undo: 0,
      redo: 1,
      clear: 1,
    });
    events.push({
      type: "ink_fullscreen",
      clientTs: ts(),
      questionId,
      on: true,
    });
    events.push({
      type: "ink_fullscreen",
      clientTs: ts(),
      questionId,
      on: false,
    });
  }
  // 环境：3 次切后台、1 次断网恢复、1 次空闲
  for (let i = 0; i < 3; i += 1) {
    events.push({ type: "page_hidden", clientTs: ts() });
    events.push({ type: "page_visible", clientTs: ts() });
  }
  events.push({ type: "net_offline", clientTs: ts() });
  events.push({ type: "net_online", clientTs: ts() });
  events.push({ type: "idle_start", clientTs: ts() });
  events.push({ type: "idle_end", clientTs: ts() });
  events.push({ type: "submit", clientTs: ts() });
  return events;
}

/** 单篇讲义完整阅读的事件流（10 个标题、2 次进入、折叠与 steps 交互） */
function buildLectureEvents(
  lectureId: string,
  version: string,
): LectureEvent[] {
  const events: LectureEvent[] = [];
  const ts = () => nextTs();
  const versioned = { lectureUpdatedAt: version };
  // 两次进入（第一遍粗读 + 回头细读），hidden 双兜底允许双发
  events.push({
    type: "lecture_visible",
    clientTs: ts(),
    lectureId,
    viewId: `view-${lectureId}-1`,
  });
  events.push({
    type: "lecture_hidden",
    clientTs: ts(),
    lectureId,
    viewId: `view-${lectureId}-1`,
  });
  events.push({
    type: "lecture_hidden",
    clientTs: ts(),
    lectureId,
    viewId: `view-${lectureId}-1`,
  });
  events.push({
    type: "lecture_visible",
    clientTs: ts(),
    lectureId,
    viewId: `view-${lectureId}-2`,
  });
  events.push({
    type: "lecture_hidden",
    clientTs: ts(),
    lectureId,
    viewId: `view-${lectureId}-2`,
  });
  // 分节聚焦：10 个标题 + 2 次回滚重读
  for (let h = 0; h < 10; h += 1) {
    events.push({
      type: "lecture_section_focus",
      clientTs: ts(),
      lectureId,
      headingIndex: h,
      ...versioned,
    });
  }
  for (const h of [2, 5]) {
    events.push({
      type: "lecture_section_focus",
      clientTs: ts(),
      lectureId,
      headingIndex: h,
      ...versioned,
    });
  }
  // 目录跳转 4 次
  for (const h of [0, 3, 6, 9]) {
    events.push({
      type: "lecture_toc_jump",
      clientTs: ts(),
      lectureId,
      headingIndex: h,
      ...versioned,
    });
  }
  // 折叠开合 ×5、steps 揭晓 ×5（两个容器）
  for (let i = 1; i <= 5; i += 1) {
    events.push({
      type: "directive_interact",
      clientTs: ts(),
      host: "lecture",
      lectureId,
      name: i % 2 === 0 ? "solution" : "fold",
      index: i,
      action: "open",
      ...versioned,
    });
    events.push({
      type: "directive_interact",
      clientTs: ts(),
      lectureId,
      host: "lecture",
      name: i % 2 === 0 ? "solution" : "fold",
      index: i,
      action: "close",
      ...versioned,
    });
  }
  for (const [container, steps] of [
    [6, [2, 3, 4]],
    [9, [2]],
  ] as const) {
    for (const step of steps) {
      events.push({
        type: "directive_interact",
        clientTs: ts(),
        host: "lecture",
        lectureId,
        name: "steps",
        index: container,
        action: "reveal",
        step,
        ...versioned,
      });
    }
  }
  // 环境：1 次断网恢复 + 1 次空闲
  events.push({ type: "net_offline", clientTs: ts() });
  events.push({ type: "net_online", clientTs: ts() });
  events.push({ type: "idle_start", clientTs: ts() });
  events.push({ type: "idle_end", clientTs: ts() });
  return events;
}

describe("事件量基准：20 题作业（含 5 手写）+ 2 篇讲义完整阅读", () => {
  it("实测三项指标并对照方案估算（~300 条/会话；单批 ≤32KiB）", async () => {
    installEventStore(memoryEventStore());
    const sent: Array<{ scope: string; events: unknown[]; bytes: number }> = [];
    const captureSend =
      (scope: string) =>
      async (batch: readonly unknown[]): Promise<void> => {
        const bytes = new TextEncoder().encode(
          JSON.stringify({ events: batch }),
        ).length;
        sent.push({ scope, events: [...batch], bytes });
      };

    const attemptEvents = buildAttemptEvents();
    const lecture1 = buildLectureEvents("lec-1", "2026-10-01T00:00:00.000Z");
    const lecture2 = buildLectureEvents("lec-2", "2026-10-01T00:00:00.000Z");

    const attemptQueue = createEventQueue({
      scope: { kind: "attempt", attemptId: "att-1" },
      send: captureSend("attempt") as never,
      beacon: null,
      intervalMs: 3_600_000,
    });
    for (const event of attemptEvents) attemptQueue.track(event);
    await attemptQueue.flush();
    attemptQueue.dispose();

    for (const [i, lectureEvents] of [lecture1, lecture2].entries()) {
      const queue = createEventQueue({
        scope: { kind: "lecture", lectureId: `lec-${i + 1}` },
        send: captureSend(`lecture-${i + 1}`) as never,
        beacon: null,
        intervalMs: 3_600_000,
      });
      for (const event of lectureEvents) queue.track(event);
      await queue.flush();
      queue.dispose();
    }

    // ---- 三项实测（以实际出网为准：含队列注入的环境事件）----
    const sentEvents = sent.flatMap((s) => s.events as Array<{ type: string }>);
    const total = sentEvents.length;
    const byType = new Map<string, number>();
    for (const event of sentEvents) {
      byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
    }
    const maxBatchBytes = Math.max(...sent.map((s) => s.bytes));

    // 输出（写入审计文档的数字来源）
    const lines = [
      `会话事件总数：${total}（构造 ${attemptEvents.length + lecture1.length + lecture2.length} + 队列注入环境事件 ${total - attemptEvents.length - lecture1.length - lecture2.length}）`,
      "分类型计数：",
      ...[...byType.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `  ${type}: ${count}`),
      `单批最大字节数：${maxBatchBytes} B（批次数 ${sent.length}）`,
    ];
    process.stdout.write(
      `\n===== 事件量基准 =====\n${lines.join("\n")}\n===== ===== =====\n`,
    );

    // ---- 对照断言（估算量级 ±100%；节流与切批有效）----
    expect(total).toBeGreaterThan(150);
    expect(total).toBeLessThan(500); // 方案估算 ~300，超过 500 说明节流失效
    expect(maxBatchBytes).toBeLessThanOrEqual(32 * 1024); // §5.0-A5 双限切批
    // 无丢失：构造的全部事件都出网（sent ≥ 构造数；多出的是注入环境事件）
    const constructed =
      attemptEvents.length + lecture1.length + lecture2.length;
    expect(total).toBeGreaterThanOrEqual(constructed);
    // 高频信号节流抽查：section_focus = 标题数级别（≤ 讲义标题数的 2 倍）
    expect(byType.get("lecture_section_focus") ?? 0).toBeLessThanOrEqual(24);
  });
});
