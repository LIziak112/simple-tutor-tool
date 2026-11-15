import { beforeEach, expect, it, vi } from "vitest";
import {
  assertLoadedDraftsForPwaUpdate,
  bindDraftSession,
  draftStore,
  getDraftSessionEpoch,
  installDraftBackend,
  memoryBackend,
} from "@/features/persistence/draft-store";
import { prepareDraftForPwaUpdate } from "@/features/persistence/pwa-draft-safety";

beforeEach(() => installDraftBackend(memoryBackend()));

it("更新必须等最后一笔收笔与本机写盘成功，不能只等触发保存", async () => {
  const backend = memoryBackend();
  let finishWrite = () => {};
  const written = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  const set = vi.fn(async (key: string, value: unknown) => {
    await written;
    await backend.set(key, value);
  });
  installDraftBackend({ ...backend, set });
  let completed = false;
  const preparing = prepareDraftForPwaUpdate("attempt", async () => {
    draftStore.saveAnswer("attempt", "q", {
      kind: "fill",
      values: ["最后输入"],
    });
  }).then(() => {
    completed = true;
  });
  await vi.waitFor(() => expect(set).toHaveBeenCalled());
  expect(completed).toBe(false);
  finishWrite();
  await preparing;
  expect((await draftStore.loadDraft("attempt"))?.answers.q).toEqual({
    kind: "fill",
    values: ["最后输入"],
  });
});

it("本机写入失败即使flush正常返回也阻止更新并保留内存稿", async () => {
  installDraftBackend({
    ...memoryBackend(),
    set: async () => {
      throw new Error("磁盘已满");
    },
  });
  await expect(
    prepareDraftForPwaUpdate("attempt", async () => {
      draftStore.saveAnswer("attempt", "q", { kind: "judge", value: true });
    }),
  ).rejects.toThrow("本机");
  expect((await draftStore.loadDraft("attempt"))?.answers.q).toEqual({
    kind: "judge",
    value: true,
  });
});

it("本机读取失败不能被当作没有稿件", async () => {
  installDraftBackend({
    ...memoryBackend(),
    get: async () => {
      throw new Error("读取失败");
    },
  });
  await expect(
    prepareDraftForPwaUpdate("attempt", async () => {}),
  ).rejects.toThrow("读取失败");
});

it("等待保存期间切换账号时，旧完成回执不能放行更新", async () => {
  const originalEpoch = getDraftSessionEpoch();
  await expect(
    prepareDraftForPwaUpdate("attempt", async () => {
      bindDraftSession({ origin: "https://test", studentId: "other" });
    }),
  ).rejects.toThrow("会话");
  expect(getDraftSessionEpoch()).not.toBe(originalEpoch);
});

it("要求追平答案时，仍有待传答案不得更新", async () => {
  draftStore.saveAnswer("attempt", "q", { kind: "judge", value: false });
  await expect(
    prepareDraftForPwaUpdate("attempt", async () => {}, true),
  ).rejects.toThrow("同步");
  await draftStore.markAnswerSynced("attempt", "q", {
    kind: "judge",
    value: false,
  });
  await expect(
    prepareDraftForPwaUpdate("attempt", async () => {}, true),
  ).resolves.toBeUndefined();
});

it("已经卸载的作答稿仍须落盘并追平，不能因页面guard注销而漏掉", async () => {
  draftStore.saveAnswer("previous-attempt", "q", {
    kind: "judge",
    value: true,
  });
  await expect(assertLoadedDraftsForPwaUpdate()).rejects.toThrow("同步");
  await draftStore.markAnswerSynced("previous-attempt", "q", {
    kind: "judge",
    value: true,
  });
  await expect(assertLoadedDraftsForPwaUpdate()).resolves.toBeUndefined();
});
