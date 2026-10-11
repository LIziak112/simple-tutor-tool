import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRecordsReadingPosition } from "./use-records-reading-position";

vi.mock("@/features/notes/use-note-head", () => ({
  useNoteSessionRef: () => ({ origin: "http://test", studentId: "student" }),
}));
const search = new URLSearchParams("status=graded");
const key =
  'records-reading:["http://test","student","/s/records?status=graded"]';
function Fixture() {
  const remember = useRecordsReadingPosition(search, true);
  return (
    <button
      data-record-attempt="attempt"
      onClick={() => remember("attempt")}
      type="button"
    >
      记录
    </button>
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
it("保存的列表位置按学生与筛选隔离，不存答案", () => {
  render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "记录" }));
  expect(sessionStorage.getItem(key)).toBe("attempt");
});
it("恢复目记录，学生开始滚动后不抢位", () => {
  sessionStorage.setItem(key, "attempt");
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  render(<Fixture />);
  const scroll = vi.fn();
  screen.getByRole("button", { name: "记录" }).scrollIntoView = scroll;
  fireEvent.wheel(window);
  act(() => {
    while (frames.length) frames.shift()?.(0);
  });
  expect(scroll).not.toHaveBeenCalled();
});
