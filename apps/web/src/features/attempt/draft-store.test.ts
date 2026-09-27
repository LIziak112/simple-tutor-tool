import type { InkDoc, StudentAnswer } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { digestOf } from "./draft-merge";
import {
  DRAFT_WRITE_DEBOUNCE_MS,
  draftStore,
  installDraftBackend,
  memoryBackend,
  type KVBackend,
} from "./draft-store";

/**
 * 草稿本地仓测试（T2.9）：读写/覆盖/清除/防抖写盘（fake timers + 注入内存后端，
 * jsdom 无 indexedDB，不引入 fake-indexeddb）。「重新进入页面」的读取路径用
 * 直接向后端写记录 + 全新 loadDraft（绕过内存缓存）模拟。
 */

const judge: StudentAnswer = { kind: "judge", value: true };
const judgeFalse: StudentAnswer = { kind: "judge", value: false };
const fill: StudentAnswer = { kind: "fill", values: ["4"] };

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
  it("防抖窗内的多次写入合并为一次底层 set，且落盘为最后值", async () => {
    draftStore.saveAnswer("att-1", "q1", judge);
    draftStore.saveAnswer("att-1", "q1", fill);
    draftStore.saveInk("att-1", "q2", doc(2));
    expect(backend.setCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_DEBOUNCE_MS);
    expect(backend.setCalls()).toHaveLength(1);
    const [, value] = backend.setCalls()[0] as [string, { answers: Record<string, StudentAnswer> }];
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
});

describe("applyServerDrafts（进入答题页合并）", () => {
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
});
