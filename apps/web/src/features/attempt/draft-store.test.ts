import type { InkDoc, StudentAnswer } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { digestOf } from "./draft-merge";
import {
  bindDraftSession,
  DRAFT_WRITE_DEBOUNCE_MS,
  draftStore,
  getDraftPersistenceState,
  installDraftBackend,
  type KVBackend,
  memoryBackend,
} from "./draft-store";

it("同一题卷标识在不同学生会话中隔离，旧学生重登可恢复未同步稿", async () => {
  bindDraftSession({ origin: "https://tutor.test", studentId: "a" });
  draftStore.saveInk("same-attempt", "q", doc(2));
  await draftStore.flush("same-attempt");
  bindDraftSession({ origin: "https://tutor.test", studentId: "b" });
  expect(await draftStore.loadDraft("same-attempt")).toBeNull();
  bindDraftSession({ origin: "https://tutor.test", studentId: "a" });
  expect((await draftStore.loadDraft("same-attempt"))?.inks.q?.data).toEqual(
    doc(2).data,
  );
});

/**
 * 草稿本地仓测试（T2.9）：读写/覆盖/清除/防抖写盘（fake timers + 注入内存后端，
 * jsdom 无 indexedDB，不引入 fake-indexeddb）。「重新进入页面」的读取路径用
 * 直接向后端写记录 + 全新 loadDraft（绕过内存缓存）模拟。
 */

const judge: StudentAnswer = { kind: "judge", value: true };
const judgeFalse: StudentAnswer = { kind: "judge", value: false };
const fill: StudentAnswer = { kind: "fill", values: ["4"] };

it("导出严格读取本机稿时，存储失败不能被当作无稿", async () => {
  installDraftBackend({
    ...memoryBackend(),
    get: async () => {
      throw new Error("读取失败");
    },
  });
  await expect(
    draftStore.loadDraft("export-read", { strictRead: true }),
  ).rejects.toThrow("读取失败");
});

function doc(strokes: number): InkDoc {
  return {
    engine: "atrament",
    version: 1,
    data: {
      width: 1000,
      strokes: Array.from({ length: strokes }, () => ({
        tool: "pen" as const,
        color: "#000",
        weight: 4,
        points: [{ x: 1, y: 1, p: 0.5, t: 0 }],
      })),
    },
    updatedAt: 1,
  };
}

/** 带调用记录的内存后端 */
function spyBackend(): KVBackend & { setCalls: () => unknown[][] } {
  const inner = memoryBackend();
  const setSpy = vi.fn(inner.set);
  return {
    get: inner.get,
    set: setSpy,
    del: inner.del,
    setCalls: () => setSpy.mock.calls,
  };
}

let backend: ReturnType<typeof spyBackend>;

beforeEach(() => {
  vi.useFakeTimers();
  backend = spyBackend();
  installDraftBackend(backend);
});

describe("写盘防抖", () => {
  it("本机写失败可观察，不把内存稿冒称落盘；成功重试清错误", async () => {
    const set = vi.fn<KVBackend["set"]>(async () => {
      throw new Error("空间不足");
    });
    installDraftBackend({ ...backend, set });
    expect(getDraftPersistenceState("att-1")).toBe("saved");
    draftStore.saveAnswer("att-1", "q1", judge);
    expect(getDraftPersistenceState("att-1")).toBe("saving");
    await draftStore.flush("att-1");
    expect(getDraftPersistenceState("att-1")).toBe("failed");
    expect((await draftStore.loadDraft("att-1"))?.answers.q1).toEqual(judge);
    set.mockImplementation(backend.set);
    await draftStore.flush("att-1");
    expect(getDraftPersistenceState("att-1")).toBe("saved");
  });
  it("防抖窗内的多次写入合并为一次底层 set，且落盘为最后值", async () => {
    draftStore.saveAnswer("att-1", "q1", judge);
    draftStore.saveAnswer("att-1", "q1", fill);
    draftStore.saveInk("att-1", "q2", doc(2));
    expect(backend.setCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_DEBOUNCE_MS);
    expect(backend.setCalls()).toHaveLength(1);
    const [, value] = backend.setCalls()[0] as [
      string,
      { answers: Record<string, StudentAnswer> },
    ];
    expect(value.answers.q1).toEqual(fill);
  });

  it("loadDraft 内存优先：写入后未落盘也能读到最新值", async () => {
    draftStore.saveAnswer("att-1", "q1", judge);
    const record = await draftStore.loadDraft("att-1");
    expect(record?.answers.q1).toEqual(judge);
    expect(record?.savedAt).toBeGreaterThan(0);
  });

  it("重新进入页面（后端有记录、内存为空）→ loadDraft 回源读到并建立缓存", async () => {
    await backend.set("draft:att-1", {
      answers: { q1: fill },
      inks: {},
      savedAt: 5,
      syncedAt: 4,
      answerDigests: {},
      inkDigests: {},
    });
    const record = await draftStore.loadDraft("att-1");
    expect(record?.answers.q1).toEqual(fill);
    expect(record?.savedAt).toBe(5);
  });

  it("旧格式记录缺字段时防御性补齐（前向兼容）", async () => {
    await backend.set("draft:att-1", { answers: { q1: fill } });
    const record = await draftStore.loadDraft("att-1");
    expect(record).toMatchObject({
      answers: { q1: fill },
      inks: {},
      answerDigests: {},
      inkDigests: {},
    });
  });
});

describe("clearDraft", () => {
  it("交卷后清除：内存与底层都删；防抖未触发的落盘不会复活记录", async () => {
    draftStore.saveAnswer("att-1", "q1", judge);
    await draftStore.clearDraft("att-1");
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_DEBOUNCE_MS);
    expect(await draftStore.loadDraft("att-1")).toBeNull();
    expect(await backend.get("draft:att-1")).toBeUndefined();
  });
});

describe("同步指纹", () => {
  it("旧答案上传回执只更新已传指纹，不能覆写期间新输入", async () => {
    draftStore.saveAnswer("late-answer", "q", { kind: "fill", values: ["7"] });
    await draftStore.markAnswerSynced("late-answer", "q", {
      kind: "fill",
      values: ["6"],
    });
    expect((await draftStore.loadDraft("late-answer"))?.answers.q).toEqual({
      kind: "fill",
      values: ["7"],
    });
    expect(draftStore.getSaveFlags("late-answer", "q").answerPending).toBe(
      true,
    );
  });
  it("markAnswerSynced 后该题不再算未同步；markSynced 推进 syncedAt", async () => {
    draftStore.saveAnswer("att-1", "q1", judge);
    await draftStore.markAnswerSynced("att-1", "q1", judge);
    const record = await draftStore.loadDraft("att-1");
    expect(record?.answerDigests.q1).toBe(digestOf(judge));
    expect(record?.syncedAt).toBe(0); // 尚未调用 markSynced
    await draftStore.markSynced("att-1");
    const synced = await draftStore.loadDraft("att-1");
    expect(synced?.syncedAt).toBeGreaterThan(0);
  });

  it("仍有未同步内容时 markSynced 不推进 syncedAt", async () => {
    draftStore.saveAnswer("att-1", "q1", judge);
    draftStore.saveAnswer("att-1", "q2", fill);
    await draftStore.markAnswerSynced("att-1", "q1", judge);
    await draftStore.markSynced("att-1");
    const record = await draftStore.loadDraft("att-1");
    expect(record?.syncedAt).toBe(0);
  });

  it("markInkSynced 记录笔迹内容与指纹", async () => {
    draftStore.saveInk("att-1", "q2", doc(2));
    await draftStore.markInkSynced("att-1", "q2", doc(2));
    const record = await draftStore.loadDraft("att-1");
    expect(record?.inkDigests.q2).toBe(digestOf(doc(2)));
  });

  it("旧稿上传回执不能覆盖在途期间写入的新版正文", async () => {
    draftStore.saveInk("att-1", "q2", doc(3));
    await draftStore.markInkSynced("att-1", "q2", doc(2));
    const record = await draftStore.loadDraft("att-1");
    expect(record?.inks.q2?.data).toEqual(doc(3).data);
  });
});

describe("applyServerDrafts（进入答题页合并）", () => {
  it("迟到的旧云端读取不得覆盖已确认的新答案或倒退版本", async () => {
    await draftStore.applyServerDrafts("late-read", { q1: judge }, { q1: 1 });
    draftStore.saveAnswer("late-read", "q1", judgeFalse);
    await draftStore.markAnswerSynced("late-read", "q1", judgeFalse, 2);
    await draftStore.applyServerDrafts("late-read", { q1: judge }, { q1: 1 });
    const record = await draftStore.loadDraft("late-read");
    expect(record?.answers.q1).toEqual(judgeFalse);
    expect(record?.answerRevisions?.q1).toBe(2);
  });
  it("同题分歧只裁决该题，未冲突题并集不丢失", async () => {
    await draftStore.applyServerDrafts(
      "conflict",
      { q1: judge },
      { q1: 1, q2: 0, q3: 0 },
    );
    draftStore.saveAnswer("conflict", "q1", judgeFalse);
    draftStore.saveAnswer("conflict", "q2", fill);
    await draftStore.applyServerDrafts(
      "conflict",
      { q1: fill, q3: judge },
      { q1: 2, q2: 0, q3: 1 },
    );
    expect(
      (await draftStore.loadDraft("conflict"))?.answerConflicts?.q1?.revision,
    ).toBe(2);
    await draftStore.resolveAnswerConflict("conflict", "q1", "cloud");
    expect(draftStore.peekAnswers("conflict")).toEqual({
      q1: fill,
      q2: fill,
      q3: judge,
    });
  });
  it("已同步旧缓存采纳新云端答案，不回传旧空稿；不相交题目默认合并", async () => {
    draftStore.saveAnswer("merge-devices", "q1", {
      kind: "fill",
      values: [""],
    });
    await draftStore.markAnswerSynced("merge-devices", "q1", {
      kind: "fill",
      values: [""],
    });
    draftStore.saveAnswer("merge-devices", "q21", judge);
    const merged = await draftStore.applyServerDrafts("merge-devices", {
      q1: { kind: "fill", values: ["1"] },
      q20: judge,
    });
    expect(merged.q1).toEqual({ kind: "fill", values: ["1"] });
    expect(merged.q20).toEqual(judge);
    expect(merged.q21).toEqual(judge);
  });
  it("本地为空 + 服务端有草稿 → 采纳服务端且全部视为已同步", async () => {
    const merged = await draftStore.applyServerDrafts("att-1", { q1: judge });
    expect(merged).toEqual({ q1: judge });
    const record = await draftStore.loadDraft("att-1");
    expect(record?.answerDigests.q1).toBe(digestOf(judge));
  });

  it("两边都空 → 不建记录（首次进入且未作答）", async () => {
    const merged = await draftStore.applyServerDrafts("att-1", {});
    expect(merged).toEqual({});
    expect(await draftStore.loadDraft("att-1")).toBeNull();
  });

  it("本地较新 → 合并保留本地且留在未同步集合（触发补传）", async () => {
    draftStore.saveAnswer("att-1", "q1", judgeFalse);
    const merged = await draftStore.applyServerDrafts("att-1", { q1: judge });
    expect(merged.q1).toEqual(judgeFalse);
    const record = await draftStore.loadDraft("att-1");
    expect(record?.answerDigests.q1).toBe(digestOf(judge)); // 指纹=服务端内容
  });

  it("材料手写笔迹存取与跨题共享（合并存储到 attempt 草稿）", async () => {
    bindDraftSession({ origin: "https://tutor.test", studentId: "s-mat" });
    const inkDoc = doc(3);
    draftStore.saveMaterialInk("att-mat", "mat-1", inkDoc);
    expect(draftStore.getMaterialInk("att-mat", "mat-1")?.data).toEqual(
      inkDoc.data,
    );
    expect(draftStore.peekMaterialInks("att-mat")?.["mat-1"]?.data).toEqual(
      inkDoc.data,
    );

    await draftStore.flush("att-mat");
    const loaded = await draftStore.loadDraft("att-mat");
    expect(loaded?.materialInks?.["mat-1"]?.data).toEqual(inkDoc.data);

    // 换账号隔离
    bindDraftSession({ origin: "https://tutor.test", studentId: "s-other" });
    expect(await draftStore.loadDraft("att-mat")).toBeNull();
    expect(draftStore.getMaterialInk("att-mat", "mat-1")).toBeNull();

    // 恢复原账号
    bindDraftSession({ origin: "https://tutor.test", studentId: "s-mat" });
    const restored = await draftStore.loadDraft("att-mat");
    expect(restored?.materialInks?.["mat-1"]?.data).toEqual(inkDoc.data);
    expect(draftStore.getMaterialInk("att-mat", "mat-1")?.data).toEqual(
      inkDoc.data,
    );
  });
});
