import { expect, it, vi } from "vitest";
import {
  draftStore,
  getDraftPersistenceState,
  installDraftBackend,
  memoryBackend,
} from "./draft-store";
import {
  retryAttemptLocalPersistence,
  summarizeAttemptSaveStatus,
} from "./use-attempt-save-status";

const saved = {
  answer: { state: "saved" as const, savedAt: 0 },
  local: "saved" as const,
  online: true,
  inkDirty: false,
  notes: [],
  annotations: [],
};
it("四域均确认才显示全部保存；只有标画待传不能宣称云端已保存", () => {
  expect(summarizeAttemptSaveStatus(saved)).toBe("全部已保存");
  expect(
    summarizeAttemptSaveStatus({
      ...saved,
      annotations: [{ local: "saved", server: "dirty" }],
    }),
  ).toBe("已存本机，正在同步…");
  expect(summarizeAttemptSaveStatus({ ...saved, inkDirty: true })).toBe(
    "已存本机，正在同步…",
  );
});
it("重试按钮不能把仍失败的答案落盘宣称成功", async () => {
  const flush = vi.spyOn(draftStore, "flush").mockResolvedValue();
  await retryAttemptLocalPersistence("retry-empty", []);
  expect(flush).toHaveBeenCalledWith("retry-empty");
  expect(getDraftPersistenceState("retry-empty")).toBe("saved");
  flush.mockRestore();
  installDraftBackend({
    ...memoryBackend(),
    set: async () => {
      throw new Error("空间不足");
    },
  });
  draftStore.saveAnswer("retry-failed", "q", { kind: "judge", value: false });
  await expect(
    retryAttemptLocalPersistence("retry-failed", []),
  ).rejects.toThrow("本机答案保存失败");
  installDraftBackend(memoryBackend());
});
it("本地写失败优先于离线和服务端保存，不能冒称本机保存", () => {
  expect(
    summarizeAttemptSaveStatus({ ...saved, online: false, local: "failed" }),
  ).toBe("本机保存失败，请保持页面打开并重试");
  expect(
    summarizeAttemptSaveStatus({
      ...saved,
      annotations: [{ local: "failed", server: "synced" }],
    }),
  ).toBe("本机保存失败，请保持页面打开并重试");
});
it("离线、冲突、正在落盘分别显示，不混作已保存", () => {
  expect(
    summarizeAttemptSaveStatus({
      ...saved,
      online: false,
      notes: [{ local: "saved", server: "dirty" }],
    }),
  ).toBe("离线，已存本机");
  expect(
    summarizeAttemptSaveStatus({
      ...saved,
      notes: [{ local: "saved", server: "conflict" }],
    }),
  ).toBe("有稿件同步需处理，本机稿已保留");
  expect(summarizeAttemptSaveStatus({ ...saved, local: "saving" })).toBe(
    "正在保存到本机…",
  );
});
