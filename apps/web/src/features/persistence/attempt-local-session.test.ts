import type { AttemptDraftData, AttemptSummary, InkDoc } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasSubstantiveDraft,
  migrateClearedDraft,
  protectOpenedDraft,
} from "./attempt-local-session";
import {
  installAttemptSessionBackend,
  readLocalAttemptSessions,
} from "./attempt-session-catalog";
import {
  bindDraftSession,
  draftStore,
  installDraftBackend,
  memoryBackend,
} from "./draft-store";

const attempt = {
  id: "old",
  sourceType: "course",
  courseId: "course",
  unitId: "unit",
  assignmentId: null,
  lectureId: null,
  status: "draft",
  phase: "opened",
  activatedAt: null,
  frozenAt: "2026-11-14T00:00:00.000Z",
  attemptNo: 1,
  startedAt: "2026-11-14T00:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
} satisfies AttemptSummary;
const originalDetail: AttemptDraftData = {
  attempt,
  title: "练习",
  courseName: "课程",
  dueAt: null,
  answerRelease: "on_submit",
  units: [],
  drafts: {},
  hintsOpened: {},
  legacyUnverified: false,
  enabledCapabilities: ["ink", "steps"],
};
const readOriginal = async () => originalDetail;
const ink = {
  engine: "atrament",
  version: 1,
  updatedAt: 1,
  data: {
    width: 1000,
    strokes: [
      {
        id: "s",
        color: "#000000",
        tool: "pen",
        weight: 2,
        points: [{ x: 1, y: 1, p: 0.5, t: 1 }],
      },
    ],
  },
} satisfies InkDoc;
beforeEach(() => {
  installDraftBackend(memoryBackend());
  installAttemptSessionBackend(memoryBackend());
  bindDraftSession({ origin: "test", studentId: "A" });
});

describe("清除后按内容版本恢复", () => {
  const previous = { attempt, questions: { q: 3 }, materials: ["m|1"] };
  const next = {
    attempt: { ...attempt, id: "new" },
    questions: { q: 3 },
    questionRevisions: { q: "new-row" },
  };
  const material = {
    id: "m",
    sourceVersion: 1,
    title: "材料",
    contentMd: "原材料",
    anchors: [],
    slots: [],
    mediaPaths: [],
  };
  const context = {
    attemptId: "new",
    materials: [material],
    groups: [],
  };
  it("真实落盘的答案、正式笔迹和材料圈画复制到新卷，原稿不删除且重建同步基线", async () => {
    draftStore.saveAnswer("old", "q", { kind: "judge", value: true });
    draftStore.saveInk("old", "q", ink);
    draftStore.saveMaterialInk("old", "m|1", ink);
    await draftStore.flush("old");
    const notice = await migrateClearedDraft(previous, next, context);
    const restored = await draftStore.loadDraft("new");
    expect(restored?.answers.q).toEqual({ kind: "judge", value: true });
    expect(restored?.inks.q).toEqual(ink);
    expect(restored?.materialInks?.["m|1"]).toEqual(ink);
    expect(restored?.answerDigests).toEqual({});
    expect(restored?.answerQuestionRevisions).toEqual({ q: "new-row" });
    expect(
      (await draftStore.loadDraft("old"))?.answerQuestionRevisions,
    ).toBeUndefined();
    expect((await draftStore.loadDraft("old"))?.materialInks?.["m|1"]).toEqual(
      ink,
    );
    expect(notice).toContain("恢复版本一致");
    expect((await readLocalAttemptSessions()).old?.migratedTo).toBe("new");
  });
  it.each(["question", "material", "unknown", "zero"])(
    "%s版本不一致或未知时保留原稿并提示，不挂到新版",
    async (kind) => {
      draftStore.saveAnswer("old", "q", { kind: "judge", value: true });
      draftStore.saveMaterialInk("old", "m|1", ink);
      await draftStore.flush("old");
      const old =
        kind === "unknown"
          ? { ...previous, questions: { q: null } }
          : kind === "zero"
            ? { ...previous, questions: { q: 0 } }
            : previous;
      const updated =
        kind === "question"
          ? { ...next, questions: { q: 4 } }
          : kind === "zero"
            ? { ...next, questions: { q: 0 } }
            : next;
      const updatedContext =
        kind === "material"
          ? {
              ...context,
              materials: [{ ...material, sourceVersion: 2 }],
            }
          : context;
      expect(await migrateClearedDraft(old, updated, updatedContext)).toContain(
        "旧本机原稿已保留",
      );
      expect(await draftStore.loadDraft("new")).toBeNull();
      expect((await draftStore.loadDraft("old"))?.answers.q).toEqual({
        kind: "judge",
        value: true,
      });
    },
  );
  it("目录和稿件按账号隔离，其他主体不能发现旧来源", async () => {
    draftStore.saveMaterialInk("old", "m|1", ink);
    await migrateClearedDraft(previous, next, context);
    bindDraftSession({ origin: "test", studentId: "B" });
    expect(await readLocalAttemptSessions()).toEqual({});
    expect(await draftStore.loadDraft("old")).toBeNull();
  });
});
describe("未激活本机稿保护", () => {
  it("空卷、展开材料和空笔迹不算实质动作", async () => {
    draftStore.saveMaterialInk("old", "m|1", {
      ...ink,
      data: { width: 1000, strokes: [] },
    });
    expect(hasSubstantiveDraft(await draftStore.loadDraft("old"))).toBe(false);
  });
  it("历史材料稿须先激活旧冻结卷，调用结束后才能start", async () => {
    draftStore.saveMaterialInk("old", "m|1", ink);
    await draftStore.flush("old");
    const activate = vi.fn().mockResolvedValue({});
    await protectOpenedDraft(attempt, activate, readOriginal);
    expect(activate).toHaveBeenCalledExactlyOnceWith("old", {
      expectedFrozenAt: attempt.frozenAt,
    });
  });
  it("没有新目录的历史旧键材料稿，经预检归属验证后迁入本主体并保护原卷", async () => {
    const backend = memoryBackend();
    installDraftBackend(backend);
    await backend.set("draft:old", {
      answers: {},
      inks: {},
      materialInks: { "m|1": ink },
      savedAt: 1,
      syncedAt: 0,
      answerDigests: {},
      inkDigests: {},
    });
    bindDraftSession({ origin: "test", studentId: "A" });
    const activate = vi.fn().mockResolvedValue({});
    await protectOpenedDraft(attempt, activate, readOriginal);
    expect(activate).toHaveBeenCalledTimes(1);
    expect((await draftStore.loadDraft("old"))?.materialInks?.["m|1"]).toEqual(
      ink,
    );
    expect(await backend.get("draft:old")).toBeDefined();
  });
  it("旧无目录稿已遭同id重冻时，不冒认预检的新token，隔离并保留下载凭据", async () => {
    draftStore.saveMaterialInk("old", "m|1", ink);
    const activate = vi.fn();
    await expect(
      protectOpenedDraft(
        { ...attempt, frozenAt: "2026-11-14T00:00:00.001Z" },
        activate,
        readOriginal,
      ),
    ).rejects.toThrow("旧本机原稿仍保留");
    expect(activate).not.toHaveBeenCalled();
    expect((await readLocalAttemptSessions()).old?.quarantined).toBe(true);
    expect((await draftStore.loadDraft("old"))?.materialInks?.["m|1"]).toEqual(
      ink,
    );
  });
  it("旧懒冻结未核实的题不能凭当前token激活冒认旧本机稿", async () => {
    draftStore.saveMaterialInk("old", "m|1", ink);
    const activate = vi.fn();
    await expect(
      protectOpenedDraft(attempt, activate, async () => ({
        ...originalDetail,
        legacyUnverified: true,
      })),
    ).rejects.toThrow("旧本机原稿仍保留");
    expect(activate).not.toHaveBeenCalled();
  });
  it("读盘期间A→B→A切换也不能用新账号发送激活", async () => {
    const store = memoryBackend();
    installDraftBackend(store);
    bindDraftSession({ origin: "test", studentId: "A" });
    let release!: (value: unknown) => void;
    store.get = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const activate = vi.fn();
    const task = protectOpenedDraft(attempt, activate);
    bindDraftSession({ origin: "test", studentId: "B" });
    bindDraftSession({ origin: "test", studentId: "A" });
    release({
      answers: {},
      inks: {},
      materialInks: { "m|1": ink },
      savedAt: 1,
      syncedAt: 0,
      answerDigests: {},
      inkDigests: {},
    });
    await expect(task).rejects.toThrow("会话已切换");
    expect(activate).not.toHaveBeenCalled();
  });
});
