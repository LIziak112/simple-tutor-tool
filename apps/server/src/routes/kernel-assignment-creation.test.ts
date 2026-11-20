import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AssignmentCreateRequest } from "@tutor/contract";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import type { Db } from "../db/client.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import {
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import type { TestApp } from "../test/note-fixtures.ts";

const openedDatabases: Db[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const db of openedDatabases.splice(0)) db.$client.close();
});
async function fixture() {
  const db = createTestDb();
  openedDatabases.push(db);
  const dataDir = createTestDir();
  const mount = (kernelAssignmentCreationEnabled?: boolean) =>
    createApp({
      db,
      dataDir,
      isProduction: false,
      publicUrl: "http://localhost:8787",
      logger: pino({ enabled: false }),
      kernelAssignmentCreationEnabled,
    });
  const app = mount();
  const world = await setupAssignment(app);
  const headers = { cookie: world.teacher, "content-type": "application/json" };
  const request = {
    title: "内核作业试点",
    unitIds: [world.unitId],
    studentIds: [world.studentId],
    allowRedo: false,
    executionBackend: "kernel",
  } satisfies AssignmentCreateRequest;
  const assign = (app: TestApp, body: AssignmentCreateRequest) =>
    app.request("/api/teacher/assignments", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const importUnit = async (markdown: string) => {
    const response = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers,
      body: JSON.stringify({ markdown, filename: "试点样例.md" }),
    });
    expect(response.status).toBe(200);
    const { data } = z
      .object({
        data: z.object({ units: z.array(z.object({ id: z.string() })) }),
      })
      .parse(await response.json());
    return data.units[0]?.id ?? "";
  };
  const marks = () =>
    db.$client
      .prepare(
        "SELECT assignment_id FROM kernel_assignments ORDER BY assignment_id",
      )
      .pluck()
      .all();
  return { ...world, db, request, mount, assign, importUnit, marks };
}

async function assignmentIds(response: Response) {
  expect(response.status).toBe(201);
  return z
    .object({
      data: z.object({ assignments: z.array(z.object({ id: z.uuid() })) }),
    })
    .parse(await response.json())
    .data.assignments.map(({ id }) => id);
}

describe("P2 建作业时固定执行路由", () => {
  it("默认关闭新内核分配，既有无标记作业和显式旧路由照常", async () => {
    const env = await fixture();
    const app = env.mount();
    const forbidden = await env.assign(app, env.request);
    expect(forbidden.status).toBe(409);
    expect(await forbidden.json()).toMatchObject({
      error: "KERNEL_ASSIGNMENT_DISABLED",
    });
    const legacy = await env.assign(app, {
      ...env.request,
      executionBackend: "legacy",
    });
    expect(await assignmentIds(legacy)).toHaveLength(1);
    expect(env.marks()).toEqual([]);
    const started = await postAssignment(
      env.mount(true),
      env.assignmentId,
      env.ownerCookie,
    );
    expect(started.status).toBe(200);
    expect(
      env.db.$client
        .prepare("SELECT COUNT(*) FROM attempts WHERE assignment_id = ?")
        .pluck()
        .get(env.assignmentId),
    ).toBe(1);
  });

  it("持久登记每份分建作业，关闭新分配后原创建操作仍原样返回", async () => {
    const env = await fixture();
    const markdown = readFileSync(
      new URL("../test/m04-p1/fixtures/P0-单选夹具.md", import.meta.url),
      "utf8",
    )
      .replace("unit: M04P0", "unit: M04P2另一个单元")
      .replaceAll("m04-p0-q", "m04-p2-q");
    const unitId = await env.importUnit(markdown);
    expect(unitId).not.toBe(env.unitId);
    const request = {
      ...env.request,
      unitIds: [env.unitId, unitId],
      unitGrouping: "separate",
      operationId: randomUUID(),
    } as const;
    const ids = await assignmentIds(
      await env.assign(env.mount(true), {
        ...request,
        unitIds: [...request.unitIds],
      }),
    );
    expect(ids).toHaveLength(2);
    expect(env.marks()).toEqual([...ids].sort());
    expect(
      await assignmentIds(
        await env.assign(env.mount(false), {
          ...request,
          unitIds: [...request.unitIds],
        }),
      ),
    ).toEqual(ids);
    expect(
      (
        await env.assign(env.mount(false), {
          ...request,
          unitIds: [...request.unitIds],
          operationId: randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(env.marks()).toEqual([...ids].sort());
  });

  it("不合资格的分建批次与创建回执一起回滚", async () => {
    vi.stubEnv("NEW_CONTENT_ENABLED", "true");
    const env = await fixture();
    const path = new URL(
      "../../../../samples/qm/valid-05-固定项排序.md",
      import.meta.url,
    );
    const unitId = await env.importUnit(readFileSync(path, "utf8"));
    const operationId = randomUUID();
    const response = await env.assign(env.mount(true), {
      ...env.request,
      unitGrouping: "separate",
      unitIds: [env.unitId, unitId],
      operationId,
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "M04_PRACTICE_INELIGIBLE",
    });
    expect(env.marks()).toEqual([]);
    expect(
      env.db.$client.prepare("SELECT COUNT(*) FROM assignments").pluck().get(),
    ).toBe(1);
    expect(
      env.db.$client
        .prepare("SELECT COUNT(*) FROM create_receipts WHERE operation_id=?")
        .pluck()
        .get(operationId),
    ).toBe(0);
  });
});
