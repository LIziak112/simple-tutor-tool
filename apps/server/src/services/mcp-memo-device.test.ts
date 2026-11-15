import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { aiConnections, devices } from "../db/schema.ts";
import { makeStudent } from "../test/note-fixtures.ts";
import { studentPracticeReadEnv } from "../test/student-mcp-practice-fixtures.ts";
import { renameDevice } from "./device-service.ts";
import { registerMcpMemoDevice } from "./mcp-memo-device.ts";

const opened: Awaited<ReturnType<typeof studentPracticeReadEnv>>[] = [];
afterEach(async () => {
  for (const env of opened.splice(0)) {
    await env.client.close();
    env.db.$client.close();
  }
});
describe("MCP随笔设备来源", () => {
  it("仅本人有效MCP连接可登记；重试保留用户改名，不读取凭证配置", async () => {
    const env = await studentPracticeReadEnv("class");
    opened.push(env);
    const stranger = makeStudent(env.db);
    expect(() =>
      registerMcpMemoDevice(env.db, stranger, env.connectionId),
    ).toThrow("连接不存在或不可见");
    expect(() =>
      registerMcpMemoDevice(env.db, env.studentId, randomUUID()),
    ).toThrow("连接不存在或不可见");
    expect(env.db.select().from(devices).all()).toEqual([]);
    expect(registerMcpMemoDevice(env.db, env.studentId, env.connectionId)).toBe(
      env.connectionId,
    );
    renameDevice(
      env.db,
      { type: "student", id: env.studentId },
      env.connectionId,
      "我的Agent",
    );
    registerMcpMemoDevice(env.db, env.studentId, env.connectionId);
    const row = env.db
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.subjectId, env.studentId),
          eq(devices.deviceId, env.connectionId),
        ),
      )
      .get();
    expect(row).toMatchObject({
      name: "我的Agent",
      automaticName: `MCP 连接 · ${env.connectionId.slice(0, 8)}`,
    });
    expect(JSON.stringify(row)).not.toContain(env.token);
    env.db
      .update(aiConnections)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(aiConnections.id, env.connectionId))
      .run();
    expect(() =>
      registerMcpMemoDevice(env.db, env.studentId, env.connectionId),
    ).toThrow("连接不存在或不可见");
  });
});
