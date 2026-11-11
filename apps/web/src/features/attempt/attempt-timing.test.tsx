import { fireEvent, screen } from "@testing-library/react";
import type { AttemptDraftData, AttemptTiming } from "@tutor/contract";
import { describe, expect, it, vi } from "vitest";
import { fetchAttemptApi } from "@/lib/api";
import StudentAttemptPage from "@/pages/student/StudentAttemptPage";
import { renderWithStudentRoutes } from "@/test/student-routes";
import { clockOf, formatRemaining, formatTimeLimit } from "./attempt-clock";

/**
 * 限时测试（模块 2）前端：
 * - 时钟纯函数：阶段 / 剩余 / 宽限按服务端偏移算；
 * - 答题页：running 显示倒计时徽章；到时（grace / locked）出横幅、题卡只读、
 *   「确认交卷」打开既有交卷弹层；非限时卷零变化（无徽章无横幅）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAttemptApi: vi.fn(),
    fetchAttemptContextApi: vi.fn(async (attemptId: string) => ({
      attemptId,
      materials: [],
      groups: [],
    })),
    fetchAnnotationViewApi: vi.fn(async () => ({
      base: null,
      maxWidthPx: 1440,
      doc: null,
      annotation: null,
    })),
    fetchStudentNoteHeadsApi: vi.fn(),
  };
});

const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";

function draftWithTiming(timing: AttemptTiming | null): AttemptDraftData {
  return {
    attempt: {
      id: ATTEMPT_ID,
      sourceType: "course",
      assignmentId: null,
      lectureId: null,
      courseId: "12121212-1212-4121-8121-121212121212",
      unitId: "限时小练",
      attemptNo: 1,
      status: "draft",
      startedAt: "2026-11-09T10:00:00.000Z",
      submittedAt: null,
      scoreAuto: null,
      timeLimitSec: timing?.timeLimitSec ?? null,
      deadlineAt: timing?.deadlineAt ?? null,
    },
    title: "限时小练",
    courseName: "行测冲刺",
    dueAt: null,
    units: [
      {
        id: "限时小练",
        title: "限时小练",
        questions: [
          {
            id: "限时小练-1",
            type: "judge",
            difficulty: 1,
            knowledge: ["有理数的概念"],
            stemMd: "$0$ 既不是正数，也不是负数。[[]]",
            hintCount: 0,
            questionRevisionId: "rev-1",
          },
        ],
      },
    ],
    drafts: {},
    hintsOpened: {},
    legacyUnverified: false,
    answerRelease: "on_submit",
    enabledCapabilities: ["steps"],
    timing,
  };
}

function timingAt(deadlineOffsetMs: number): AttemptTiming {
  const now = Date.now();
  const deadlineAt = new Date(now + deadlineOffsetMs).toISOString();
  return {
    timeLimitSec: 1800,
    deadlineAt,
    serverNow: new Date(now).toISOString(),
    graceSec: 600,
    phase:
      deadlineOffsetMs > 0
        ? "running"
        : deadlineOffsetMs > -600_000
          ? "grace"
          : "locked",
  };
}

function renderPage(data: AttemptDraftData) {
  vi.mocked(fetchAttemptApi).mockResolvedValue(data);
  return renderWithStudentRoutes({
    initialPath: `/s/attempts/${ATTEMPT_ID}`,
    routePath: "/s/attempts/:attemptId",
    element: <StudentAttemptPage />,
  });
}

describe("attempt-clock 纯函数", () => {
  const base: AttemptTiming = {
    timeLimitSec: 1800,
    deadlineAt: "2026-11-09T10:30:00.000Z",
    serverNow: "2026-11-09T10:00:00.000Z",
    graceSec: 600,
    phase: "running",
  };
  it("按服务端偏移算剩余：本机快 5 分钟时仍以服务端为准", () => {
    const localNow = Date.parse("2026-11-09T10:05:00.000Z");
    // 本机比服务端快 5 分钟 → offset = -5min；服务端此刻 10:00，剩余 30 分钟
    const clock = clockOf(base, -5 * 60_000, localNow);
    expect(clock.phase).toBe("running");
    expect(clock.remainingMs).toBe(30 * 60_000);
    expect(clock.graceRemainingMs).toBe(600_000);
  });
  it("到时进入 grace，宽限剩余递减；宽限过后 locked 且两者为 0", () => {
    const grace = clockOf(base, 0, Date.parse("2026-11-09T10:33:00.000Z"));
    expect(grace.phase).toBe("grace");
    expect(grace.remainingMs).toBe(0);
    expect(grace.graceRemainingMs).toBe(7 * 60_000);
    const locked = clockOf(base, 0, Date.parse("2026-11-09T10:41:00.000Z"));
    expect(locked.phase).toBe("locked");
    expect(locked.graceRemainingMs).toBe(0);
  });
  it("格式化：mm:ss / h:mm:ss；时长 分钟 / 小时", () => {
    expect(formatRemaining(29 * 60_000 + 5_000)).toBe("29:05");
    expect(formatRemaining(3_600_000 + 61_000)).toBe("1:01:01");
    expect(formatRemaining(-1)).toBe("00:00");
    expect(formatTimeLimit(45 * 60)).toBe("45 分钟");
    expect(formatTimeLimit(120 * 60)).toBe("2 小时");
    expect(formatTimeLimit(150 * 60)).toBe("2 小时 30 分钟");
  });
});

describe("答题页 · 限时", () => {
  it("非限时卷：无倒计时徽章、无到时横幅（零变化）", async () => {
    renderPage(draftWithTiming(null));
    await screen.findByRole("button", { name: "交卷" });
    expect(screen.queryByTestId("attempt-countdown")).toBeNull();
    expect(screen.queryByTestId("attempt-time-up")).toBeNull();
    expect(screen.getByRole("radio", { name: "对" })).toBeEnabled();
  });

  it("running：头部显示剩余时间，题卡可作答", async () => {
    renderPage(draftWithTiming(timingAt(29 * 60_000 + 30_000)));
    await screen.findByRole("button", { name: "交卷" });
    expect(screen.getByTestId("attempt-countdown")).toHaveTextContent(
      /剩余 29:(29|30)/,
    );
    expect(screen.queryByTestId("attempt-time-up")).toBeNull();
    expect(screen.getByRole("radio", { name: "对" })).toBeEnabled();
  });

  it("grace：到时横幅「待确认交卷」+ 宽限剩余，题卡只读，「确认交卷」打开交卷弹层", async () => {
    renderPage(draftWithTiming(timingAt(-2 * 60_000)));
    const banner = await screen.findByTestId("attempt-time-up");
    expect(banner).toHaveTextContent("到时，待确认交卷");
    expect(banner).toHaveTextContent(/宽限还剩 0?7:5\d|宽限还剩 08:00/);
    expect(screen.getByTestId("attempt-countdown")).toHaveTextContent("已到时");
    expect(screen.getByRole("radio", { name: "对" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "确认交卷" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("locked：横幅说明宽限已过、只能交卷；题卡只读", async () => {
    renderPage(draftWithTiming(timingAt(-20 * 60_000)));
    const banner = await screen.findByTestId("attempt-time-up");
    expect(banner).toHaveTextContent("到时，宽限已过：只能交卷");
    expect(screen.getByRole("radio", { name: "对" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "确认交卷" })).toBeEnabled();
  });
});
