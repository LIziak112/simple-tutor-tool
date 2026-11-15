import { rmSync } from "node:fs";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, it } from "vitest";
import { attemptTimeOf } from "../services/attempt-time-projection";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { makeMigrationsFolderUpTo } from "./test-utils";

it("正式迁移不升级旧draft、不改历史NULL/0或结算；重迁移幂等", () => {
  const db = createDb(":memory:");
  const prefix = makeMigrationsFolderUpTo("0068_attempt_settlement_guards");
  try {
    db.$client.pragma("foreign_keys = OFF");
    migrate(db, { migrationsFolder: prefix });
    db.$client.pragma("foreign_keys = ON");
    db.$client
      .prepare(
        "INSERT INTO teachers(id,login_name,created_at) VALUES('t','t','2026-01-01T00:00:00.000Z')",
      )
      .run();
    db.$client
      .prepare(
        "INSERT INTO students(id,teacher_id,display_name,login_name,link_token,created_at) VALUES('s','t','s','s','s','2026-01-01T00:00:00.000Z')",
      )
      .run();
    for (const [id, sec] of [
      ["null", null],
      ["zero", 0],
      ["draft", 7],
    ] as const)
      db.$client
        .prepare(
          "INSERT INTO attempts(id,student_id,source_type,attempt_no,status,started_at,active_sec) VALUES(?,'s','wrong',1,?,'2026-01-01T00:00:00.000Z',?)",
        )
        .run(id, id === "draft" ? "draft" : "graded", sec);
    db.$client
      .prepare(
        "INSERT INTO attempt_settlements(id,attempt_id,seq,kind,created_at,question_count,active_sec,mutation_id,request_digest) VALUES('old-final','zero',1,'final','2026-01-01T00:00:00.000Z',1,0,'old','old')",
      )
      .run();
    db.$client
      .prepare(
        "INSERT INTO responses(id,attempt_id,question_id,active_sec,settlement_seq) VALUES('old-response','zero','q',0,1)",
      )
      .run();
    const oldRows = db.$client.prepare("SELECT * FROM responses").all();
    const oldSettlements = db.$client
      .prepare("SELECT * FROM attempt_settlements")
      .all();
    const before = db.$client
      .prepare("SELECT * FROM attempts ORDER BY id")
      .all();
    const originalColumns = Object.keys(before[0] as Record<string, unknown>)
      .map((name) => `"${name}"`)
      .join(",");
    runMigrations(db);
    runMigrations(db);
    expect(
      db.$client
        .prepare(`SELECT ${originalColumns} FROM attempts ORDER BY id`)
        .all(),
    ).toEqual(before);
    expect(
      db.$client
        .prepare("SELECT activated_at FROM attempts ORDER BY id")
        .pluck()
        .all(),
    ).toEqual([null, null, null]);
    expect(db.$client.prepare("SELECT * FROM responses").all()).toEqual(
      oldRows,
    );
    expect(
      db.$client.prepare("SELECT * FROM attempt_settlements").all(),
    ).toEqual(oldSettlements);
    expect(
      db.$client.prepare("SELECT count(*) n FROM attempt_time_profiles").get(),
    ).toEqual({ n: 0 });
    expect(
      db.$client.prepare("SELECT count(*) n FROM response_time_ledger").get(),
    ).toEqual({ n: 0 });
    expect(attemptTimeOf(db, "draft").metric).toBe("legacy_focus");
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.$client.close();
    rmSync(prefix, { recursive: true, force: true });
  }
});
