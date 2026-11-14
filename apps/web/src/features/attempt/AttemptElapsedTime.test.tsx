import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test/render-with-portal";
import { AttemptElapsedTime } from "./AttemptElapsedTime";

const fetchAttempt = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ fetchAttemptApi: fetchAttempt }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  fetchAttempt.mockReset();
});
it("隐藏偏好持久化，限时卷不显示也不轮询", async () => {
  fetchAttempt.mockResolvedValue({ timeEstimate: { activeSecTotal: 12 } });
  const view = render(
    <AttemptElapsedTime attemptId="a" time={undefined} timed={false} />,
  );
  await waitFor(() => expect(screen.getByText(/12 秒/)).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "隐藏用时" }));
  expect(screen.queryByText(/本次活动估计/)).toBeNull();
  expect(localStorage.getItem("attempt:show-activity-time")).toBe("off");
  view.unmount();
  fetchAttempt.mockClear();
  render(<AttemptElapsedTime attemptId="a" time={undefined} timed />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(fetchAttempt).not.toHaveBeenCalled();
});
it("卸载取消读取，不留下不受控轮询", () => {
  let signal: AbortSignal | undefined;
  fetchAttempt.mockImplementation((_id: string, s: AbortSignal) => {
    signal = s;
    return new Promise(() => {});
  });
  const view = render(
    <AttemptElapsedTime attemptId="a" time={undefined} timed={false} />,
  );
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
it("切换作答清空上一卷估计，讲练可先显示服务端首屏估计", async () => {
  fetchAttempt
    .mockResolvedValueOnce({ timeEstimate: { activeSecTotal: 12 } })
    .mockImplementation(() => new Promise(() => {}));
  const view = render(
    <AttemptElapsedTime attemptId="a" time={undefined} timed={false} />,
  );
  await screen.findByText(/12 秒/);
  view.rerender(
    <AttemptElapsedTime
      attemptId="b"
      time={undefined}
      timed={false}
      initialEstimate={{ activeSecTotal: 3 }}
    />,
  );
  await screen.findByText(/3 秒/);
  expect(screen.queryByText(/12 秒/)).toBeNull();
});
