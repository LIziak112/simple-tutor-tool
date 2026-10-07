import { randomUUID } from "node:crypto";
import type { ApiErr, ReviewPackPreviewData } from "@tutor/contract";
import { reviewPackPreviewDataSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client.ts";
import { responses as responsesTable } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { readZipEntries } from "../lib/zip-read.ts";
import { attachNoteImage, saveNoteVersion } from "../services/note-service.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
  submitAttemptStatus,
} from "../test/evidence-fixtures.ts";
import { gzipJson, makeNotePng, noteDoc } from "../test/note-fixtures.ts";
import {
  createStudent,
  extractSessionToken,
  insertEvidence,
  loginStudent,
} from "../test/note-world.ts";

/**
 * T6R.13 学生单题 review-pack 路由测试（新增学生端响应——泄露测试必写）：
 * - POST /api/student/attempts/:id/questions/:qid/review-pack/preview（统一壳）；
 * - POST /api/student/attempts/:id/questions/:qid/review-pack（zip 直出）。
 * 覆盖：401/403/404 鉴权矩阵；assertNoLeak（键级）+ **全 zip 文本文件内容级
 * 哨兵扫描**（答案/解析/提示/评语/真实 id——路由层独立于装配层的第二道）
 * 与条目名级 id 扫描；zip 响应头（application/zip + attachment + no-store
 * ——跨账号缓存防线）；preview 响应同样 no-store；响应过契约 schema。
 */

const silentLogger: Logger = pino({ enabled: false });

/** 泄露哨兵（题库侧秘密，任何学生端响应/zip 文件不得出现） */
const SECRET_ANSWER = "42";
const SECRET_SOLUTION = "路由级解析哨兵：先通分再相加";
const SECRET_HINT = "路由级提示哨兵：分母相同直接加分子";
const SECRET_COMMENT = "路由级评语哨兵：跳步严重";
const QUESTION_ID = "p13-q1";

let app: ReturnType<typeof createApp>;
let db: Db;
let dataDir: string;
let aCookie: string;
let bCookie: string;
let aId: string;
let attemptId: string;
let versionId: string;

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
  const teacherCookie = `tutor_session=${extractSessionToken(setup)}`;
  aId = await createStudent(app, teacherCookie, "路由张三");
  await createStudent(app, teacherCookie, "路由李四");
  aCookie = await loginStudent(app, "路由张三");
  bCookie = await loginStudent(app, "路由李四");

  // —— 世界：一题 fill（答案/解析/提示哨兵）+ 草稿分析图 + frozen 证据 ——
  const world = frozenDraftAttempt(db, aId, [
    {
      questionId: QUESTION_ID,
      snapshotJson: snapshotJsonOf({
        id: QUESTION_ID,
        stemMd: `计算填空：$\\frac{1}{2}+\\frac{1}{2}=$ [[${SECRET_ANSWER}]]`,
        answers: { kind: "fill", blanks: [[SECRET_ANSWER]] },
        solutionMd: SECRET_SOLUTION,
        hints: [SECRET_HINT],
      }),
    },
  ]);
  attemptId = world.attemptId;
  const receipt = saveNoteVersion(
    db,
    dataDir,
    aId,
    attemptId,
    QUESTION_ID,
    gzipJson(noteDoc(2, 30)),
    { baseRevision: 0, mutationId: randomUUID() },
  );
  versionId = receipt.versionId;
  attachNoteImage(
    db,
    dataDir,
    { kind: "student", id: aId },
    versionId,
    makeNotePng(1000, 800),
    {
      spec: "analysis",
      pageIndex: 0,
      crop: { x: 0, y: 0, width: 1000, height: 800 },
      pixelWidth: 1000,
      pixelHeight: 800,
    },
  );
  submitAttemptStatus(db, attemptId);
  insertEvidence(db, attemptId, QUESTION_ID, "frozen", versionId);
  // 教师批注（评语哨兵——学生包绝不携带）
  db.update(responsesTable)
    .set({ teacherComment: SECRET_COMMENT, finalCorrect: false })
    .where(eq(responsesTable.attemptId, attemptId))
    .run();
  // bCookie 供跨账号用例
  void bCookie;
});

function previewUrl(attempt = attemptId): string {
  return `/api/student/attempts/${attempt}/questions/${QUESTION_ID}/review-pack/preview`;
}
function zipUrl(attempt = attemptId): string {
  return `/api/student/attempts/${attempt}/questions/${QUESTION_ID}/review-pack`;
}

describe("学生单题 review-pack 路由", () => {
  it("未登录 401：preview 与 zip 两接口", async () => {
    for (const url of [previewUrl(), zipUrl()]) {
      const res = await app.request(url, { method: "POST" });
      expect(res.status).toBe(401);
      const body = (await res.json()) as ApiErr;
      expect(body.error).toBe("UNAUTHORIZED");
    }
  });

  it("他人 attempt 403；不存在 attempt 404；题不在卷内 404", async () => {
    const forbidden = await app.request(previewUrl(), {
      method: "POST",
      headers: { cookie: bCookie },
    });
    expect(forbidden.status).toBe(403);
    const notFound = await app.request(
      previewUrl("00000000-0000-4000-8000-000000000000"),
      {
        method: "POST",
        headers: { cookie: aCookie },
      },
    );
    expect(notFound.status).toBe(404);
    const noQuestion = await app.request(
      `/api/student/attempts/${attemptId}/questions/不存在的题/review-pack/preview`,
      { method: "POST", headers: { cookie: aCookie } },
    );
    expect(noQuestion.status).toBe(404);
    expect(((await noQuestion.json()) as ApiErr).error).toBe(
      "QUESTION_NOT_FOUND",
    );
  });

  it("preview：统一壳 + 契约 schema + assertNoLeak（键级）+ no-store", async () => {
    const res = await app.request(previewUrl(), {
      method: "POST",
      headers: { cookie: aCookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { ok: true; data: unknown };
    assertNoLeak(body);
    const data = reviewPackPreviewDataSchema.parse(body.data);
    expect(data.role).toBe("student");
    expect(data.answersIncluded).toBe(false);
    expect(data.evidenceState).toBe("frozen");
    expect(data.complete).toBe(true);
    // reviewMd 是复制文字的固定文本：不含答案/解析/提示/评语哨兵
    expect(data.reviewMd).not.toContain(SECRET_ANSWER);
    expect(data.reviewMd).not.toContain(SECRET_SOLUTION);
    expect(data.reviewMd).not.toContain(SECRET_HINT);
    expect(data.reviewMd).not.toContain(SECRET_COMMENT);
    // 复制语义红线（前端按钮文案与 review.md 双处保证）
    expect(data.reviewMd).toContain("不含任何图片");
  });

  it("zip：application/zip + attachment + no-store（跨账号缓存防线）+ 解包全文件哨兵扫描", async () => {
    const res = await app.request(zipUrl(), {
      method: "POST",
      headers: { cookie: aCookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toMatch(/review-pack-q1-\d{8}-\d{6}\.zip/);
    // 文件名不含真实 id（化名口径）
    expect(disposition).not.toContain(attemptId);
    expect(disposition).not.toContain(versionId);

    // —— 路由层全文件扫描（独立于装配层测试的第二道） ——
    const entries = readZipEntries(Buffer.from(await res.arrayBuffer()));
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const entry of entries) {
      // 条目名不含真实 id
      expect(entry.name).not.toContain(attemptId);
      expect(entry.name).not.toContain(versionId);
      expect(entry.name).not.toContain(QUESTION_ID);
      expect(entry.name.startsWith("/")).toBe(false);
      expect(entry.name.includes("..")).toBe(false);
      if (/\.(md|json)$/.test(entry.name)) {
        const text = entry.data.toString("utf8");
        expect(text, `${entry.name} 泄露答案哨兵`).not.toContain(SECRET_ANSWER);
        expect(text, `${entry.name} 泄露解析哨兵`).not.toContain(
          SECRET_SOLUTION,
        );
        expect(text, `${entry.name} 泄露提示哨兵`).not.toContain(SECRET_HINT);
        expect(text, `${entry.name} 泄露评语哨兵`).not.toContain(
          SECRET_COMMENT,
        );
        expect(text, `${entry.name} 泄露 attemptId`).not.toContain(attemptId);
        expect(text, `${entry.name} 泄露 versionId`).not.toContain(versionId);
        expect(text, `${entry.name} 泄露 questionId`).not.toContain(
          QUESTION_ID,
        );
      }
    }
    // 固定文件在场；PNG 魔数
    const names = new Set(entries.map((entry) => entry.name));
    for (const fixed of [
      "review.md",
      "pack.json",
      "schema.json",
      "questions/q001/stem.md",
      "evidence/e001-original-01.png",
    ]) {
      expect(names.has(fixed), `zip 缺 ${fixed}`).toBe(true);
    }
    const png = entries.find((entry) => entry.name.endsWith(".png"));
    expect(png?.data.subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    // 题面是脱敏空框（学生投影）
    expect(
      entries
        .find((entry) => entry.name === "questions/q001/stem.md")
        ?.data.toString("utf8"),
    ).toContain("[[]]");
  });

  it("附件 downloadUrl：证据图指向学生本人 note-versions 直出端点", async () => {
    const res = await app.request(previewUrl(), {
      method: "POST",
      headers: { cookie: aCookie },
    });
    const body = (await res.json()) as {
      ok: true;
      data: ReviewPackPreviewData;
    };
    const evidence = body.data.attachments.find(
      (item) => item.kind === "evidence" && item.state === "ready",
    );
    expect(evidence?.downloadUrl).toContain(
      `/api/student/note-versions/${versionId}/images/`,
    );
  });
});
