import { join } from "node:path";
import {
  ATTEMPT_SNAPSHOT_PROOF_HEADER,
  importCommitDataSchema,
} from "@tutor/contract";
import pino from "pino";
import { expect } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import { runBackfills } from "../db/backfill.ts";
import { createDbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";

/** 内核交付路由测试共用：独立实例、带快照证明头的请求和题目导入。 */
export const choices = [
  "::::question{id=k17-one type=choice}",
  "第一道合成题。",
  "- [x] 第一项",
  "- [ ] 第二项",
  "::::",
  "",
  "::::question{id=k17-two type=judge}",
  "合成判断。[[正确]]",
  "::::",
  "",
  "::::question{id=k17-three type=multi}",
  "合成多选。",
  "- [x] 甲",
  "- [ ] 乙",
  "- [x] 丙",
  "::::",
  "",
  "::::question{id=k17-four type=choice}",
  "第四道合成题。",
  "- [x] 第一项",
  "- [ ] 第二项",
  "::::",
  "",
];
export const wire = <Schema extends z.ZodType>(schema: Schema) =>
  z.object({ data: schema });
export function openInstance(dataDir: string) {
  let handle = createDbHandle(join(dataDir, "tutor.db"), (db) => {
    runMigrations(db);
    runBackfills(db);
  });
  const reopen = () => {
    handle.close();
    handle = createDbHandle(join(dataDir, "tutor.db"), (db) => {
      runMigrations(db);
      runBackfills(db);
    });
  };
  const open = (lesson: boolean, operator?: string) =>
    createApp({
      db: handle.db,
      dbHandle: handle,
      dataDir,
      backupOperatorId: operator,
      kernelAssignmentCreationEnabled: true,
      kernelLessonEnabled: lesson,
      isProduction: false,
      logger: pino({ enabled: false }),
      publicUrl: "http://localhost:8787",
    });
  return { reopen, open, db: () => handle.db, close: () => handle.close() };
}

export function jsonCall(
  app: ReturnType<typeof createApp>,
  path: string,
  cookie: string,
  method = "GET",
  body?: object,
) {
  return app.request(path, {
    method,
    headers: {
      cookie,
      [ATTEMPT_SNAPSHOT_PROOF_HEADER]: "1",
      ...(body && { "content-type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
}

export async function importQuestions(
  app: ReturnType<typeof createApp>,
  teacher: string,
  courseId?: string,
  questions = choices,
) {
  const kind = courseId ? "lesson" : "practice";
  const markdown = [
    "---",
    "kind: " + kind,
    "unit: 合成共用交付",
    "---",
    "",
    ...(courseId ? ["# 第1讲 合成共用交付", ""] : []),
    ...questions,
  ].join("\n");
  const response = await jsonCall(
    app,
    "/api/teacher/import/commit",
    teacher,
    "POST",
    {
      markdown,
      filename: "K17-共用交付.md",
      ...(courseId && { addToCourse: { courseId, visible: true } }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return wire(importCommitDataSchema).parse(await response.json()).data;
}
