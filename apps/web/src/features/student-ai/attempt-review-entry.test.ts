import type { AiAttemptReviewTaskPublic } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  ATTEMPT_REVIEW_PANEL_TARGET,
  attemptReviewEntryStateOf,
  attemptReviewEntryViewOf,
  attemptReviewHref,
  pickAttemptReviewTask,
} from "./attempt-review-entry";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";

const COUNTS: AiAttemptReviewTaskPublic["counts"] = {
  total: 27,
  correctCount: 20,
  incorrectCount: 6,
  unansweredCount: 1,
  pendingCount: 0,
  unknownAnswerCount: 0,
  hasAnswerCount: 26,
  missingAnswerCount: 1,
  gradedCount: 26,
  accuracyAmongGraded: 20 / 26,
};

const taskOf = (
  overrides: Partial<AiAttemptReviewTaskPublic>,
): AiAttemptReviewTaskPublic => ({
  id: TASK_ID,
  attemptId: ATTEMPT_ID,
  status: "created",
  purpose: "复盘",
  questionCount: 27,
  counts: COUNTS,
  snapshotVersion: "v",
  generation: 0,
  retryCount: 0,
  errorText: null,
  hasResult: false,
  openedAt: null,
  archivedAt: null,
  allowedActions: [],
  createdAt: "2026-11-12T17:11:55.000Z",
  updatedAt: "2026-11-12T17:11:55.000Z",
  ...overrides,
});

const viewOf = (
  task: AiAttemptReviewTaskPublic | undefined,
  counts: AiAttemptReviewTaskPublic["counts"] | null = null,
) => attemptReviewEntryViewOf(attemptReviewEntryStateOf(task, counts));

describe("整卷复盘入口状态", () => {
  it("无任务且服务端未放行预览 → 不可用，不给入口", () => {
    expect(attemptReviewEntryStateOf(undefined, null)).toEqual({
      kind: "unavailable",
    });
    expect(viewOf(undefined)).toBeNull();
  });

  it("首次发起：打开发起面板", () => {
    expect(viewOf(undefined, COUNTS)).toEqual({
      label: "整卷复盘",
      target: ATTEMPT_REVIEW_PANEL_TARGET,
      unread: false,
    });
  });

  it("等待领取 / 处理中：按钮文字直接报进度，点开只看进度面板", () => {
    expect(viewOf(taskOf({ status: "created" }))).toMatchObject({
      label: "整卷复盘 · 等待领取",
      target: ATTEMPT_REVIEW_PANEL_TARGET,
    });
    expect(viewOf(taskOf({ status: "claimed" }))).toMatchObject({
      label: "整卷复盘 · 处理中",
      target: ATTEMPT_REVIEW_PANEL_TARGET,
    });
  });

  it("报告已出未读：直达报告并标记未读", () => {
    expect(viewOf(taskOf({ status: "replied", hasResult: true }))).toEqual({
      label: "查看整卷复盘报告",
      target: TASK_ID,
      unread: true,
    });
  });

  it("已读后仍打开同一份报告", () => {
    expect(
      viewOf(
        taskOf({
          status: "replied",
          hasResult: true,
          openedAt: "2026-11-12T18:00:00.000Z",
        }),
      ),
    ).toEqual({
      label: "查看整卷复盘报告",
      target: TASK_ID,
      unread: false,
    });
  });

  it("存在旧报告时，入口优先打开最新任务", () => {
    const read = taskOf({
      status: "replied",
      hasResult: true,
      openedAt: "2026-11-12T18:00:00.000Z",
      updatedAt: "2026-11-12T17:30:00.000Z",
    });
    // 再发起一轮：新任务在途（等待领取 → 处理中）
    for (const status of ["created", "claimed"] as const) {
      const next = taskOf({
        id: "33333333-3333-4333-8333-333333333333",
        status,
        updatedAt: "2026-11-12T19:00:00.000Z",
      });
      expect(viewOf(pickAttemptReviewTask([read, next]))).toMatchObject({
        target: ATTEMPT_REVIEW_PANEL_TARGET,
      });
    }
    // 新报告出来（未读），并指向新报告
    const fresh = taskOf({
      id: "33333333-3333-4333-8333-333333333333",
      status: "replied",
      hasResult: true,
      openedAt: null,
      updatedAt: "2026-11-12T19:30:00.000Z",
    });
    expect(viewOf(pickAttemptReviewTask([read, fresh]))).toMatchObject({
      target: fresh.id,
      unread: true,
    });
  });

  it("暂停 / 失败：标「需处理」，进面板重试或取消", () => {
    for (const status of ["paused", "failed"] as const) {
      expect(viewOf(taskOf({ status }))).toEqual({
        label: "整卷复盘 · 需处理",
        target: ATTEMPT_REVIEW_PANEL_TARGET,
        unread: false,
      });
    }
  });

  it("有任务时不看预览计数：进行中的任务不会被「可发起」盖住", () => {
    expect(viewOf(taskOf({ status: "claimed" }), COUNTS)?.label).toBe(
      "整卷复盘 · 处理中",
    );
  });
});

describe("整卷复盘地址", () => {
  it("同一份报告只有一个地址：结果页 + aiReview=<任务 id>", () => {
    expect(attemptReviewHref(ATTEMPT_ID, TASK_ID)).toBe(
      `/s/attempts/${ATTEMPT_ID}?aiReview=${TASK_ID}`,
    );
    expect(attemptReviewHref(ATTEMPT_ID, ATTEMPT_REVIEW_PANEL_TARGET)).toBe(
      `/s/attempts/${ATTEMPT_ID}?aiReview=panel`,
    );
  });

  it("从别处进入时携带来源位置，目标页可「返回原页面」", () => {
    const href = attemptReviewHref(ATTEMPT_ID, TASK_ID, "/s/home?tab=records");
    const url = new URL(href, "https://student.invalid");
    expect(url.pathname).toBe(`/s/attempts/${ATTEMPT_ID}`);
    expect(url.searchParams.get("aiReview")).toBe(TASK_ID);
    expect(url.searchParams.get("aiFrom")).toBe("/s/home?tab=records");
  });
});
