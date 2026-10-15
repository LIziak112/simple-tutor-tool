import { fireEvent, render, screen } from "@testing-library/react";
import { memo } from "react";
import { expect, it, vi } from "vitest";
import {
  type DraftSyncApi,
  DraftSyncContext,
  DraftSyncProvider,
  useDraftSyncActions,
  useDraftSyncContext,
  useDraftSyncRecovery,
} from "./use-draft-sync";

function api(): DraftSyncApi {
  return {
    status: { state: "saved", savedAt: 1 },
    recoveredDrafts: {},
    recovery: { state: "ready" },
    noteLocalWrite: vi.fn(),
    noteAnswerSynced: vi.fn(),
    noteInkSynced: vi.fn(),
    noteSyncFailed: vi.fn(),
    noteDenied: vi.fn(),
    syncNow: vi.fn(async () => {}),
  };
}
it("保存状态只刷新完整订阅，不重渲染恢复状态与稳定操作消费者", () => {
  const recoveryRenders = vi.fn();
  const actionRenders = vi.fn();
  const Recovery = memo(() => {
    recoveryRenders();
    return <span>{useDraftSyncRecovery()?.state}</span>;
  });
  const Actions = memo(() => {
    actionRenders();
    const actions = useDraftSyncActions();
    return (
      <button type="button" onClick={actions?.noteLocalWrite}>
        落盘
      </button>
    );
  });
  const Status = memo(() => <span>{useDraftSyncContext()?.status.state}</span>);
  const base = api();
  const view = render(
    <DraftSyncProvider value={base}>
      <Recovery />
      <Actions />
      <Status />
    </DraftSyncProvider>,
  );
  view.rerender(
    <DraftSyncProvider value={{ ...base, status: { state: "saving" } }}>
      <Recovery />
      <Actions />
      <Status />
    </DraftSyncProvider>,
  );
  expect(screen.getByText("saving")).toBeInTheDocument();
  expect(recoveryRenders).toHaveBeenCalledTimes(1);
  expect(actionRenders).toHaveBeenCalledTimes(1);
  const updated = vi.fn();
  view.rerender(
    <DraftSyncProvider
      value={{
        ...base,
        recovery: { state: "failed", message: "读取失败" },
        noteLocalWrite: updated,
      }}
    >
      <Recovery />
      <Actions />
      <Status />
    </DraftSyncProvider>,
  );
  expect(screen.getByText("failed")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "落盘" }));
  expect(updated).toHaveBeenCalledOnce();
  expect(base.noteLocalWrite).not.toHaveBeenCalled();
});
it("旧 Provider 的恢复状态与操作仍兼容", () => {
  const base = api();
  function Consumer() {
    const recovery = useDraftSyncRecovery();
    const actions = useDraftSyncActions();
    return (
      <button type="button" onClick={actions?.noteLocalWrite}>
        {recovery?.state}
      </button>
    );
  }
  render(
    <DraftSyncContext.Provider value={base}>
      <Consumer />
    </DraftSyncContext.Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "ready" }));
  expect(base.noteLocalWrite).toHaveBeenCalledOnce();
});
