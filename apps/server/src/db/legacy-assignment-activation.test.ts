import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, it } from "vitest";
import { saveDraftAnswer } from "../services/attempt-answer.ts";
import { getAttemptDetail } from "../services/attempt-detail.ts";
import { startAttempt } from "../services/attempt-start.ts";
import { runBackfills } from "./backfill.ts";
import { createDb } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { attempts, responses } from "./schema.ts";
import { makeMigrationsFolderUpTo } from "./test-utils.ts";

it("ACT07 官方0062旧库的单单元assignment迁移后入口/懒冻结/保存保持兼容", () => {
  const db = createDb(":memory:"),
    prefix = makeMigrationsFolderUpTo("0062_wise_lethal_legion");
  const studentId = randomUUID(),
    assignmentId = randomUUID(),
    attemptId = randomUUID(),
    teacherId = randomUUID();
  const at = "2026-11-01T00:00:00.000Z";
  try {
    db.$client.pragma("foreign_keys = OFF");
    migrate(db, { migrationsFolder: prefix });
    db.$client.pragma("foreign_keys = ON");
    db.$client
      .prepare("INSERT INTO teachers(id,login_name,created_at) VALUES(?,?,?)")
      .run(teacherId, teacherId, at);
    db.$client
      .prepare(
        "INSERT INTO students(id,teacher_id,display_name,login_name,link_token,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(studentId, teacherId, "遗留学生", studentId, studentId, at);
    db.$client
      .prepare(
        'INSERT INTO units(id,teacher_id,title,"order",updated_at) VALUES(?,?,?,0,?)',
      )
      .run("legacy-unit", teacherId, "遗留单元", at);
    db.$client
      .prepare(
        "INSERT INTO questions(id,teacher_id,unit_id,\"order\",type,difficulty,stem_md,hints_json,source_md,version,updated_at) VALUES(?,?,?,0,'judge',1,?,'[]',?,1,?)",
      )
      .run(
        "legacy-q",
        teacherId,
        "legacy-unit",
        "遗留题",
        "::::question{type=judge}\n遗留题\n::::",
        at,
      );
    db.$client
      .prepare(
        "INSERT INTO assignments(id,teacher_id,unit_id,title,created_at) VALUES(?,?,?,?,?)",
      )
      .run(assignmentId, teacherId, "legacy-unit", "遗留作业", at);
    db.$client
      .prepare(
        'INSERT INTO assignment_units(assignment_id,unit_id,"order") VALUES(?,?,0)',
      )
      .run(assignmentId, "legacy-unit");
    db.$client
      .prepare(
        "INSERT INTO assignment_students(assignment_id,student_id,added_at) VALUES(?,?,?)",
      )
      .run(assignmentId, studentId, at);
    db.$client
      .prepare(
        "INSERT INTO attempts(id,student_id,source_type,assignment_id,unit_id,status,started_at) VALUES(?,?,'assignment',?,?,'draft',?)",
      )
      .run(attemptId, studentId, assignmentId, "legacy-unit", at);
    runMigrations(db);
    runBackfills(db);
    expect(startAttempt(db, studentId, assignmentId)).toMatchObject({
      id: attemptId,
      unitId: null,
      phase: "opened",
    });
    const detail = getAttemptDetail(db, studentId, attemptId);
    expect(detail).toMatchObject({ legacyUnverified: true });
    saveDraftAnswer(db, studentId, attemptId, "legacy-q", {
      kind: "judge",
      value: true,
    });
    expect(
      db.select().from(attempts).where(eq(attempts.id, attemptId)).get(),
    ).toMatchObject({ unitId: "legacy-unit", legacyUnverified: true });
    expect(
      db
        .select()
        .from(responses)
        .where(eq(responses.attemptId, attemptId))
        .get()?.answerJson,
    ).toContain('"value":true');
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.$client.close();
    rmSync(prefix, { recursive: true, force: true });
  }
});
