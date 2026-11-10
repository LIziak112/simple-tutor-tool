import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import { createTestDb } from "../db/test-utils.ts";
import { makeStudent } from "../test/note-fixtures.ts";
import { listMemos } from "./memo-read.ts";
import { createTextMemo } from "./memo-service.ts";

/**
 * 随笔读侧（审查修复 #104-06）：标签筛选在 SQL 里做（json_each），不再「先截最近
 * 若干条再内存过滤」——稀疏标签的旧随笔也翻得到，多条命中时游标分页不重不漏。
 */

/** 连续 n 条文字随笔，第 i 条记录时间 = 基准日 + i 天（越大越新）；pick(i) 为真的带标签 */
function seed(
  db: Db,
  studentId: string,
  n: number,
  tag: string,
  pick: (i: number) => boolean,
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      createTextMemo(db, {
        studentId,
        clientId: randomUUID(),
        text: `第 ${i} 条`,
        tags: pick(i) ? [tag] : ["别的"],
        recordedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      }).memo.id,
    );
  }
  return ids;
}

describe("listMemos 标签筛选", () => {
  it("只有最旧一条带标签：limit=5 也能查到它（不受取样窗口限制）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const ids = seed(db, studentId, 30, "稀疏", (i) => i === 0);
    const page = listMemos(db, studentId, { tag: "稀疏", limit: 5 });
    expect(page.memos.map((memo) => memo.id)).toEqual([ids[0]]);
    expect(page.nextCursor).toBeNull();
  });

  it("多条命中：按记录时间倒序游标翻页不重不漏，末页游标为 null", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const ids = seed(db, studentId, 40, "偶数", (i) => i % 3 === 0); // 14 条命中
    const expected = ids.filter((_, i) => i % 3 === 0).reverse();

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = listMemos(db, studentId, {
        tag: "偶数",
        limit: 5,
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages += 1;
      seen.push(...page.memos.map((memo) => memo.id));
      for (const memo of page.memos) expect(memo.tags).toContain("偶数");
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
  });

  it("标签与形态 / 起始时间组合过滤仍生效；无命中返回空且游标为 null", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    seed(db, studentId, 10, "疑问", (i) => i >= 5);
    const since = listMemos(db, studentId, {
      tag: "疑问",
      kind: "text",
      since: new Date(Date.UTC(2026, 0, 9)).toISOString(),
    });
    expect(since.memos.map((memo) => memo.text)).toEqual([
      "第 9 条",
      "第 8 条",
    ]);
    expect(since.nextCursor).toBeNull();
    const none = listMemos(db, studentId, { tag: "没有这个标签" });
    expect(none.memos).toEqual([]);
    expect(none.nextCursor).toBeNull();
  });
});
