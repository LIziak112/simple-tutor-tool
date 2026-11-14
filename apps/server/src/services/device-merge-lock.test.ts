import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { expect, it } from "vitest";
import * as schema from "../db/schema.ts";
import { createTestDb } from "../db/test-utils.ts";
import { makeStudent } from "../test/note-fixtures.ts";
import { mergeDevices, registerDevice } from "./device-service.ts";

it("首次设备读取前已持有写锁，竞争连接不能改变确认的目标", () => {
  const template = createTestDb();
  const owner = { type: "student" as const, id: makeStudent(template) };
  const source = randomUUID();
  const target = randomUUID();
  const third = randomUUID();
  for (const deviceId of [source, target, third])
    registerDevice(template, owner, { deviceId, type: "desktop" });
  const dir = mkdtempSync(join(tmpdir(), "device-merge-lock-"));
  const filename = join(dir, "fixture.db");
  writeFileSync(filename, template.$client.serialize());
  template.$client.close();
  const competitor = new Database(filename, { timeout: 0 });
  competitor.pragma("journal_mode = WAL");
  let attempted = false;
  let blocked = false;
  const connection = new Database(filename, {
    verbose(statement) {
      if (
        !attempted &&
        typeof statement === "string" &&
        /^select /i.test(statement) &&
        statement.includes('"devices"')
      ) {
        attempted = true;
        try {
          competitor
            .prepare(
              "update devices set merged_into_id = ? where subject_type = ? and subject_id = ? and device_id = ?",
            )
            .run(third, owner.type, owner.id, target);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "SQLITE_BUSY"
          )
            blocked = true;
          else throw error;
        }
      }
    },
  });
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  try {
    const db = drizzle(connection, { schema });
    const dto = mergeDevices(db, owner, source, target, {
      sourceDeviceId: source,
      targetDeviceId: target,
      allowActiveSource: false,
    });
    expect(attempted).toBe(true);
    expect(blocked).toBe(true);
    expect(dto.deviceId).toBe(target);
    expect(
      competitor
        .prepare(
          "select merged_into_id as alias from devices where subject_type = ? and subject_id = ? and device_id = ?",
        )
        .get(owner.type, owner.id, target),
    ).toEqual({ alias: null });
  } finally {
    connection.close();
    competitor.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
