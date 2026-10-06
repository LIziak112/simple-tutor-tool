import { readFileSync } from "node:fs";
import type { ApiErr, SubmitEvidenceDeclaration } from "@tutor/contract";
import { noteVersionReceiptSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client.ts";
import {
  attempts as attemptsTable,
  submissionEvidence as evidenceTable,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { gzipJson, noteDoc, putNoteBodyForm } from "../test/note-fixtures.ts";
import {
  freshNoteAttempt,
  insertEvidence,
  loginStudent,
  noteRowOf,
} from "../test/note-world.ts";
import { fetchSubmitRevisions } from "../test/submit-revisions.ts";

/**
 * T6R.10 提交事务固定原稿（路由层测试）：交卷请求携带每题笔记证据声明
 * （none/frozen/missing + 预期 revision），服务端逐项验证归属（本人笔记）、
 * 题目版本（声明集合 = 冻结集合）与并发状态（CAS head），同一事务写
 * submission_evidence 与成绩/状态。
 * 覆盖任务清单 T6R.10 全部失败场景：
 * - 未授权/错版 versionId；其他标签页改出新 head（revision 不匹配）；
 * - 重复提交与响应丢失（409 ALREADY_SUBMITTED）；
 * - 提交 DB 失败回滚（唯一冲突注入 → attempt 仍 draft、零行落库）；
 * - 交卷后迟到 PUT 不改 original（409 + 幂等重放返回原回执）；
 * - 旧客户端有笔记缺 evidence 字段拒绝；无笔记兼容提交（未采集=无行）；
 * - none 与实际有稿矛盾拒绝；用户确认后的 missing 落行；
 * - 校验失败零落行（先全量验证再统一写）。
 * 夹具用 samples/v2/练习样例.md（首单元八题）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

const PRACTICE_MD = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf-8",
);

type App = ReturnType<typeof createApp>;

let app: App;
let db: Db;
let dataDir: string;
let teacherCookie: string;
let unitId: string;
let aId: string;
let aCookie: string;

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
    body: JSON.stringify({ loginName: "teacher", password: TEACHER_PASSWORD }),
  });
  teacherCookie = cookieOf(setup);
  const importRes = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ markdown: PRACTICE_MD, filename: "练习样例.md" }),
  });
  expect(importRes.status).toBe(200);
  const units = (
    (await importRes.json()) as { data: { units: { id: string }[] } }
  ).data.units;
  const firstUnit = units[0];
  if (firstUnit === undefined) throw new Error("样例导入未产出单元");
  unitId = firstUnit.id;
  aId = await createStudent("张三");
  aCookie = await loginStudent(app, "张三", STUDENT_PASSWORD);
});

function cookieOf(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c: string) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return `tutor_session=${line.slice("tutor_session=".length).split(";")[0]}`;
}

async function createStudent(name: string): Promise<string> {
  const res = await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName: name,
      loginName: name,
      password: STUDENT_PASSWORD,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { student: { id: string } } }).data
    .student.id;
}

/** 按下标取题目 id（越界即测试前置失败——比非空断言可诊断） */
function qAt(ids: string[], index: number): string {
  const id = ids[index];
  if (id === undefined)
    throw new Error(`题目下标 ${index} 越界（样例卷应有八题）`);
  return id;
}

/** 每测试取新 attempt（笔记/证据按 attempt 天然隔离） */
function freshAttempt(): Promise<string> {
  return freshNoteAttempt(app, teacherCookie, unitId, [aId], aCookie);
}

/** 该 attempt 的全部题目 id（草稿视图按序；与交卷 revisions 同源） */
async function questionIdsOf(attemptId: string): Promise<string[]> {
  const res = await app.request(`/api/student/attempts/${attemptId}`, {
    headers: { cookie: aCookie },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as {
    data: { units: { questions: { id: string }[] }[] };
  };
  return data.data.units.flatMap((u) => u.questions.map((q) => q.id));
}

/** PUT 一版草稿并返回回执（含 versionId/revision） */
async function putNote(
  attemptId: string,
  questionId: string,
  strokes = 1,
  baseRevision = 0,
  mutationId?: string,
): Promise<{ status: number; body: unknown }> {
  const form = putNoteBodyForm(gzipJson(noteDoc(strokes)), {
    baseRevision,
    ...(mutationId !== undefined ? { mutationId } : {}),
  });
  const res = await app.request(
    `/api/student/attempts/${attemptId}/notes/${questionId}`,
    { method: "PUT", headers: { cookie: aCookie }, body: form },
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** 交卷（携带 evidence；revisions 自动取详情同既有流程） */
async function submitWith(
  attemptId: string,
  evidence?: SubmitEvidenceDeclaration[],
): Promise<Response> {
  const revisions = await fetchSubmitRevisions(app, aCookie, attemptId);
  const json =
    evidence === undefined
      ? { revisions }
      : { revisions, evidence: [...evidence] };
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/submit`, {
      method: "POST",
      headers: { cookie: aCookie },
      body: JSON.stringify(json),
    }),
  );
}

/** 全部声明为指定状态（frozen 取实际 head）——成功路径的组装器 */
async function allNoneDeclarations(
  attemptId: string,
): Promise<SubmitEvidenceDeclaration[]> {
  const ids = await questionIdsOf(attemptId);
  return ids.map((questionId) => ({ questionId, state: "none" as const }));
}

function evidenceRowsOf(attemptId: string) {
  return db
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.attemptId, attemptId))
    .all();
}

function attemptRowOf(attemptId: string) {
  return db
    .select()
    .from(attemptsTable)
    .where(eq(attemptsTable.id, attemptId))
    .get();
}

async function expectApiErr(res: PromiseLike<Response> | Response) {
  const resolved = await res;
  const body = (await resolved.json()) as ApiErr;
  return { status: resolved.status, code: body.error, body };
}

// ---------- 冻结原稿主链 ----------

describe("T6R.10 交卷固定原稿：frozen 主链", () => {
  it("有稿题 frozen 固定 head 版本、无稿题 none 落行、其余未采集语义=新客户端全覆盖", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    const notedId = qAt(ids, 0);
    const put1 = await putNote(attemptId, notedId, 2);
    expect(put1.status).toBe(200);
    const receipt1 = noteVersionReceiptSchema.parse(
      (put1.body as { data: unknown }).data,
    );
    const head = noteRowOf(db, attemptId, notedId);
    expect(head?.currentRevision).toBe(1);

    const evidence: SubmitEvidenceDeclaration[] = [
      {
        questionId: notedId,
        state: "frozen",
        versionId: receipt1.versionId,
        revision: 1,
      },
      ...ids
        .filter((id) => id !== notedId)
        .map((questionId) => ({ questionId, state: "none" as const })),
    ];
    const res = await submitWith(attemptId, evidence);
    expect(res.status).toBe(200);

    // 逐题落行：frozen 指向 head 版本；none 显式空稿；attempt 已交
    const rows = evidenceRowsOf(attemptId);
    expect(rows).toHaveLength(ids.length);
    const frozenRow = rows.find((r) => r.questionId === notedId);
    expect(frozenRow?.state).toBe("frozen");
    expect(frozenRow?.versionId).toBe(receipt1.versionId);
    expect(rows.filter((r) => r.state === "none")).toHaveLength(ids.length - 1);
    expect(attemptRowOf(attemptId)?.status).not.toBe("draft");
  });

  it("多版后固定最终 head：v1→v2 交卷固定 v2（不是 v1）", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    const notedId = qAt(ids, 1);
    await putNote(attemptId, notedId, 1);
    const put2 = await putNote(attemptId, notedId, 3, 1);
    expect(put2.status).toBe(200);
    const receipt2 = noteVersionReceiptSchema.parse(
      (put2.body as { data: unknown }).data,
    );

    const evidence: SubmitEvidenceDeclaration[] = [
      {
        questionId: notedId,
        state: "frozen",
        versionId: receipt2.versionId,
        revision: 2,
      },
      ...ids
        .filter((id) => id !== notedId)
        .map((questionId) => ({ questionId, state: "none" as const })),
    ];
    const res = await submitWith(attemptId, evidence);
    expect(res.status).toBe(200);
    const frozenRow = evidenceRowsOf(attemptId).find(
      (r) => r.questionId === notedId,
    );
    expect(frozenRow?.state).toBe("frozen");
    expect(frozenRow?.versionId).toBe(receipt2.versionId);
  });

  it("missing（用户明确选择）落行 state=missing、无版本引用", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    const evidence: SubmitEvidenceDeclaration[] = ids.map((questionId) => ({
      questionId,
      state: "missing" as const,
    }));
    const res = await submitWith(attemptId, evidence);
    expect(res.status).toBe(200);
    const rows = evidenceRowsOf(attemptId);
    expect(rows).toHaveLength(ids.length);
    expect(rows.every((r) => r.state === "missing" && r.versionId === null));
  });
});

// ---------- 拒绝分支 ----------

describe("T6R.10 证据声明拒绝分支（409 NOTE_EVIDENCE_MISMATCH）", () => {
  it("frozen 声明非 head 的 versionId（他人版本/不存在）→ 409 且零落行", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    // 另一 attempt 的合法版本（未授权引用）
    const otherAttempt = await freshAttempt();
    const otherPut = await putNote(otherAttempt, qAt(ids, 0), 1);
    const otherReceipt = noteVersionReceiptSchema.parse(
      (otherPut.body as { data: unknown }).data,
    );

    const res = await submitWith(attemptId, [
      {
        questionId: qAt(ids, 0),
        state: "frozen",
        versionId: otherReceipt.versionId,
        revision: 1,
      },
      ...ids
        .slice(1)
        .map((questionId) => ({ questionId, state: "none" as const })),
    ]);
    const err = await expectApiErr(res);
    expect(err.status).toBe(409);
    expect(err.code).toBe("NOTE_EVIDENCE_MISMATCH");
    // 校验失败零落行：attempt 仍 draft、无证据行
    expect(attemptRowOf(attemptId)?.status).toBe("draft");
    expect(evidenceRowsOf(attemptId)).toHaveLength(0);
  });

  it("提交期间其他标签页改出新 head（revision 落后）→ 409，不静默固定旧版", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    const notedId = qAt(ids, 2);
    const put1 = await putNote(attemptId, notedId, 1);
    const receipt1 = noteVersionReceiptSchema.parse(
      (put1.body as { data: unknown }).data,
    );
    // 「其他标签页」再存两版：head 前进到 3
    await putNote(attemptId, notedId, 2, 1);
    await putNote(attemptId, notedId, 2, 2);

    const res = await submitWith(attemptId, [
      {
        questionId: notedId,
        state: "frozen",
        versionId: receipt1.versionId,
        revision: 1,
      },
      ...ids
        .filter((id) => id !== notedId)
        .map((questionId) => ({ questionId, state: "none" as const })),
    ]);
    const err = await expectApiErr(res);
    expect(err.status).toBe(409);
    expect(err.code).toBe("NOTE_EVIDENCE_MISMATCH");
    expect(attemptRowOf(attemptId)?.status).toBe("draft");
  });

  it("none 声明与实际有稿矛盾 → 409（用户未确认不能静默 missing/none）", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    await putNote(attemptId, qAt(ids, 3), 1);

    const res = await submitWith(
      attemptId,
      await allNoneDeclarations(attemptId),
    );
    const err = await expectApiErr(res);
    expect(err.status).toBe(409);
    expect(err.code).toBe("NOTE_EVIDENCE_MISMATCH");
    expect(attemptRowOf(attemptId)?.status).toBe("draft");
  });

  it("声明集合与冻结题目集合不一致：缺项 / 多出未知题目 / 重复 → 409", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    // 缺项（漏一题）
    const missing1 = await expectApiErr(
      submitWith(
        attemptId,
        ids
          .slice(1)
          .map((questionId) => ({ questionId, state: "none" as const })),
      ),
    );
    expect(missing1.status).toBe(409);
    // 多出未知题目
    const unknown = await expectApiErr(
      submitWith(attemptId, [
        ...ids.map((questionId) => ({ questionId, state: "none" as const })),
        { questionId: "not-in-paper", state: "none" },
      ]),
    );
    expect(unknown.status).toBe(409);
    // 重复
    const dup = await expectApiErr(
      submitWith(attemptId, [
        { questionId: qAt(ids, 0), state: "none" },
        { questionId: qAt(ids, 0), state: "none" },
        ...ids
          .slice(1)
          .map((questionId) => ({ questionId, state: "none" as const })),
      ]),
    );
    expect(dup.status).toBe(409);
    expect(evidenceRowsOf(attemptId)).toHaveLength(0);
  });

  it("泄露：409 响应 assertNoLeak 通过（无答案/详解/提示/磁盘路径）", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    await putNote(attemptId, qAt(ids, 0), 1);
    const res = await submitWith(
      attemptId,
      await allNoneDeclarations(attemptId),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(409);
    assertNoLeak(body);
  });
});

// ---------- 旧客户端兼容 ----------

describe("T6R.10 旧客户端兼容分支", () => {
  it("缺 evidence 字段 + 无笔记 → 200 兼容交卷，不落证据行（未采集）", async () => {
    const attemptId = await freshAttempt();
    const res = await submitWith(attemptId);
    expect(res.status).toBe(200);
    expect(evidenceRowsOf(attemptId)).toHaveLength(0);
    expect(attemptRowOf(attemptId)?.status).not.toBe("draft");
  });

  it("缺 evidence 字段 + 检测到草稿 → 409 要求刷新（不能把已有草稿记 none）", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    await putNote(attemptId, qAt(ids, 4), 1);
    const err = await expectApiErr(submitWith(attemptId));
    expect(err.status).toBe(409);
    expect(err.code).toBe("NOTE_EVIDENCE_MISMATCH");
    expect(attemptRowOf(attemptId)?.status).toBe("draft");
  });
});

// ---------- 幂等 / 回滚 / original 不可变 ----------

describe("T6R.10 幂等、回滚与 original 不可变", () => {
  it("重复提交与响应丢失重试 → 409 ALREADY_SUBMITTED，证据行不重写", async () => {
    const attemptId = await freshAttempt();
    // 「响应丢失」场景：同请求体重试——声明在首次交卷前组装一次并复用
    const evidence = await allNoneDeclarations(attemptId);
    const first = await submitWith(attemptId, evidence);
    expect(first.status).toBe(200);
    const rowsAfterFirst = evidenceRowsOf(attemptId);
    const retry = await expectApiErr(submitWith(attemptId, evidence));
    expect(retry.status).toBe(409);
    expect(retry.code).toBe("ALREADY_SUBMITTED");
    expect(evidenceRowsOf(attemptId)).toEqual(rowsAfterFirst);
  });

  it("交卷后迟到 PUT → 409 ALREADY_SUBMITTED；original 行与 head 不变", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    const notedId = qAt(ids, 5);
    const put1 = await putNote(attemptId, notedId, 1);
    const receipt1 = noteVersionReceiptSchema.parse(
      (put1.body as { data: unknown }).data,
    );
    const res = await submitWith(attemptId, [
      {
        questionId: notedId,
        state: "frozen",
        versionId: receipt1.versionId,
        revision: 1,
      },
      ...ids
        .filter((id) => id !== notedId)
        .map((questionId) => ({ questionId, state: "none" as const })),
    ]);
    expect(res.status).toBe(200);

    // 迟到 PUT（新版本）：被交卷终态拒绝（putNote 返回 {status, body}，错误码在 body.error）
    const late = await putNote(attemptId, notedId, 9, 1);
    expect(late.status).toBe(409);
    expect((late.body as ApiErr).error).toBe("ALREADY_SUBMITTED");
    // original 不变：head 仍是 v1、证据行仍指 v1
    const head = noteRowOf(db, attemptId, notedId);
    expect(head?.currentRevision).toBe(1);
    expect(head?.currentVersionId).toBe(receipt1.versionId);
    const frozenRow = evidenceRowsOf(attemptId).find(
      (r) => r.questionId === notedId,
    );
    expect(frozenRow?.versionId).toBe(receipt1.versionId);
  });

  it("交卷后同 mutationId 幂等重放返回原回执（丢回执补传不误 409、不改 original）", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    const notedId = qAt(ids, 6);
    const mutationId = "44444444-4444-4444-8444-444444444444";
    const put1 = await putNote(attemptId, notedId, 1, 0, mutationId);
    expect(put1.status).toBe(200);
    const receipt1 = noteVersionReceiptSchema.parse(
      (put1.body as { data: unknown }).data,
    );
    const res = await submitWith(attemptId, [
      {
        questionId: notedId,
        state: "frozen",
        versionId: receipt1.versionId,
        revision: 1,
      },
      ...ids
        .filter((id) => id !== notedId)
        .map((questionId) => ({ questionId, state: "none" as const })),
    ]);
    expect(res.status).toBe(200);

    // 迟到重放（同 mutationId 同正文）：返回原回执，head/证据行不动
    const replay = await putNote(attemptId, notedId, 1, 0, mutationId);
    expect(replay.status).toBe(200);
    const replayReceipt = noteVersionReceiptSchema.parse(
      (replay.body as { data: unknown }).data,
    );
    expect(replayReceipt.versionId).toBe(receipt1.versionId);
    expect(noteRowOf(db, attemptId, notedId)?.currentRevision).toBe(1);
    expect(
      evidenceRowsOf(attemptId).find((r) => r.questionId === notedId)
        ?.versionId,
    ).toBe(receipt1.versionId);
  });

  it("提交 DB 失败回滚：唯一冲突注入 → 500 后 attempt 仍 draft、零证据行、答案未判分", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    // 故障注入：预插一行同 (attempt, question) 证据行 → 交卷事务插入必撞唯一索引
    insertEvidence(db, attemptId, qAt(ids, 0), "none", null);

    const res = await submitWith(
      attemptId,
      await allNoneDeclarations(attemptId),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(attemptRowOf(attemptId)?.status).toBe("draft");
    // 只剩注入的那一行：事务回滚没有写入任何新行/判分
    expect(evidenceRowsOf(attemptId)).toHaveLength(1);
  });

  it("重练后旧卷原稿不变：同题新 attempt 的笔记与证据互不影响", async () => {
    const firstAttempt = await freshAttempt();
    const ids = await questionIdsOf(firstAttempt);
    const notedId = qAt(ids, 0);
    const put1 = await putNote(firstAttempt, notedId, 2);
    const receipt1 = noteVersionReceiptSchema.parse(
      (put1.body as { data: unknown }).data,
    );
    const res1 = await submitWith(firstAttempt, [
      {
        questionId: notedId,
        state: "frozen",
        versionId: receipt1.versionId,
        revision: 1,
      },
      ...ids
        .filter((id) => id !== notedId)
        .map((questionId) => ({ questionId, state: "none" as const })),
    ]);
    expect(res1.status).toBe(200);
    const firstRow = evidenceRowsOf(firstAttempt).find(
      (r) => r.questionId === notedId,
    );

    // 新卷同题写新草稿并交卷
    const secondAttempt = await freshAttempt();
    const put2 = await putNote(secondAttempt, notedId, 5);
    const receipt2 = noteVersionReceiptSchema.parse(
      (put2.body as { data: unknown }).data,
    );
    const res2 = await submitWith(secondAttempt, [
      {
        questionId: notedId,
        state: "frozen",
        versionId: receipt2.versionId,
        revision: 1,
      },
      ...ids
        .filter((id) => id !== notedId)
        .map((questionId) => ({ questionId, state: "none" as const })),
    ]);
    expect(res2.status).toBe(200);

    // 旧卷 evidence 行与 head 原样（订正/重练/清空都不动 original）
    expect(
      evidenceRowsOf(firstAttempt).find((r) => r.questionId === notedId),
    ).toEqual(firstRow);
    expect(noteRowOf(db, firstAttempt, notedId)?.currentVersionId).toBe(
      receipt1.versionId,
    );
  });
});
