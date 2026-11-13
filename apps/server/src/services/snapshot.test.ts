import { questionSchema } from "@tutor/contract";
import { expect, it, vi } from "vitest";
import { createDb } from "../db/client.ts";
import { snapshotJsonOf } from "../test/evidence-fixtures.ts";

it("五百题反复汇总时只校验各份快照一次，修正快照后按新内容重验", () => {
  const db = createDb(":memory:");
  const parse = vi.spyOn(questionSchema, "safeParse");
  try {
    db.$client.exec(
      "CREATE TABLE snapshots (id INTEGER PRIMARY KEY, json TEXT)",
    );
    const insert = db.$client.prepare("INSERT INTO snapshots VALUES (?, ?)");
    for (let id = 1; id <= 500; id += 1) {
      insert.run(
        id,
        snapshotJsonOf({
          id: `q${id}`,
          stemMd: `题干 ${id} ${"正文".repeat(500)}`,
        }),
      );
    }
    parse.mockClear();
    const count = db.$client
      .prepare(
        "SELECT COUNT(*) FROM snapshots WHERE ownclass_question_snapshot_valid(json)",
      )
      .pluck();
    for (let submitted = 0; submitted < 20; submitted += 1) {
      expect(count.get()).toBe(500);
    }
    expect(parse).toHaveBeenCalledTimes(500);
    db.$client.prepare("UPDATE snapshots SET json = ? WHERE id = 1").run("{}");
    expect(count.get()).toBe(499);
    expect(parse).toHaveBeenCalledTimes(501);
  } finally {
    parse.mockRestore();
    db.$client.close();
  }
});
