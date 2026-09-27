import type { InkDoc, StudentAnswer } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import type { AttemptDraftRecord } from "./draft-store";
import { digestOf, mergeAnswers, mergeInkDocs, unsyncedAnswerIds } from "./draft-merge";

/** 草稿合并纯函数测试（T2.9）：答案并集/冲突本地胜出、笔迹 updatedAt 新者胜、摘要稳定性 */

const judge: StudentAnswer = { kind: "judge", value: true };
const judgeFalse: StudentAnswer = { kind: "judge", value: false };
const fill: StudentAnswer = { kind: "fill", values: ["4"] };

function atramentDoc(strokes: number, updatedAt: number): InkDoc {
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
    updatedAt,
  };
}

describe("digestOf", () => {
  it("对象键序不影响摘要（稳定序列化）", () => {
    expect(digestOf({ a: 1, b: { d: 4, c: 3 } })).toBe(
      digestOf({ b: { c: 3, d: 4 }, a: 1 }),
    );
    expect(digestOf({ a: 1, b: 2 })).not.toBe(digestOf({ a: 2, b: 1 }));
  });
});

describe("mergeAnswers", () => {
  it("本地为 null（本机第一次进入）→ 直接采纳服务端，无需同步", () => {
    const { merged, needsSync } = mergeAnswers(null, { q1: judge, q2: fill });
    expect(merged).toEqual({ q1: judge, q2: fill });
    expect(needsSync).toEqual([]);
  });

  it("本地较新（内容不同）→ 逐题以本地为准并入待同步", () => {
    const { merged, needsSync } = mergeAnswers(
      { q1: judgeFalse },
      { q1: judge },
    );
    expect(merged.q1).toEqual(judgeFalse);
    expect(needsSync).toEqual(["q1"]);
  });

  it("服务端独有 + 本地独有的题都保留；本地独有的进待同步", () => {
    const { merged, needsSync } = mergeAnswers(
      { q2: fill },
      { q1: judge },
    );
    expect(merged).toEqual({ q1: judge, q2: fill });
    expect(needsSync).toEqual(["q2"]);
  });

  it("内容一致 → 不进待同步（相同内容不重复 PUT 的依据）", () => {
    const { merged, needsSync } = mergeAnswers({ q1: judge }, { q1: judge });
    expect(merged).toEqual({ q1: judge });
    expect(needsSync).toEqual([]);
  });
});

describe("mergeInkDocs", () => {
  it("两边都空 → none；一边空 → 取另一边（空侧视为更旧）", () => {
    expect(mergeInkDocs(null, null)).toEqual({
      doc: null,
      source: "none",
      differs: false,
    });
    const server = atramentDoc(2, 10);
    expect(mergeInkDocs(null, server)).toEqual({
      doc: server,
      source: "server",
      differs: false,
    });
    const local = atramentDoc(3, 20);
    expect(mergeInkDocs(local, null)).toEqual({
      doc: local,
      source: "local",
      differs: true,
    });
  });

  it("内容一致 → 取本地且无差异（不补传）", () => {
    const doc = atramentDoc(2, 10);
    const result = mergeInkDocs(doc, atramentDoc(2, 10));
    expect(result.source).toBe("local");
    expect(result.differs).toBe(false);
  });

  it("内容不同 → updatedAt 新者胜（本地新→local+differs；服务端新→server）", () => {
    // 本地笔画更多但 updatedAt 更旧 → 服务端胜（updatedAt 优先于笔画数）
    expect(mergeInkDocs(atramentDoc(3, 50), atramentDoc(2, 100)).source).toBe(
      "server",
    );
    const local = atramentDoc(2, 100);
    const server = atramentDoc(3, 50);
    const result = mergeInkDocs(local, server);
    expect(result.source).toBe("local");
    expect(result.differs).toBe(true);
  });

  it("updatedAt 相同 → 笔画多者胜（清空重写保守取多）", () => {
    const local = atramentDoc(5, 100);
    const server = atramentDoc(2, 100);
    expect(mergeInkDocs(local, server).source).toBe("local");
    expect(mergeInkDocs(server, local).source).toBe("server");
  });
});

describe("unsyncedAnswerIds", () => {
  it("内容与指纹一致的题不算未同步", () => {
    const record: AttemptDraftRecord = {
      answers: { q1: judge, q2: fill },
      inks: {},
      savedAt: 1,
      syncedAt: 1,
      answerDigests: { q1: digestOf(judge) },
      inkDigests: {},
    };
    expect(unsyncedAnswerIds(record)).toEqual(["q2"]);
  });
});
