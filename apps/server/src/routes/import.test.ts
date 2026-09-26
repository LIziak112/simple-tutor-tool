import { readFileSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import {
  importCommitOkSchema,
  importLintErrorBodySchema,
  importPreviewOkSchema,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { imports, questions } from "../db/schema.ts";
import { createTestDb } from "../db/test-utils.ts";

/**
 * 内容导入接口集成测试（T1.10，app.request() 直调路由 + 内存库）：
 * 未登录 401；参数错误 400；preview 200 且不写库；commit 200 且符合契约；
 * 再导入同文件 version 递增（经接口返回 updated）；有 error 时 422 LINT_ERROR（含 _issues）；
 * v1 文档可导入；courseId 不存在 404。
 */

const silentLogger: Logger = pino({ enabled: false });
const PASSWORD = "teacher-pass-8";

function loadSample(relative: string): string {
  return readFileSync(
    new URL(`../../../../samples/${relative}`, import.meta.url),
    "utf8",
  );
}

const PRACTICE_MD = loadSample("v2/练习样例.md");
const V1_MD = loadSample("v1/示例练习.md");
const BROKEN_MD = `---
kind: practice
unit: 练习
---

::::question{type=fill difficulty=2}
计算：$(-3)+7=$ 4。（填空题题干没有任何双方括号空位）
::::
`;

/** 组装被测应用并完成教师 setup，返回 app、库与登录 Cookie */
async function makeTeacherApp(): Promise<{
  app: ReturnType<typeof createApp>;
  db: Db;
  cookie: string;
}> {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
  });
  const res = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("setup 未下发会话 Cookie");
  const token = line.slice("tutor_session=".length).split(";")[0] ?? "";
  return { app, db, cookie: `tutor_session=${token}` };
}

/** 组装未登录的被测应用 */
function makeBareApp(): { app: ReturnType<typeof createApp>; db: Db } {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
  });
  return { app, db };
}

async function postJson(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cookie) headers.cookie = cookie;
  return app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("导入接口守卫与校验", () => {
  it("未登录访问 preview / commit 均返回 401 统一错误壳", async () => {
    const { app } = makeBareApp();
    const preview = await postJson(app, "/api/teacher/import/preview", {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });
    expect(preview.status).toBe(401);
    expect(((await preview.json()) as ApiErr).error).toBe("UNAUTHORIZED");

    const commit = await postJson(app, "/api/teacher/import/commit", {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });
    expect(commit.status).toBe(401);
    expect(((await commit.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  });

  it("markdown 为空返回 400 VALIDATION_ERROR；请求体不是 JSON 同样 400", async () => {
    const { app, cookie } = await makeTeacherApp();
    const empty = await postJson(
      app,
      "/api/teacher/import/preview",
      {
        markdown: "",
        filename: "练习.md",
      },
      cookie,
    );
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as ApiErr).error).toBe("VALIDATION_ERROR");

    const notJson = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "not-json{{{",
    });
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/teacher/import/preview", () => {
  it("登录后 200：响应符合契约（version/摘要/issues），且不写库", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const res = await postJson(
      app,
      "/api/teacher/import/preview",
      { markdown: PRACTICE_MD, filename: "练习样例.md" },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { summary: { questionCount: number } };
    };
    expect(importPreviewOkSchema.safeParse(body).success).toBe(true);
    expect(body.data.summary.questionCount).toBe(8);

    // 验收点：preview 不写库
    expect(db.select().from(questions).all()).toHaveLength(0);
    expect(db.select().from(imports).all()).toHaveLength(0);
  });

  it("v1 文档 preview 返回 version 1", async () => {
    const { app, cookie } = await makeTeacherApp();
    const res = await postJson(
      app,
      "/api/teacher/import/preview",
      { markdown: V1_MD, filename: "示例练习.md" },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { version: number; summary: { questionCount: number } };
    };
    expect(body.data.version).toBe(1);
    expect(body.data.summary.questionCount).toBe(8);
  });
});

describe("POST /api/teacher/import/commit", () => {
  it("v2 练习导入 200 符合契约；再导入同文件返回 updated=8 且库中 version 全 2、id 不变（验收 1）", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const first = await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: PRACTICE_MD, filename: "练习样例.md" },
      cookie,
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: { questions: { inserted: number; updated: number } };
    };
    expect(importCommitOkSchema.safeParse(firstBody).success).toBe(true);
    expect(firstBody.data.questions).toEqual({ inserted: 8, updated: 0 });

    const firstIds = new Set(
      db
        .select({ id: questions.id })
        .from(questions)
        .all()
        .map((r) => r.id),
    );

    const second = await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: PRACTICE_MD, filename: "练习样例.md" },
      cookie,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      data: { questions: { inserted: number; updated: number } };
    };
    expect(secondBody.data.questions).toEqual({ inserted: 0, updated: 8 });

    const rows = db.select().from(questions).all();
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.version === 2)).toBe(true);
    expect(new Set(rows.map((r) => r.id))).toEqual(firstIds);

    // 两次导入各留档一行
    expect(db.select().from(imports).all()).toHaveLength(2);
  });

  it("有 error 级 issue 时 422 LINT_ERROR，响应体为统一壳超集（含 _issues）（验收 2）", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const res = await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: BROKEN_MD, filename: "坏练习.md" },
      cookie,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; _issues: unknown[] };
    expect(importLintErrorBodySchema.safeParse(body).success).toBe(true);
    expect(body.error).toBe("LINT_ERROR");
    expect(body._issues.length).toBeGreaterThan(0);
    // 拒绝时无任何写入
    expect(db.select().from(questions).all()).toHaveLength(0);
    expect(db.select().from(imports).all()).toHaveLength(0);
  });

  it("v1 文档导入成功：8 题落库（验收 3）", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const res = await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: V1_MD, filename: "示例练习.md" },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { questions: { inserted: number; updated: number } };
    };
    expect(body.data.questions).toEqual({ inserted: 8, updated: 0 });
    expect(db.select().from(questions).all()).toHaveLength(8);
  });

  it("courseId 不存在返回 404 COURSE_NOT_FOUND", async () => {
    const { app, cookie } = await makeTeacherApp();
    const res = await postJson(
      app,
      "/api/teacher/import/commit",
      {
        markdown: PRACTICE_MD,
        filename: "练习样例.md",
        courseId: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
      },
      cookie,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("COURSE_NOT_FOUND");
  });
});
