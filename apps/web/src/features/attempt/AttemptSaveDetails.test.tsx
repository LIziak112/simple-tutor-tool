import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AttemptSaveDetails } from "./AttemptSaveDetails";
import { draftStore, installDraftBackend, memoryBackend } from "./draft-store";

it("详情可从问题题号定位，重试失败不关闭，保存文案不代替云端回执", async () => {
  installDraftBackend(memoryBackend());
  draftStore.saveAnswer("details-ui", "q", { kind: "judge", value: false });
  await draftStore.flush("details-ui");
  const jump = vi.fn().mockResolvedValue(undefined);
  const retry = vi.fn().mockRejectedValue(new Error("网络不可用"));
  render(
    <AttemptSaveDetails
      attemptId="details-ui"
      questionIds={["q"]}
      controllers={{ current: new Map() }}
      onJump={jump}
      onRetry={retry}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "保存详情" }));
  await screen.findByRole("dialog", { name: "保存详情" });
  expect(screen.getByRole("dialog")).toHaveTextContent("答案：等待同步");
  fireEvent.click(screen.getByRole("button", { name: "重试保存与同步" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("dialog")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "定位第 1 题" }));
  await waitFor(() => expect(jump).toHaveBeenCalledWith("q"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  installDraftBackend(memoryBackend());
});
it("关闭重开后，上一轮重试的迟到失败不能污染新详情", async () => {
  let reject: ((reason: Error) => void) | undefined;
  const retry = () =>
    new Promise<void>((_, fail) => {
      reject = fail;
    });
  render(
    <AttemptSaveDetails
      attemptId="late-details"
      questionIds={[]}
      controllers={{ current: new Map() }}
      onJump={async () => {}}
      onRetry={retry}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "保存详情" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "重试保存与同步" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "关闭弹层" }));
  fireEvent.click(screen.getByRole("button", { name: "保存详情" }));
  await screen.findByRole("dialog");
  await act(async () => reject?.(new Error("旧重试失败")));
  expect(screen.queryByRole("alert")).toBeNull();
});
