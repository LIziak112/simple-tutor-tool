import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceFlags } from "./use-workspace-flags";

let session: { origin: string; studentId: string } | null;
vi.mock("@/features/annotation/use-annotation-record", () => ({
  useAnnotationSessionRef: () => session,
}));
beforeEach(() => {
  localStorage.clear();
  session = { origin: "http://test", studentId: "student-a" };
});
describe("待检查标记隔离", () => {
  it("切换学生不串标记，重新进入原账号可恢复", () => {
    const { result, rerender, unmount } = renderHook(() =>
      useWorkspaceFlags("attempt-a"),
    );
    act(() => result.current.toggle("q1"));
    expect(result.current.flags.has("q1")).toBe(true);
    session = { origin: "http://test", studentId: "student-b" };
    rerender();
    expect(result.current.flags.size).toBe(0);
    act(() => result.current.toggle("q2"));
    session = { origin: "http://test", studentId: "student-a" };
    rerender();
    expect([...result.current.flags]).toEqual(["q1"]);
    unmount();
    expect(
      renderHook(() => useWorkspaceFlags("attempt-a")).result.current.flags.has(
        "q1",
      ),
    ).toBe(true);
  });
  it("部署与练习隔离，未绑定身份不写持久存储", () => {
    const { result, rerender } = renderHook(({ id }) => useWorkspaceFlags(id), {
      initialProps: { id: "a" },
    });
    act(() => result.current.toggle("q1"));
    rerender({ id: "b" });
    expect(result.current.flags.size).toBe(0);
    session = { origin: "http://other", studentId: "student-a" };
    rerender({ id: "a" });
    expect(result.current.flags.size).toBe(0);
    session = null;
    rerender({ id: "a" });
    act(() => result.current.toggle("q3"));
    expect(localStorage.length).toBe(1);
  });
});
