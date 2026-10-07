import type { ApiErr } from "@tutor/contract";
import { reviewPackPreviewDataSchema } from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { createStudent, extractSessionToken } from "../test/note-world.ts";
import { makeReviewPackWorld } from "../test/review-pack-world.ts";
import { zipEntriesOf } from "../test/zip-assert.ts";

/**
 * T6R.13 教师单题 review-pack 路由测试：
 * - POST /api/teacher/attempts/:id/questions/:qid/review-pack/preview 与
 *   POST …/review-pack（教师域过滤，域外统一 404 不暴露存在性）；
 * - 教师包为教师域文档：zip 内正常携带参考答案/判定/评语（服务层锁定，
 *   这里验路由到货）；zip 头（application/zip + attachment + no-store）。
 */

const silentLogger: Logger = pino({ enabled: false });

const SECRET_ANSWER = "42";
const QUESTION_ID = "t13-q1";

let app: ReturnType<typeof createApp>;
let db: Db;
let dataDir: string;
let teacherCookie: string;
let attemptId: string;

beforeAll(async () => {
  db = createTestDb();
  dataDir = createTestDir();
  app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    dataDir,
    publicUrl: "http://localhost:8787",
  });
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password: "teacher-pass-8" }),
  });
  teacherCookie = `tutor_session=${extractSessionToken(setup)}`;
  const studentId = await createStudent(app, teacherCookie, "教师路由生");

  // 世界：一题 fill + 草稿分析图 + frozen 证据——共享世界件单点构建
  const world = makeReviewPackWorld(db, dataDir, {
    studentId,
    questionId: QUESTION_ID,
    stemMd: `计算：[[${SECRET_ANSWER}]]`,
    sentinels: {
      answer: SECRET_ANSWER,
      solution: "教师域解析（教师包应携带）",
    },
  });
  attemptId = world.attemptId;
});

function previewUrl(attempt = attemptId): string {
  return `/api/teacher/attempts/${attempt}/questions/${QUESTION_ID}/review-pack/preview`;
}
function zipUrl(attempt = attemptId): string {
  return `/api/teacher/attempts/${attempt}/questions/${QUESTION_ID}/review-pack`;
}

describe("教师单题 review-pack 路由", () => {
  it("未登录 401；不存在 attempt 404（不暴露存在性）", async () => {
    for (const url of [previewUrl(), zipUrl()]) {
      const res = await app.request(url, { method: "POST" });
      expect(res.status).toBe(401);
    }
    const res = await app.request(
      previewUrl("00000000-0000-4000-8000-000000000000"),
      { method: "POST", headers: { cookie: teacherCookie } },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("ATTEMPT_NOT_FOUND");
  });

  it("preview：统一壳 + 契约 schema；answersIncluded=true（教师域）", async () => {
    const res = await app.request(previewUrl(), {
      method: "POST",
      headers: { cookie: teacherCookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { ok: true; data: unknown };
    const data = reviewPackPreviewDataSchema.parse(body.data);
    expect(data.role).toBe("teacher");
    expect(data.answersIncluded).toBe(true);
    expect(data.released).toBe(true);
  });

  it("zip：头三件套 + 教师域内容到货（参考答案/详解/真实 id 进包合法）", async () => {
    const res = await app.request(zipUrl(), {
      method: "POST",
      headers: { cookie: teacherCookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition") ?? "").toContain(
      "attachment",
    );
    const entries = [
      ...zipEntriesOf(new Uint8Array(await res.arrayBuffer())).entries(),
    ];
    const packJson =
      entries.find(([name]) => name === "pack.json")?.[1].toString("utf8") ??
      "";
    expect(packJson).toContain(SECRET_ANSWER);
    expect(packJson).toContain(attemptId);
    const stem =
      entries
        .find(([name]) => name === "questions/q001/stem.md")?.[1]
        .toString("utf8") ?? "";
    expect(stem).toContain("参考答案");
    expect(stem).toContain("教师域解析");
  });
});
