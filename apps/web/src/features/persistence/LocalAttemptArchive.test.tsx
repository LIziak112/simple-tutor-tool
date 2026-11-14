import { fireEvent, render, screen } from "@testing-library/react";
import type { AttemptSummary } from "@tutor/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  installAttemptSessionBackend,
  saveLocalAttemptSession,
} from "./attempt-session-catalog";
import {
  bindDraftSession,
  draftStore,
  getDraftSessionEpoch,
  installDraftBackend,
  memoryBackend,
} from "./draft-store";
import {
  DownloadLocalAttempt,
  localAttemptArchive,
} from "./LocalAttemptArchive";

const attempt: AttemptSummary = {
  id: "old",
  sourceType: "course",
  courseId: "c",
  unitId: "u",
  assignmentId: null,
  lectureId: null,
  status: "draft",
  phase: "opened",
  activatedAt: null,
  frozenAt: null,
  attemptNo: 1,
  startedAt: "now",
  submittedAt: null,
  scoreAuto: null,
};
beforeEach(async () => {
  installDraftBackend(memoryBackend());
  installAttemptSessionBackend(memoryBackend());
  bindDraftSession({ origin: "test", studentId: "A" });
  await saveLocalAttemptSession({ attempt, questions: {}, materials: [] });
});
afterEach(() => vi.unstubAllGlobals());
it("原稿下载只读本人已确认的目录与本机正文，原记录仍在", async () => {
  draftStore.saveAnswer("old", "q", { kind: "judge", value: true });
  const archive = await localAttemptArchive("old", getDraftSessionEpoch());
  expect(JSON.parse(await archive.text())).toMatchObject({
    format: "ownclass-local-attempt-v1",
    draft: { answers: { q: { kind: "judge", value: true } } },
  });
  expect((await draftStore.loadDraft("old"))?.answers.q).toEqual({
    kind: "judge",
    value: true,
  });
});
it("A→B→A切换后旧下载任务拒绝，不生成新的主体blob", async () => {
  const epoch = getDraftSessionEpoch();
  bindDraftSession({ origin: "test", studentId: "B" });
  bindDraftSession({ origin: "test", studentId: "A" });
  await expect(localAttemptArchive("old", epoch)).rejects.toThrow("会话已切换");
  bindDraftSession({ origin: "test", studentId: "B" });
  await expect(
    localAttemptArchive("old", getDraftSessionEpoch()),
  ).rejects.toThrow("当前账号无法读取");
});
it("账号变更后保留在旧UI中的按钮禁用，不创建下载链接", () => {
  const create = vi.fn();
  const NativeUrl = URL;
  vi.stubGlobal(
    "URL",
    class extends NativeUrl {
      static override createObjectURL = create;
      static override revokeObjectURL = vi.fn();
    },
  );
  const view = render(<DownloadLocalAttempt attemptId="old" />);
  bindDraftSession({ origin: "test", studentId: "B" });
  view.rerender(<DownloadLocalAttempt attemptId="old" />);
  const button = screen.getByRole("button", { name: "下载本机原稿" });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(create).not.toHaveBeenCalled();
});
