import { renderHook } from "@testing-library/react";
import type { AttemptSummary } from "@tutor/contract";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AttemptSnapshotScope, useAttemptOpened } from "./AttemptSnapshotScope";

const opened = {
  id: "att-1",
  sourceType: "assignment",
  courseId: "course",
  unitId: null,
  assignmentId: "assignment",
  lectureId: null,
  status: "draft",
  phase: "opened",
  activatedAt: null,
  frozenAt: "2026-11-15T00:00:00.000Z",
  attemptNo: 1,
  startedAt: "2026-11-15T00:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
} satisfies AttemptSummary;

function scope(attempt: AttemptSummary) {
  return ({ children }: { children: ReactNode }) => (
    <AttemptSnapshotScope attempt={attempt}>{children}</AttemptSnapshotScope>
  );
}

describe("useAttemptOpened", () => {
  it("作答视图里的卷还没动过笔：是", () => {
    const { result } = renderHook(() => useAttemptOpened("att-1"), {
      wrapper: scope(opened),
    });
    expect(result.current).toBe(true);
  });

  it("动过笔的卷、旧接口没有阶段字段的卷：否", () => {
    const active = renderHook(() => useAttemptOpened("att-1"), {
      wrapper: scope({
        ...opened,
        phase: "active",
        activatedAt: "2026-11-15T00:01:00.000Z",
      }),
    });
    expect(active.result.current).toBe(false);
    const { phase: _phase, activatedAt: _activatedAt, ...legacy } = opened;
    const missing = renderHook(() => useAttemptOpened("att-1"), {
      wrapper: scope(legacy),
    });
    expect(missing.result.current).toBe(false);
  });

  it("卷号对不上、不在作答视图里：否", () => {
    const other = renderHook(() => useAttemptOpened("att-2"), {
      wrapper: scope(opened),
    });
    expect(other.result.current).toBe(false);
    const outside = renderHook(() => useAttemptOpened("att-1"));
    expect(outside.result.current).toBe(false);
  });
});
