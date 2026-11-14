import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-utils";
import { makeStudent } from "../test/note-fixtures";
import { deleteMemo, listMemos } from "./memo-read";
import { createAgentMemo, createTextMemo } from "./memo-service";
import { memoTagSuggestions } from "./memo-tag-suggestions";

describe("随笔查找与派生", () => {
  it("按本人序号查找并隔离其他学习者", () => {
    const db = createTestDb();
    const a = makeStudent(db);
    const b = makeStudent(db);
    const own = createTextMemo(db, {
      studentId: a,
      clientId: randomUUID(),
      text: "本人",
    }).memo;
    createTextMemo(db, {
      studentId: b,
      clientId: randomUUID(),
      text: "秘密哨兵",
    });
    expect(listMemos(db, a, { seq: own.seq }).memos.map((m) => m.text)).toEqual(
      ["本人"],
    );
  });
  it("Agent 同 operationId 重试只追加一次且保留父序号，跨人父不可关联", () => {
    const db = createTestDb();
    const a = makeStudent(db);
    const b = makeStudent(db);
    createTextMemo(db, { studentId: a, clientId: randomUUID(), text: "原文" });
    const input = { text: "整理", operationId: randomUUID(), parentMemoSeq: 1 };
    const first = createAgentMemo(db, a, input);
    expect(createAgentMemo(db, a, input).id).toBe(first.id);
    expect(first.parentMemoSeq).toBe(1);
    expect(() => createAgentMemo(db, b, input)).toThrow();
    expect(listMemos(db, a, {}).memos).toHaveLength(2);
  });
  it("常用标签按全量本人活跃记录聚合，软删和他人标签不参与", () => {
    const db = createTestDb();
    const a = makeStudent(db);
    const b = makeStudent(db);
    const add = (studentId: string, tags: string[]) =>
      createTextMemo(db, {
        studentId,
        clientId: randomUUID(),
        text: "内容",
        tags,
      }).memo;
    add(a, ["疑问"]);
    add(a, ["疑问", "复习"]);
    const removed = add(a, ["删除标签"]);
    deleteMemo(db, a, removed.id);
    add(b, ["私密哨兵"]);
    expect(memoTagSuggestions(db, a)).toEqual(["疑问", "复习"]);
  });
  it("operationId 不可被另一内容复用", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const operationId = randomUUID();
    createAgentMemo(db, studentId, { operationId, text: "原操作" });
    expect(() =>
      createAgentMemo(db, studentId, { operationId, text: "不同内容" }),
    ).toThrow("幂等键已用于另一条随笔");
  });
});
