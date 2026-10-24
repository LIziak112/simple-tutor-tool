import { expect, it, vi } from "vitest";
import {
  applyServerHead,
  installNoteBackend,
  memoryNoteBackend,
} from "@/features/notes/note-store";
import * as noteSync from "@/features/notes/note-sync";
import {
  draftStore,
  getDraftPersistenceState,
  installDraftBackend,
  memoryBackend,
} from "./draft-store";
import {
  readAttemptSaveDetails,
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
it("未确认恢复或恢复失败时不能显示全部已保存", () => {
  expect(
    summarizeAttemptSaveStatus({ ...saved, recovery: { state: "loading" } }),
  ).toBe("正在恢复作答与材料…");
  expect(
    summarizeAttemptSaveStatus({
      ...saved,
      recovery: { state: "failed", message: "读取失败" },
    }),
  ).toBe("作答材料恢复失败，请重试");
  expect(summarizeAttemptSaveStatus({ ...saved, answerConflict: true })).toBe(
    "有答案同步冲突，请选择保留版本",
  );
});
it("仅预取的空草稿壳不是已使用稿件，不污染保存详情", async () => {
  installNoteBackend(memoryNoteBackend());
  const session = { origin: "details-origin", studentId: "student" };
  const current = vi
    .spyOn(noteSync, "currentNoteSession")
    .mockReturnValue(session);
  try {
    await applyServerHead(
      session,
      { attemptId: "details-empty", questionId: "q", phase: "scratch" },
      {
        note: null,
        images: [],
        evidence: null,
        corrections: [],
        supplements: [],
      },
    );
    expect(readAttemptSaveDetails("details-empty", ["q"], new Map())).toEqual(
      [],
    );
  } finally {
    current.mockRestore();
    installNoteBackend(memoryNoteBackend());
  }
});
it("保存详情按题分域定位，不将pending答案或正式笔迹冒称已保存", async () => {
  installDraftBackend(memoryBackend());
  draftStore.saveAnswer("details", "q1", { kind: "judge", value: false });
  await draftStore.flush("details");
  const controllers = new Map([["q2", { isDirty: () => true }]]);
  expect(readAttemptSaveDetails("details", ["q1", "q2"], controllers)).toEqual([
    {
      questionId: "q1",
      questionNo: 1,
      answer: "等待同步",
      ink: "未使用",
      scratch: "未使用",
      annotation: "未使用",
    },
    {
      questionId: "q2",
      questionNo: 2,
      answer: "未填写",
      ink: "等待同步",
      scratch: "未使用",
      annotation: "未使用",
    },
  ]);
  await draftStore.markAnswerSynced("details", "q1", {
    kind: "judge",
    value: false,
  });
  expect(readAttemptSaveDetails("details", ["q1"], new Map())[0]?.answer).toBe(
    "已保存",
  );
  expect(readAttemptSaveDetails("details", ["another"], new Map())).toEqual([]);
  installDraftBackend(memoryBackend());
});
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
it("response 长文本作答未确认同步或恢复中时，不冒称全部已保存（QM-09 细项4/6）", async () => {
  installDraftBackend(memoryBackend());
  const answer = {
    kind: "response",
    title: "留住记忆，改善生活",
    body: "城市更新应当在保留与改善之间寻找平衡……",
  } as const;
  // 本机已写长文、尚未确认云端同步：保存详情按「等待同步」呈现
  draftStore.saveAnswer("resp-details", "q1", answer);
  await draftStore.flush("resp-details");
  expect(
    readAttemptSaveDetails("resp-details", ["q1"], new Map())[0]?.answer,
  ).toBe("等待同步");
  // 材料恢复进行中：摘要行是「正在恢复」，不是「全部已保存」
  expect(
    summarizeAttemptSaveStatus({ ...saved, recovery: { state: "loading" } }),
  ).toBe("正在恢复作答与材料…");
  // 确认同步（含恢复读回的完整长文）后才显示已保存
  const record = await draftStore.loadDraft("resp-details");
  expect(record?.answers.q1).toEqual(answer);
  await draftStore.markAnswerSynced("resp-details", "q1", answer);
  expect(
    readAttemptSaveDetails("resp-details", ["q1"], new Map())[0]?.answer,
  ).toBe("已保存");
  installDraftBackend(memoryBackend());
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
