import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ApiErr, SubmitEvidenceDeclaration } from "@tutor/contract";
import {
  noteHeadDataSchema,
  type StudentNotebookData,
  studentNotebookOkSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTeacherSession } from "../auth/session.ts";
import type { Db } from "../db/client";
import {
  assignments as assignmentsTable,
  attempts as attemptsTable,
  notes as notesTable,
  responses as responsesTable,
  submissionEvidence as submissionEvidenceTable,
  teachers as teachersTable,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { gzipJson, noteDoc } from "../test/note-fixtures.ts";
import {
  createStudent,
  extractSessionToken,
  freshNoteAttempt,
  loginStudent,
  noteRowOf,
} from "../test/note-world.ts";
import {
  fetchSubmitRevisions,
  submitAttemptRequest,
  submitAttemptRequestWithEvidence,
} from "../test/submit-revisions";

/**
 * T6R.15 路由层测试：订正 / 补充稿 / 题目笔记本四个端点。
 * - PUT  /attempts/:id/notes/:qid（multipart 增可选 phase 字段）；
 * - POST /attempts/:id/notes/:qid/corrections（创建订正，copyFromOriginal）；
 * - POST /attempts/:id/notes/:qid/corrections/seal（保存订正 = 检查点）；
 * - GET  /notebook/questions/:qid（跨来源历史轮次聚合）。
 * 覆盖派单失败测试矩阵：鉴权 401/403/404 门口；draft → NOTE_NOT_SUBMITTED；
 * OPEN_EXISTS / SEALED / ORIGINAL_UNAVAILABLE / seal 404；PUT phase 路由解析；
 * 订正清空不改 original；跨 attempt 错挂与 mutationId 跨笔记重放；并发 CAS
 * 可恢复；软删题历史权限；看解析后材料始终标订正；找回稿不能升级成原稿；
 * assertNoLeak 四端点全覆盖 + notebook 深检查零题干答案；教师侧 evidence 含
 * corrections/supplements、跨教师 404。
 * 夹具用 samples/v2/练习样例.md（题目 id：p4-q7 / 练习四-7）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_B_ID = "teacher-b-correction-01";

const PRACTICE_MD = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf8",
);

/** 样例题 id（solve=纯 ASCII；apply=中文含连字符） */
const Q = { solve: "p4-q7", apply: "练习四-7" } as const;

type App = ReturnType<typeof createApp>;

// ---------- 共享世界（对齐 student-notes.test：一次 beforeAll 构建） ----------

let app: App;
let db: Db;
let dataDir: string;
let teacherCookie: string;
let teacherBCookie: string;
let unitId: string;
let aId: string;
let aCookie: string;
let bCookie: string;

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
  const importRes = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ markdown: PRACTICE_MD, filename: "练习样例.md" }),
  });
  expect(importRes.status).toBe(200);
  unitId =
    ((await importRes.json()) as { data: { units: { id: string }[] } }).data
      .units[0]?.id ?? "";

  aId = await createStudent(app, teacherCookie, "张三");
  await createStudent(app, teacherCookie, "李四");
  aCookie = await loginStudent(app, "张三");
  bCookie = await loginStudent(app, "李四");

  // 教师乙：直插教师行 + 伪造会话（对齐 teacher-notes.test 夹具口径）
  db.insert(teachersTable)
    .values({
      id: TEACHER_B_ID,
      loginName: "乙老师",
      isAdmin: false,
      disabledAt: null,
      passwordHash: "scrypt$correction-test-fixture",
      apiToken: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    .run();
  teacherBCookie = `tutor_session=${
    createTeacherSession(db, TEACHER_B_ID).token
  }`;

  // 直插轮次夹具用的真实快照（取一次真实交卷轮，与解析器形态一致）
  const snapAttempt = await freshAttempt();
  await submitWithFrozen(snapAttempt, Q.solve);
  const snapRow = db
    .select({ snapshot: responsesTable.questionSnapshotJson })
    .from(responsesTable)
    .where(
      and(
        eq(responsesTable.attemptId, snapAttempt),
        eq(responsesTable.questionId, Q.solve),
      ),
    )
    .get();
  if (snapRow?.snapshot == null) {
    throw new Error("取真实快照失败（测试世界已坏）");
  }
  solveSnapshotJson = snapRow.snapshot;
});

/** 每测试取新 attempt（张三的新作业卷，笔记数据按 attempt 天然隔离） */
function freshAttempt(): Promise<string> {
  return freshNoteAttempt(app, teacherCookie, unitId, [aId], aCookie);
}

interface PhasePutOptions {
  baseRevision?: number;
  mutationId?: string;
  phase?: string;
}

/** PUT 笔记正文（multipart；phase 可选——不传走缺省 scratch） */
function putNotePhase(
  attemptId: string,
  questionId: string,
  strokes: number,
  options: PhasePutOptions = {},
  cookie: string = aCookie,
): Promise<Response> {
  const form = new FormData();
  form.append(
    "body",
    new Blob([gzipJson(noteDoc(strokes))], { type: "application/gzip" }),
    "note.json.gz",
  );
  form.append("baseRevision", String(options.baseRevision ?? 0));
  form.append("mutationId", options.mutationId ?? randomUUID());
  if (options.phase !== undefined) {
    form.append("phase", options.phase);
  }
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/notes/${questionId}`, {
      method: "PUT",
      headers: cookie === undefined ? {} : { cookie },
      body: form,
    }),
  );
}

/** POST 创建订正（JSON body：{copyFromOriginal}） */
function createCorrectionReq(
  attemptId: string,
  questionId: string,
  copyFromOriginal: boolean,
  cookie: string = aCookie,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/student/attempts/${attemptId}/notes/${questionId}/corrections`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ copyFromOriginal }),
      },
    ),
  );
}

/** POST 封存订正（JSON body：{baseRevision, stuckAt?, errorCause?}） */
function sealReq(
  attemptId: string,
  questionId: string,
  body: { baseRevision: number; stuckAt?: string; errorCause?: string },
  cookie: string = aCookie,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/student/attempts/${attemptId}/notes/${questionId}/corrections/seal`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      },
    ),
  );
}

/** GET 题目笔记本 */
function notebookReq(
  questionId: string,
  cookie: string = aCookie,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/student/notebook/questions/${questionId}`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
  );
}

/** 张三 + 指定题的 scratch 上传 + 新客户端证据交卷（订正前置链路） */
async function submitWithFrozen(
  attemptId: string,
  questionId: string,
): Promise<{ versionId: string }> {
  const form = new FormData();
  form.append(
    "body",
    new Blob([gzipJson(noteDoc(2, 33))], { type: "application/gzip" }),
    "note.json.gz",
  );
  form.append("baseRevision", "0");
  form.append("mutationId", randomUUID());
  const put = await app.request(
    `/api/student/attempts/${attemptId}/notes/${questionId}`,
    { method: "PUT", headers: { cookie: aCookie }, body: form },
  );
  if (put.status !== 200) throw new Error(`前置 PUT 失败：${put.status}`);
  const versionId = ((await put.json()) as { data: { versionId: string } }).data
    .versionId;
  const submit = await submitAttemptRequestWithEvidence(
    app,
    aCookie,
    db,
    attemptId,
  );
  if (submit.status !== 200) throw new Error(`前置交卷失败：${submit.status}`);
  return { versionId };
}

// ---------- 题面/解析扩展的专用夹具（公布 gate 矩阵） ----------

/** p4-q7 的真实快照 JSON（beforeAll 取自真实交卷轮，与解析器形态一致） */
let solveSnapshotJson = "";

/**
 * 布置带公布口径的作业并交卷，返回 attemptId（after_due 矩阵专用——真实走
 * 「布置 → 开卷 → 证据交卷」，答案口径经作业 API 的组合校验）。
 */
async function freshSubmittedWithRelease(
  answerRelease: "on_submit" | "after_due",
  dueAt: string,
): Promise<{ attemptId: string; assignmentId: string }> {
  const createRes = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      unitIds: [unitId],
      studentIds: [aId],
      answerRelease,
      dueAt,
    }),
  });
  if (createRes.status !== 201) {
    throw new Error(`布置作业失败：${createRes.status}`);
  }
  const assignmentId = (
    (await createRes.json()) as { data: { assignments: { id: string }[] } }
  ).data.assignments[0]?.id;
  if (assignmentId === undefined) throw new Error("布置作业响应缺少作业 id");
  const attemptRes = await app.request(
    `/api/student/assignments/${assignmentId}/attempt`,
    { method: "POST", headers: { cookie: aCookie } },
  );
  if (attemptRes.status !== 200) {
    throw new Error(`开卷失败：${attemptRes.status}`);
  }
  const attemptId = ((await attemptRes.json()) as { data: { id: string } }).data
    .id;
  const submit = await submitAttemptRequestWithEvidence(
    app,
    aCookie,
    db,
    attemptId,
  );
  if (submit.status !== 200) throw new Error(`交卷失败：${submit.status}`);
  return { attemptId, assignmentId };
}

/**
 * 直插一卷已交卷的 course/lesson 轮（response 快照复用真实解析形态）。
 * lesson 的行级 submittedAt 可控——「整卷交卷但当题未提交」正常流程不可达
 * （整卷收尾对剩余行写交卷时刻），防御分支照 teaching-policy-service.test
 * 的直插先例构造。
 */
async function insertSubmittedRound(
  sourceType: "course" | "lesson",
  opts: {
    /** course 轮传真实单元 id（来源标签可读）；lesson 恒 null（兜底链） */
    unitId?: string;
    /** 缺省 = 已提交（整卷收尾口径）；显式 null 构造防御分支 */
    responseSubmittedAt?: string | null;
  } = {},
): Promise<string> {
  const now = new Date().toISOString();
  const attemptId = randomUUID();
  db.insert(attemptsTable)
    .values({
      id: attemptId,
      studentId: aId,
      sourceType,
      assignmentId: null,
      courseId: null,
      unitId: opts.unitId ?? null,
      lectureId: null,
      attemptNo: 1,
      status: "submitted",
      startedAt: now,
      submittedAt: now,
      frozenAt: now,
      legacyUnverified: false,
      abandonedAt: null,
    })
    .run();
  db.insert(responsesTable)
    .values({
      id: randomUUID(),
      attemptId,
      questionId: Q.solve,
      unitId: null,
      questionVersion: 1,
      questionSnapshotJson: solveSnapshotJson,
      answerJson: null,
      // 显式 null 必须落 null（?? 会把防御分支的 null 吞成缺省 now）
      submittedAt:
        "responseSubmittedAt" in opts ? opts.responseSubmittedAt : now,
    })
    .run();
  return attemptId;
}

/** 该 attempt 该题的全部 correction 行（路由测试的库侧断言用） */
function correctionRows(attemptId: string, questionId: string) {
  return db
    .select()
    .from(notesTable)
    .where(
      and(
        eq(notesTable.attemptId, attemptId),
        eq(notesTable.questionId, questionId),
        eq(notesTable.phase, "correction"),
      ),
    )
    .all();
}

// ---------- 鉴权与状态门槛矩阵 ----------

describe("门口矩阵（401/403/404/未交卷）", () => {
  it("未登录 401：PUT phase / create / seal / notebook 四端点", async () => {
    const attemptId = await freshAttempt();
    expect(
      (await putNotePhase(attemptId, Q.solve, 1, { phase: "correction" }, ""))
        .status,
    ).toBe(401);
    expect(
      (await createCorrectionReq(attemptId, Q.solve, false, "")).status,
    ).toBe(401);
    expect(
      (await sealReq(attemptId, Q.solve, { baseRevision: 1 }, "")).status,
    ).toBe(401);
    expect((await notebookReq(Q.solve, "")).status).toBe(401);
  });

  it("他人 attempt 403；域外 attempt 404；题不在卷 404", async () => {
    const attemptId = await freshAttempt();
    expect(
      (
        await putNotePhase(
          attemptId,
          Q.solve,
          1,
          { phase: "correction" },
          bCookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (await createCorrectionReq(attemptId, Q.solve, false, bCookie)).status,
    ).toBe(403);
    expect(
      (await sealReq(attemptId, Q.solve, { baseRevision: 1 }, bCookie)).status,
    ).toBe(403);
    const ghost = randomUUID();
    expect((await createCorrectionReq(ghost, Q.solve, false)).status).toBe(404);
    expect((await sealReq(ghost, Q.solve, { baseRevision: 1 })).status).toBe(
      404,
    );
    expect(
      (
        await putNotePhase(attemptId, "not-in-paper", 1, {
          phase: "correction",
        })
      ).status,
    ).toBe(404);
    expect(
      (await createCorrectionReq(attemptId, "not-in-paper", false)).status,
    ).toBe(404);
  });

  it("draft attempt：correction·supplement PUT、create、seal 全部 409 NOTE_NOT_SUBMITTED", async () => {
    const attemptId = await freshAttempt();
    for (const phase of ["correction", "supplement"] as const) {
      const res = await putNotePhase(attemptId, Q.solve, 1, { phase });
      expect(res.status).toBe(409);
      expect(((await res.json()) as ApiErr).error).toBe("NOTE_NOT_SUBMITTED");
    }
    const create = await createCorrectionReq(attemptId, Q.solve, false);
    expect(create.status).toBe(409);
    expect(((await create.json()) as ApiErr).error).toBe("NOTE_NOT_SUBMITTED");
    const seal = await sealReq(attemptId, Q.solve, { baseRevision: 1 });
    expect(seal.status).toBe(409);
    expect(((await seal.json()) as ApiErr).error).toBe("NOTE_NOT_SUBMITTED");
  });
});

// ---------- PUT phase 路由解析 ----------

describe("PUT notes 的 phase 字段（multipart 可选，缺省 scratch）", () => {
  it("不传 phase → scratch 既有行为（draft 可写，行 phase=scratch）", async () => {
    const attemptId = await freshAttempt();
    const res = await putNotePhase(attemptId, Q.solve, 1);
    expect(res.status).toBe(200);
    expect(noteRowOf(db, attemptId, Q.solve)?.phase).toBe("scratch");
  });

  it("传非法 phase 值 → 400 VALIDATION_ERROR（契约值域拦截）", async () => {
    const attemptId = await freshAttempt();
    const res = await putNotePhase(attemptId, Q.solve, 1, {
      phase: "original",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
    // phase 传 scratch 显式值合法
    const ok = await putNotePhase(attemptId, Q.solve, 1, { phase: "scratch" });
    expect(ok.status).toBe(200);
  });

  it("交卷后：correction/supplement PUT 走对应 phase 行；回执过契约与泄露检查", async () => {
    const attemptId = await freshAttempt();
    await submitWithFrozen(attemptId, Q.solve);
    const corr = await putNotePhase(attemptId, Q.solve, 1, {
      phase: "correction",
    });
    expect(corr.status).toBe(200);
    expect(correctionRows(attemptId, Q.solve)).toHaveLength(1);
    assertNoLeak(await corr.json());
    const sup = await putNotePhase(attemptId, Q.apply, 1, {
      phase: "supplement",
    });
    expect(sup.status).toBe(200);
    assertNoLeak(await sup.json());
  });
});

// ---------- 创建与封存语义 ----------

describe("corrections 创建 / seal 语义", () => {
  it("创建空白订正：201 + 头投影过契约，corrections[0] 为 revision 0 空行", async () => {
    const attemptId = await freshAttempt();
    await submitWithFrozen(attemptId, Q.solve);
    const res = await createCorrectionReq(attemptId, Q.solve, false);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: unknown };
    expect(noteHeadDataSchema.safeParse(body.data).success).toBe(true);
    assertNoLeak(body);
    const corrections = (body.data as { corrections: unknown[] }).corrections;
    expect(corrections).toHaveLength(1);
  });

  it("复制原稿创建：revision=1、hash 与原稿一致（同 canonical 重铸）", async () => {
    const attemptId = await freshAttempt();
    const { versionId } = await submitWithFrozen(attemptId, Q.solve);
    const res = await createCorrectionReq(attemptId, Q.solve, true);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: {
        corrections: { revision: number; currentVersionId: string | null }[];
      };
    };
    const corr = body.data.corrections[0];
    expect(corr?.revision).toBe(1);
    expect(corr?.currentVersionId).not.toBe(versionId); // 新版本行，不共用
  });

  it("已存在未封存行再创建 → 409 NOTE_CORRECTION_OPEN_EXISTS", async () => {
    const attemptId = await freshAttempt();
    await submitWithFrozen(attemptId, Q.solve);
    await createCorrectionReq(attemptId, Q.solve, false);
    const dup = await createCorrectionReq(attemptId, Q.solve, false);
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as ApiErr).error).toBe(
      "NOTE_CORRECTION_OPEN_EXISTS",
    );
  });

  it("copyFromOriginal 但证据 missing/none/无行 → 409 NOTE_ORIGINAL_UNAVAILABLE", async () => {
    // missing 交卷（显式声明缺稿）
    const attemptId = await freshAttempt();
    const revisions = await fetchSubmitRevisions(app, aCookie, attemptId);
    const evidence: SubmitEvidenceDeclaration[] = revisions.map(
      ({ questionId }) => ({ questionId, state: "missing" as const }),
    );
    const submit = await submitAttemptRequest(
      app,
      aCookie,
      attemptId,
      evidence,
    );
    expect(submit.status).toBe(200);
    const res = await createCorrectionReq(attemptId, Q.solve, true);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe(
      "NOTE_ORIGINAL_UNAVAILABLE",
    );
    // none 证据（无稿交卷）同拒
    const attempt2 = await freshAttempt();
    const revisions2 = await fetchSubmitRevisions(app, aCookie, attempt2);
    const evidence2: SubmitEvidenceDeclaration[] = revisions2.map(
      ({ questionId }) => ({ questionId, state: "none" as const }),
    );
    const submit2 = await submitAttemptRequest(
      app,
      aCookie,
      attempt2,
      evidence2,
    );
    expect(submit2.status).toBe(200);
    const res2 = await createCorrectionReq(attempt2, Q.solve, true);
    expect(res2.status).toBe(409);
    expect(((await res2.json()) as ApiErr).error).toBe(
      "NOTE_ORIGINAL_UNAVAILABLE",
    );
    // 无证据行（旧客户端交卷）同拒
    const attempt3 = await freshAttempt();
    const submit3 = await submitAttemptRequest(app, aCookie, attempt3);
    expect(submit3.status).toBe(200);
    const res3 = await createCorrectionReq(attempt3, Q.solve, true);
    expect(res3.status).toBe(409);
    expect(((await res3.json()) as ApiErr).error).toBe(
      "NOTE_ORIGINAL_UNAVAILABLE",
    );
  });

  it("seal 成功（含反思）；再 seal → 404（无未封存行）；已封存行 PUT → 409 SEALED", async () => {
    const attemptId = await freshAttempt();
    await submitWithFrozen(attemptId, Q.solve);
    const create = await createCorrectionReq(attemptId, Q.solve, true);
    expect(create.status).toBe(201);
    const seal = await sealReq(attemptId, Q.solve, {
      baseRevision: 1,
      stuckAt: "第二问的图没画对",
      errorCause: "辅助线做法没想到",
    });
    expect(seal.status).toBe(200);
    const sealBody = (await seal.json()) as {
      data: {
        corrections: { sealedAt: string | null; stuckAt: string | null }[];
      };
    };
    const corr = sealBody.data.corrections[0];
    expect(corr?.sealedAt).not.toBeNull();
    expect(corr?.stuckAt).toBe("第二问的图没画对");
    assertNoLeak(sealBody);
    // 再 seal（无未封存行）→ 404
    const again = await sealReq(attemptId, Q.solve, { baseRevision: 1 });
    expect(again.status).toBe(404);
    expect(((await again.json()) as ApiErr).error).toBe("NOTE_NOT_FOUND");
    // 已封存行 PUT → SEALED
    const put = await putNotePhase(attemptId, Q.solve, 2, {
      phase: "correction",
      baseRevision: 1,
    });
    expect(put.status).toBe(409);
    expect(((await put.json()) as ApiErr).error).toBe("NOTE_CORRECTION_SEALED");
  });

  it("seal baseRevision 落后 → 409 NOTE_REVISION_CONFLICT 附 _current", async () => {
    const attemptId = await freshAttempt();
    await submitWithFrozen(attemptId, Q.solve);
    await createCorrectionReq(attemptId, Q.solve, false);
    await putNotePhase(attemptId, Q.solve, 1, { phase: "correction" });
    await putNotePhase(attemptId, Q.solve, 2, {
      phase: "correction",
      baseRevision: 1,
    });
    const stale = await sealReq(attemptId, Q.solve, { baseRevision: 1 });
    expect(stale.status).toBe(409);
    const err = (await stale.json()) as ApiErr & {
      _current?: { revision: number };
    };
    expect(err.error).toBe("NOTE_REVISION_CONFLICT");
    expect(err._current?.revision).toBe(2);
  });
});

// ---------- 订正清空不改 original（任务矩阵 1，真实交卷链路） ----------

describe("订正清空不改 original", () => {
  it("frozen 交卷 → 复制原稿建订正 → 上传空稿 → 证据 versionId/hash 与原稿不变", async () => {
    const attemptId = await freshAttempt();
    const { versionId } = await submitWithFrozen(attemptId, Q.solve);
    const create = await createCorrectionReq(attemptId, Q.solve, true);
    expect(create.status).toBe(201);
    // 上传空稿（strokes=[]）清空订正
    const form = new FormData();
    form.append(
      "body",
      new Blob([gzipJson(noteDoc(0))], { type: "application/gzip" }),
      "note.json.gz",
    );
    form.append("baseRevision", "1");
    form.append("mutationId", randomUUID());
    form.append("phase", "correction");
    const clear = await app.request(
      `/api/student/attempts/${attemptId}/notes/${Q.solve}`,
      { method: "PUT", headers: { cookie: aCookie }, body: form },
    );
    expect(clear.status).toBe(200);
    // 证据行原样指向原稿
    const evidenceRow = db
      .select()
      .from(submissionEvidenceTable)
      .where(
        and(
          eq(submissionEvidenceTable.attemptId, attemptId),
          eq(submissionEvidenceTable.questionId, Q.solve),
        ),
      )
      .get();
    expect(evidenceRow).toMatchObject({ state: "frozen", versionId });
  });
});

// ---------- 跨 attempt 错挂与跨笔记重放（矩阵 2） ----------

describe("跨 attempt 归属与 mutationId 跨笔记重放", () => {
  it("同生两 attempt 含同 qid：A 的订正 PUT 到 B 的 URL 属 B 域正常创建；A 的 corrections 不变", async () => {
    const attemptA = await freshAttempt();
    const attemptB = await freshAttempt();
    await submitWithFrozen(attemptA, Q.solve);
    await submitWithFrozen(attemptB, Q.solve);
    // A 上建好一份订正
    await createCorrectionReq(attemptA, Q.solve, false);
    await putNotePhase(attemptA, Q.solve, 1, { phase: "correction" });
    // 同一正文 PUT 到 B 的 URL——结构性归属：URL 即归属，B 域独立建行
    const putB = await putNotePhase(attemptB, Q.solve, 1, {
      phase: "correction",
    });
    expect(putB.status).toBe(200);
    const rowsA = correctionRows(attemptA, Q.solve);
    const rowsB = correctionRows(attemptB, Q.solve);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0]?.id).not.toBe(rowsB[0]?.id);
    // mutationId 跨笔记重放：A 行的 mutationId 拿去 PUT B → MISMATCH
    const m = randomUUID();
    const putA2 = await putNotePhase(attemptA, Q.solve, 2, {
      phase: "correction",
      baseRevision: 1,
      mutationId: m,
    });
    expect(putA2.status).toBe(200);
    const replayB = await putNotePhase(attemptB, Q.solve, 2, {
      phase: "correction",
      baseRevision: 1,
      mutationId: m,
    });
    expect(replayB.status).toBe(409);
    expect(((await replayB.json()) as ApiErr).error).toBe(
      "NOTE_MUTATION_MISMATCH",
    );
  });
});

// ---------- 并发订正冲突可恢复（矩阵 3） ----------

describe("并发订正冲突可恢复", () => {
  it("同 baseRevision 两次 PUT → 一成功一 409 附 _current → 对齐后重放成功（两份内容先后落版本）", async () => {
    const attemptId = await freshAttempt();
    await submitWithFrozen(attemptId, Q.solve);
    await createCorrectionReq(attemptId, Q.solve, false);
    const first = await putNotePhase(attemptId, Q.solve, 1, {
      phase: "correction",
    });
    expect(first.status).toBe(200);
    const second = await putNotePhase(attemptId, Q.solve, 2, {
      phase: "correction",
    });
    expect(second.status).toBe(409);
    const err = (await second.json()) as ApiErr & { _current?: unknown };
    expect(err.error).toBe("NOTE_REVISION_CONFLICT");
    expect(err._current).toBeDefined();
    const third = await putNotePhase(attemptId, Q.solve, 2, {
      phase: "correction",
      baseRevision: 1,
    });
    expect(third.status).toBe(200);
    expect(
      ((await third.json()) as { data: { revision: number } }).data.revision,
    ).toBe(2);
  });
});

// ---------- 软删题历史权限（矩阵 4） ----------

describe("来源题软删仍按历史权限", () => {
  it("软删 question 后 correction create/PUT/seal/notebook 全通（responses 行在即可）", async () => {
    const attemptId = await freshAttempt();
    await submitWithFrozen(attemptId, Q.solve);
    // 软删该题（题目只软删红线；responses 行与快照不动）
    db.$client
      .prepare(
        "UPDATE questions SET deleted_at = '2026-10-06T00:00:00.000Z' WHERE id = ?",
      )
      .run(Q.solve);
    const create = await createCorrectionReq(attemptId, Q.solve, true);
    expect(create.status).toBe(201);
    const put = await putNotePhase(attemptId, Q.solve, 2, {
      phase: "correction",
      baseRevision: 1,
    });
    expect(put.status).toBe(200);
    const seal = await sealReq(attemptId, Q.solve, { baseRevision: 2 });
    expect(seal.status).toBe(200);
    const notebook = await notebookReq(Q.solve);
    expect(notebook.status).toBe(200);
    const data = (
      (await notebook.json()) as {
        data: { rounds: { attemptId: string; corrections: unknown[] }[] };
      }
    ).data;
    const round = data.rounds.find((r) => r.attemptId === attemptId);
    expect(round?.corrections).toHaveLength(1);
    // 还原软删，避免污染共享世界的其他用例
    db.$client
      .prepare("UPDATE questions SET deleted_at = NULL WHERE id = ?")
      .run(Q.solve);
  });
});

// ---------- 看解析后材料始终标订正（矩阵 5） ----------

describe("看解析后材料始终标订正", () => {
  it("交卷→建订正：GET evidence 的 corrections 在列且 phase=correction；evidence 永不指向订正行", async () => {
    const attemptId = await freshAttempt();
    const { versionId } = await submitWithFrozen(attemptId, Q.solve);
    await createCorrectionReq(attemptId, Q.solve, false);
    await putNotePhase(attemptId, Q.solve, 1, { phase: "correction" });
    const evidenceRes = await app.request(
      `/api/student/attempts/${attemptId}/evidence/${Q.solve}`,
      { headers: { cookie: aCookie } },
    );
    expect(evidenceRes.status).toBe(200);
    const head = (
      (await evidenceRes.json()) as {
        data: {
          corrections: { phase: string; currentVersionId: string | null }[];
          evidence: { versionId: string | null } | null;
        };
      }
    ).data;
    expect(head.corrections).toHaveLength(1);
    expect(head.corrections[0]?.phase).toBe("correction");
    // 原稿位仍是 frozen 原稿（订正行结构上进不了 evidence）
    expect(head.evidence).toMatchObject({ state: "frozen", versionId });
    // notebook 该轮 corrections 在列
    const notebook = (
      (await (await notebookReq(Q.solve)).json()) as {
        data: {
          rounds: {
            corrections: unknown[];
            evidence: { versionId: string | null } | null;
          }[];
        };
      }
    ).data;
    const round = notebook.rounds.find(
      (r) => r.evidence?.versionId === versionId,
    );
    expect(round?.corrections).toHaveLength(1);
  });
});

// ---------- 找回稿不能升级成原稿（矩阵 6） ----------

describe("找回稿不能升级成原稿", () => {
  it("missing 交卷 → supplement PUT 成功 → 证据行不变、GET evidence 不回退工作头、再次交卷 409", async () => {
    const attemptId = await freshAttempt();
    // 交卷前本地有 scratch（找回场景：交卷声明 missing）
    await putNotePhase(attemptId, Q.solve, 1);
    const revisions = await fetchSubmitRevisions(app, aCookie, attemptId);
    const evidence: SubmitEvidenceDeclaration[] = revisions.map(
      ({ questionId }) => ({ questionId, state: "missing" as const }),
    );
    const submit = await submitAttemptRequest(
      app,
      aCookie,
      attemptId,
      evidence,
    );
    expect(submit.status).toBe(200);
    // 交卷后找回：supplement PUT 成功
    const sup = await putNotePhase(attemptId, Q.apply, 1, {
      phase: "supplement",
    });
    expect(sup.status).toBe(200);
    // 证据行仍 missing/null
    const evidenceRow = db
      .select()
      .from(submissionEvidenceTable)
      .where(
        and(
          eq(submissionEvidenceTable.attemptId, attemptId),
          eq(submissionEvidenceTable.questionId, Q.apply),
        ),
      )
      .get();
    expect(evidenceRow).toMatchObject({ state: "missing", versionId: null });
    // GET evidence：证据行存在 → 生效版本不回退工作头（images 恒空）
    const evidenceRes = await app.request(
      `/api/student/attempts/${attemptId}/evidence/${Q.apply}`,
      { headers: { cookie: aCookie } },
    );
    const head = (
      (await evidenceRes.json()) as {
        data: {
          images: unknown[];
          evidence: { state: string } | null;
          supplements: unknown[];
        };
      }
    ).data;
    expect(head.images).toEqual([]);
    expect(head.evidence).toMatchObject({ state: "missing" });
    expect(head.supplements).toHaveLength(1);
    // 再次交卷被拒
    const resubmit = await submitAttemptRequestWithEvidence(
      app,
      aCookie,
      db,
      attemptId,
    );
    expect(resubmit.status).toBe(409);
    expect(((await resubmit.json()) as ApiErr).error).toBe("ALREADY_SUBMITTED");
  });
});

// ---------- 笔记本聚合与泄露（矩阵 7/9） ----------

describe("题目笔记本 GET /notebook/questions/:qid", () => {
  /** released 场景的泄露断言选项：allow 与结果视图 released 场景同口径；
   * forbid 补回原「questions」守卫（assertNoLeak 默认集无该键，聚合响应
   * 若回归出整卷题面数组须报警） */
  const RELEASED_LEAK_OPTS = {
    allow: ["answers", "answer", "solutionMd"],
    forbid: ["questions"],
  } as const;
  it("两轮跨来源聚合 + 契约 schema + 零题干答案深检查", async () => {
    // 轮 1：作业卷（assignment 来源，真实作业标题）
    const attempt1 = await freshAttempt();
    await submitWithFrozen(attempt1, Q.solve);
    await createCorrectionReq(attempt1, Q.solve, true);
    await sealReq(attempt1, Q.solve, {
      baseRevision: 1,
      errorCause: "审题不清",
    });
    // 轮 2：再练一份（新作业卷）
    const attempt2 = await freshAttempt();
    await submitWithFrozen(attempt2, Q.solve);
    await putNotePhase(attempt2, Q.solve, 1, { phase: "supplement" });

    const res = await notebookReq(Q.solve);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    expect(studentNotebookOkSchema.safeParse(body).success).toBe(true);
    // released 轮次（on_submit 作业）合法携带 release——answers/answer/solutionMd
    // 键名级放行（与结果视图 released 场景同一口径；allow 是平键名，任何层级
    // 的同名键不再报警：顶层形状锁定由契约测试承担，fail-closed 场景在下方
    // 用例以不带 allow 把关）
    assertNoLeak(body, RELEASED_LEAK_OPTS);
    const data = body.data as StudentNotebookData;
    // 共享世界里前序用例已为同题交过卷（freshAttempt 各自独立）——这里断言
    // 两轮均在列、roundOrdinal 全表从 1 连续递增、逐轮材料正确；跨轮次的
    // submittedAt 排序与轮次号语义在服务层测试用显式时间锁定（路由层两次
    // 交卷可能同毫秒，attemptId 兜底序对这两轮不构成可断言的顺序）
    expect(data.rounds.length).toBeGreaterThanOrEqual(2);
    expect(data.rounds.map((r) => r.roundOrdinal)).toEqual(
      data.rounds.map((_, i) => i + 1),
    );
    const round1 = roundOf(data, attempt1);
    const round2 = roundOf(data, attempt2);
    expect(round1?.sourceType).toBe("assignment");
    expect(typeof round1?.sourceLabel).toBe("string");
    expect(round1?.sourceLabel.length).toBeGreaterThan(0);
    expect(round1?.corrections).toHaveLength(1);
    expect(round1?.supplements).toEqual([]);
    expect(round2?.supplements).toHaveLength(1);
    // 题面与解析（on_submit 交卷即公布）：快照投影的脱敏题干 + 真实答案/详解
    for (const round of [round1, round2]) {
      expect(round?.question).not.toBeNull();
      expect(round?.question?.stemMd).toContain("计算");
      // 题干脱敏口径：详解文本不得混入题面投影（stemMd 与 release 解耦）
      expect(round?.question?.stemMd).not.toContain("先算乘方");
      expect(round?.release).not.toBeNull();
      expect(round?.release?.answers).not.toBeNull();
      expect(round?.release?.solutionMd).toContain("先算乘方");
    }
  });

  it("无轮次题目 → 200 rounds=[]（不探测存在性）", async () => {
    const res = await notebookReq("never-appeared-qid");
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { data: { rounds: unknown[] } }).data.rounds,
    ).toEqual([]);
  });

  /** 按轮次 attemptId 从响应中取该轮（新用例共用） */
  function roundOf(data: StudentNotebookData, attemptId: string) {
    const round = data.rounds.find((r) => r.attemptId === attemptId);
    expect(round, `轮次 ${attemptId} 应在列`).toBeDefined();
    return round;
  }

  it("after_due 截止前：题面照常下发，release null（fail-closed 严格断言）", async () => {
    const { attemptId } = await freshSubmittedWithRelease(
      "after_due",
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    );
    const res = await notebookReq(Q.solve);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: StudentNotebookData };
    expect(studentNotebookOkSchema.safeParse(body).success).toBe(true);
    const round = roundOf(body.data, attemptId);
    // 题面不受公布 gate 约束（已交卷内容，脱敏投影）
    expect(round?.question).not.toBeNull();
    expect(round?.question?.stemMd).toContain("计算");
    // fail-closed：解析整体缺席
    expect(round?.release).toBeNull();
    // 严格断言按本轮圈定（聚合响应含共享世界其他已公布轮次，不能对全 body
    // 严格）：不带 allow——answers/solutionMd 键在本轮任何层级不得出现
    assertNoLeak(round);
    // 内容级哨兵：详解文本在本轮零出现（题干投影不含解析）
    expect(JSON.stringify(round)).not.toContain("先算乘方");
  });

  it("after_due 截止后：release 非空（读时比较，无定时任务）", async () => {
    const { attemptId, assignmentId } = await freshSubmittedWithRelease(
      "after_due",
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    );
    // 直改 dueAt 到过去（作业行由 API 创建；直接到点的下一次请求自然恢复）
    db.update(assignmentsTable)
      .set({ dueAt: new Date(Date.now() - 60 * 1000).toISOString() })
      .where(eq(assignmentsTable.id, assignmentId))
      .run();
    const res = await notebookReq(Q.solve);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: StudentNotebookData };
    const round = roundOf(body.data, attemptId);
    expect(round?.release).not.toBeNull();
    expect(round?.release?.answers).not.toBeNull();
    expect(round?.release?.solutionMd).toContain("先算乘方");
    assertNoLeak(body, RELEASED_LEAK_OPTS);
  });

  it("course 轮恒交卷即公布；lesson 轮按题级 submittedAt（防御分支直插）", async () => {
    const courseAttempt = await insertSubmittedRound("course", { unitId });
    const lessonDone = await insertSubmittedRound("lesson");
    const lessonDefensive = await insertSubmittedRound("lesson", {
      // 防御分支（正常流程不可达）：整卷收尾必对剩余行写 submittedAt，
      // 此处直插行级 null 锁「口径按题级行值，不回看 attempt 级状态」
      responseSubmittedAt: null,
    });
    const res = await notebookReq(Q.solve);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: StudentNotebookData };
    // course：D11 恒交卷即公布
    expect(roundOf(body.data, courseAttempt)?.release).not.toBeNull();
    // lesson：题级行值已提交 → 当题公布
    expect(roundOf(body.data, lessonDone)?.release).not.toBeNull();
    // lesson 防御分支：行级 null → 未公布
    expect(roundOf(body.data, lessonDefensive)?.release).toBeNull();
    assertNoLeak(body, RELEASED_LEAK_OPTS);
  });

  it("快照缺失 → question null 且 release null，接口 200（不回填 live 题）", async () => {
    const attemptId = await freshAttempt();
    await submitWithFrozen(attemptId, Q.solve);
    db.update(responsesTable)
      .set({ questionSnapshotJson: null })
      .where(
        and(
          eq(responsesTable.attemptId, attemptId),
          eq(responsesTable.questionId, Q.solve),
        ),
      )
      .run();
    const res = await notebookReq(Q.solve);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: StudentNotebookData };
    const round = roundOf(body.data, attemptId);
    expect(round?.question).toBeNull();
    // 解析从快照投影：快照缺失时即便已公布也无从下发（fail closed）
    expect(round?.release).toBeNull();
    // 严格断言按本轮圈定（同上：聚合响应含其他已公布轮次）
    assertNoLeak(round);
  });

  it("作业软删后 release 照常公布（作答记录不随作业软删消失）", async () => {
    const { attemptId, assignmentId } = await freshSubmittedWithRelease(
      "on_submit",
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    );
    db.update(assignmentsTable)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(assignmentsTable.id, assignmentId))
      .run();
    const res = await notebookReq(Q.solve);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: StudentNotebookData };
    const round = roundOf(body.data, attemptId);
    expect(round?.question).not.toBeNull();
    expect(round?.release).not.toBeNull();
    expect(round?.release?.solutionMd).toContain("先算乘方");
    assertNoLeak(body, RELEASED_LEAK_OPTS);
  });
});

// ---------- 教师侧（矩阵 10） ----------

describe("教师侧 evidence 含 corrections/supplements；跨教师 404", () => {
  it("教师甲读本人学生的 evidence：两数组在列；教师乙 404 不变", async () => {
    const attemptId = await freshAttempt();
    await submitWithFrozen(attemptId, Q.solve);
    await createCorrectionReq(attemptId, Q.solve, false);
    await putNotePhase(attemptId, Q.solve, 1, { phase: "correction" });
    await putNotePhase(attemptId, Q.apply, 1, { phase: "supplement" });

    const ok = await app.request(
      `/api/teacher/attempts/${attemptId}/evidence/${Q.solve}`,
      { headers: { cookie: teacherCookie } },
    );
    expect(ok.status).toBe(200);
    const head = (
      (await ok.json()) as {
        data: { corrections: unknown[]; supplements: unknown[] };
      }
    ).data;
    expect(head.corrections).toHaveLength(1);
    expect(head.supplements).toHaveLength(0);
    const okApply = await app.request(
      `/api/teacher/attempts/${attemptId}/evidence/${Q.apply}`,
      { headers: { cookie: teacherCookie } },
    );
    const headApply = (
      (await okApply.json()) as {
        data: { supplements: unknown[] };
      }
    ).data;
    expect(headApply.supplements).toHaveLength(1);

    const denied = await app.request(
      `/api/teacher/attempts/${attemptId}/evidence/${Q.solve}`,
      { headers: { cookie: teacherBCookie } },
    );
    expect(denied.status).toBe(404);
    expect(((await denied.json()) as ApiErr).error).toBe("ATTEMPT_NOT_FOUND");
  });
});
