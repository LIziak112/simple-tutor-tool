import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  type ApiErr,
  attemptResultOkSchema,
  type NoteVersionReceipt,
  noteHeadDataSchema,
  noteVersionReceiptSchema,
  type SubmitEvidenceDeclaration,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createDb, type Db } from "../db/client.ts";
import {
  attemptSettlements,
  attempts as attemptsTable,
  submissionEvidence as evidenceTable,
  noteVersions,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { purgeOpenedAttempts } from "../services/attempt-opened-purge.ts";
import {
  reserveSubmissionOriginals,
  settleSubmissionOriginalReservation,
} from "../services/attempt-original-reservation.ts";
import {
  gcNoteVersions,
  NOTE_GC_SAFETY_WINDOW_MS,
} from "../services/note-gc.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  gzipJson,
  makeNotePng,
  noteDoc,
  noteImageForm,
  putNoteBodyForm,
  putNoteReceipt,
} from "../test/note-fixtures.ts";
import {
  createStudent,
  extractSessionToken,
  freshNoteAttempt,
  insertEvidence,
  loginStudent,
  noteRowOf,
} from "../test/note-world.ts";
import {
  fetchSubmitRevisions,
  submitAttemptRequest,
} from "../test/submit-revisions.ts";

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
let databasePath: string;
let teacherCookie: string;
let unitId: string;
let aId: string;
let aCookie: string;

function mountApp(db: Db, dataDir: string): App {
  return createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    dataDir,
    publicUrl: "http://localhost:8787",
  });
}

async function createEvidenceFixture() {
  const dataDir = createTestDir();
  const databasePath = join(dataDir, "attempt-submit-evidence.sqlite");
  const template = createTestDb();
  writeFileSync(databasePath, template.$client.serialize());
  template.$client.close();
  const db = createDb(databasePath);
  const app = mountApp(db, dataDir);
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password: TEACHER_PASSWORD }),
  });
  const teacherCookie = `tutor_session=${extractSessionToken(setup)}`;
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
  const aId = await createStudent(app, teacherCookie, "张三", STUDENT_PASSWORD);
  const aCookie = await loginStudent(app, "张三", STUDENT_PASSWORD);
  return {
    db,
    app,
    dataDir,
    databasePath,
    teacherCookie,
    unitId: firstUnit.id,
    aId,
    aCookie,
  };
}

beforeAll(async () => {
  ({ db, app, dataDir, databasePath, teacherCookie, unitId, aId, aCookie } =
    await createEvidenceFixture());
});

afterAll(() => {
  db?.$client.close();
});

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

/** 交卷（携带 evidence；revisions/evidence 组装收敛在 submitAttemptRequest） */
function submitWith(
  attemptId: string,
  evidence?: SubmitEvidenceDeclaration[],
): Promise<Response> {
  return Promise.resolve(
    submitAttemptRequest(app, aCookie, attemptId, evidence),
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

/** 全卷声明组装（成功路径高频形态）：notedId 按回执冻结、其余题 none */
function declarationsWithFrozen(
  ids: readonly string[],
  notedId: string,
  receipt: NoteVersionReceipt,
): SubmitEvidenceDeclaration[] {
  return ids.map((questionId) =>
    questionId === notedId
      ? {
          questionId,
          state: "frozen" as const,
          versionId: receipt.versionId,
          revision: receipt.revision,
        }
      : { questionId, state: "none" as const },
  );
}

// ---------- 冻结原稿主链 ----------

describe("T6R.10 交卷固定原稿：frozen 主链", () => {
  it("有稿题 frozen 固定 head 版本、无稿题 none 落行、其余未采集语义=新客户端全覆盖", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    const notedId = qAt(ids, 0);
    const receipt1 = await putNoteReceipt(app, aCookie, attemptId, notedId, 2);
    const head = noteRowOf(db, attemptId, notedId);
    expect(head?.currentRevision).toBe(1);

    const res = await submitWith(
      attemptId,
      declarationsWithFrozen(ids, notedId, receipt1),
    );
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
    const receipt2 = await putNoteReceipt(app, aCookie, attemptId, notedId, 3, {
      baseRevision: 1,
    });

    const res = await submitWith(
      attemptId,
      declarationsWithFrozen(ids, notedId, receipt2),
    );
    expect(res.status).toBe(200);
    const frozenRow = evidenceRowsOf(attemptId).find(
      (r) => r.questionId === notedId,
    );
    expect(frozenRow?.state).toBe("frozen");
    expect(frozenRow?.versionId).toBe(receipt2.versionId);
  });

  it("有工作稿时明示 missing，重开数据库并原样重发仍无原稿引用", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    const notedId = qAt(ids, 1);
    const attemptPath = `/api/student/attempts/${attemptId}`;
    const headers = { cookie: aCookie, "content-type": "application/json" };
    const working = await putNoteReceipt(app, aCookie, attemptId, notedId);
    expect(working.revision).toBe(1);
    const answer = { kind: "choice", index: 1 } as const;
    const saved = await app.request(`${attemptPath}/answers/${notedId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ answer }),
    });
    expect(saved.status).toBe(200);
    const revisions = await fetchSubmitRevisions(app, aCookie, attemptId);
    const evidence: SubmitEvidenceDeclaration[] = ids.map((questionId) => ({
      questionId,
      state: questionId === notedId ? "missing" : "none",
    }));
    const body = JSON.stringify({ revisions, evidence });
    const submit = () =>
      app.request(`${attemptPath}/submit`, { method: "POST", headers, body });

    const submitted = await submit();
    expect(submitted.status).toBe(200);
    const { data: result } = attemptResultOkSchema.parse(
      await submitted.json(),
    );
    expect(
      result.units
        .flatMap((unit) => unit.questions)
        .find((row) => row.questionId === notedId),
    ).toMatchObject({ answer, autoCorrect: true, finalCorrect: true });

    const rows = evidenceRowsOf(attemptId);
    expect(rows).toHaveLength(ids.length);
    expect(
      new Map(
        rows.map(({ questionId, state, versionId }) => [
          questionId,
          { state, versionId },
        ]),
      ),
    ).toEqual(
      new Map(
        evidence.map(({ questionId, state }) => [
          questionId,
          { state, versionId: null },
        ]),
      ),
    );

    const readEvidence = async () => {
      const res = await app.request(`${attemptPath}/evidence/${notedId}`, {
        headers: { cookie: aCookie },
      });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { data: unknown };
      assertNoLeak(payload);
      return noteHeadDataSchema.parse(payload.data);
    };
    const before = await readEvidence();
    expect(before).toMatchObject({
      evidence: {
        attemptId,
        questionId: notedId,
        state: "missing",
        versionId: null,
      },
      note: {
        phase: "scratch",
        revision: 1,
        currentVersionId: working.versionId,
      },
      images: [],
      supplements: [],
    });

    const form = putNoteBodyForm(gzipJson(noteDoc(2)));
    form.set("phase", "supplement");
    const supplemental = await app.request(`${attemptPath}/notes/${notedId}`, {
      method: "PUT",
      headers: { cookie: aCookie },
      body: form,
    });
    expect(supplemental.status).toBe(200);
    const payload = (await supplemental.json()) as { data: unknown };
    const supplement = noteVersionReceiptSchema.parse(payload.data);
    expect(supplement.versionId).not.toBe(working.versionId);

    db.$client.close();
    db = createDb(databasePath);
    app = mountApp(db, dataDir);
    const retry = await expectApiErr(submit());
    expect([retry.status, retry.code]).toEqual([409, "ALREADY_SUBMITTED"]);
    expect(evidenceRowsOf(attemptId)).toEqual(rows);
    const after = await readEvidence();
    expect(after.evidence).toEqual(before.evidence);
    expect(after.note).toEqual(before.note);
    expect(after.images).toEqual([]);
    expect(after.supplements).toMatchObject([
      {
        phase: "supplement",
        revision: 1,
        currentVersionId: supplement.versionId,
      },
    ]);
  });
});

describe("M04 原稿保全：跨库确认窗口模型", () => {
  it("正式冻结原稿保留，尚未投影的外部版本引用保护不了被替换的工作头", async () => {
    const fixture = await createEvidenceFixture();
    const { dataDir, databasePath, teacherCookie, unitId, aId, aCookie } =
      fixture;
    let { db, app } = fixture;
    const newAttempt = () =>
      freshNoteAttempt(app, teacherCookie, unitId, [aId], aCookie);
    const readVersion = (id: string) =>
      db.select().from(noteVersions).where(eq(noteVersions.id, id)).get();
    const snapshot = (receipt: NoteVersionReceipt) => {
      const row = readVersion(receipt.versionId);
      if (!row) throw new Error("草稿上传后缺少版本行");
      const file = join(dataDir, row.bodyPath);
      const bytes = readFileSync(file);
      expect(createHash("sha256").update(gunzipSync(bytes)).digest("hex")).toBe(
        receipt.hash,
      );
      expect(row.hash).toBe(receipt.hash);
      return { row, file, bytes };
    };
    const confirm = (attemptId: string) => ({
      attempt: db
        .select()
        .from(attemptsTable)
        .where(eq(attemptsTable.id, attemptId))
        .get(),
      evidence: db
        .select()
        .from(evidenceTable)
        .where(eq(evidenceTable.attemptId, attemptId))
        .all(),
      settlements: db
        .select()
        .from(attemptSettlements)
        .where(eq(attemptSettlements.attemptId, attemptId))
        .all(),
    });

    try {
      const controlId = await newAttempt();
      const revisions = await fetchSubmitRevisions(app, aCookie, controlId);
      const ids = revisions.map(({ questionId }) => questionId);
      const notedId = qAt(ids, 1);
      const frozen = await putNoteReceipt(app, aCookie, controlId, notedId, 1);
      const control = await submitAttemptRequest(
        app,
        aCookie,
        controlId,
        declarationsWithFrozen(ids, notedId, frozen),
      );
      expect(control.status).toBe(200);
      const controlBefore = confirm(controlId);
      expect(controlBefore.attempt?.submittedAt).toEqual(expect.any(String));
      expect(controlBefore.evidence).toHaveLength(ids.length);
      expect(
        controlBefore.evidence.find(({ questionId }) => questionId === notedId),
      ).toMatchObject({ state: "frozen", versionId: frozen.versionId });
      expect(controlBefore.settlements).toMatchObject([{ kind: "final" }]);

      const form = putNoteBodyForm(gzipJson(noteDoc(3)));
      form.set("phase", "supplement");
      const supplemental = await app.request(
        `/api/student/attempts/${controlId}/notes/${notedId}`,
        { method: "PUT", headers: { cookie: aCookie }, body: form },
      );
      expect(supplemental.status).toBe(200);
      const payload = (await supplemental.json()) as { data: unknown };
      const supplement = noteVersionReceiptSchema.parse(payload.data);

      const pendingId = await newAttempt();
      const selected = await putNoteReceipt(
        app,
        aCookie,
        pendingId,
        notedId,
        1,
      );
      const selection = snapshot(selected);
      // 独立文件仅模拟外部引用尚未投影的窗口，不是内核回执。
      const externalReference = join(createTestDir(), "selected-note.json");
      const reference = JSON.stringify({
        attemptId: pendingId,
        questionId: notedId,
        versionId: selected.versionId,
        hash: selected.hash,
      });
      writeFileSync(externalReference, reference);
      const secondSession = await loginStudent(app, "张三", STUDENT_PASSWORD);
      expect(secondSession).not.toBe(aCookie);
      const newer = await putNoteReceipt(
        app,
        secondSession,
        pendingId,
        notedId,
        2,
        { baseRevision: selected.revision },
      );
      expect(noteRowOf(db, pendingId, notedId)?.currentVersionId).toBe(
        newer.versionId,
      );

      const pendingBefore = confirm(pendingId);
      expect(pendingBefore).toMatchObject({
        attempt: { status: "draft", submittedAt: null },
        evidence: [],
        settlements: [],
      });
      const kept = [frozen, supplement, newer].map(snapshot);
      expect(supplement.versionId).not.toBe(frozen.versionId);

      db.$client.close();
      db = createDb(databasePath);
      app = mountApp(db, dataDir);
      expect(readVersion(selected.versionId)).toEqual(selection.row);
      expect(readFileSync(selection.file)).toEqual(selection.bytes);
      const lastSavedAt = Math.max(
        ...[selected, frozen, supplement, newer].map(({ savedAt }) =>
          Date.parse(savedAt),
        ),
      );
      const now = new Date(lastSavedAt + NOTE_GC_SAFETY_WINDOW_MS + 1);
      const gc = gcNoteVersions(db, dataDir, { now });

      expect(readVersion(selected.versionId)).toBeUndefined();
      expect(readFileSync(externalReference, "utf8")).toBe(reference);
      expect(gc).toMatchObject({
        deletedVersionRows: 1,
        deletedFiles: 1,
        keptByReference: 3,
        keptByBackup: 0,
        unreadableBackupDbs: 0,
        fileFailures: 0,
      });
      expect(existsSync(selection.file)).toBe(false);
      const noDocument = await expectApiErr(
        app.request(
          `/api/student/note-versions/${selected.versionId}/document`,
          { headers: { cookie: aCookie } },
        ),
      );
      expect([noDocument.status, noDocument.code]).toEqual([
        404,
        "NOTE_NOT_FOUND",
      ]);
      for (const { row, file, bytes } of kept) {
        expect(readVersion(row.id)).toEqual(row);
        expect(readFileSync(file)).toEqual(bytes);
        const response = await app.request(
          `/api/student/note-versions/${row.id}/document`,
          {
            headers: { cookie: aCookie },
          },
        );
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      }
      expect(noteRowOf(db, pendingId, notedId)?.currentVersionId).toBe(
        newer.versionId,
      );
      expect(confirm(pendingId)).toEqual(pendingBefore);
      expect(confirm(controlId)).toEqual(controlBefore);
    } finally {
      db.$client.close();
    }
  });
});

describe("M04 原稿持久预留", () => {
  it("工作头后移与重开后保护原稿和图片，明确终止后释放", async () => {
    const fixture = await createEvidenceFixture();
    const { dataDir, databasePath, teacherCookie, unitId, aId, aCookie } =
      fixture;
    let { db, app } = fixture;
    try {
      const attemptId = await freshNoteAttempt(
        app,
        teacherCookie,
        unitId,
        [aId],
        aCookie,
      );
      const revisions = await fetchSubmitRevisions(app, aCookie, attemptId);
      const questionId = qAt(
        revisions.map((row) => row.questionId),
        1,
      );
      const first = await putNoteReceipt(
        app,
        aCookie,
        attemptId,
        questionId,
        1,
      );
      const intent = {
        operationId: randomUUID(),
        attemptId,
        studentId: aId,
        originals: [
          { questionId, versionId: first.versionId, revision: first.revision },
        ],
      };
      const readBody = (versionId: string) =>
        app.request(`/api/student/note-versions/${versionId}/document`, {
          headers: { cookie: aCookie },
        });
      const firstBody = Buffer.from(
        await (await readBody(first.versionId)).arrayBuffer(),
      );
      expect(firstBody.byteLength).toBeGreaterThan(0);
      const png = makeNotePng();
      const attached = await app.request(
        `/api/student/note-versions/${first.versionId}/images`,
        {
          method: "POST",
          headers: { cookie: aCookie },
          body: noteImageForm(png),
        },
      );
      expect(attached.status).toBe(200);
      const {
        data: { imageId },
      } = (await attached.json()) as { data: { imageId: string } };
      const readImage = () =>
        app.request(
          `/api/student/note-versions/${first.versionId}/images/${imageId}.png`,
          {
            headers: { cookie: aCookie },
          },
        );

      const reserved = reserveSubmissionOriginals(db, dataDir, intent);
      expect(reserved).toEqual([{ ...intent.originals[0], hash: first.hash }]);
      const secondSession = await loginStudent(app, "张三", STUDENT_PASSWORD);
      const newer = await putNoteReceipt(
        app,
        secondSession,
        attemptId,
        questionId,
        2,
        { baseRevision: first.revision },
      );
      const newerBody = Buffer.from(
        await (await readBody(newer.versionId)).arrayBuffer(),
      );
      const now = new Date(
        Date.parse(newer.savedAt) + NOTE_GC_SAFETY_WINDOW_MS + 1,
      );

      db.$client.close();
      db = createDb(databasePath);
      app = mountApp(db, dataDir);
      const collected = gcNoteVersions(db, dataDir, { now });
      expect(collected).toMatchObject({
        candidateVersionRows: 0,
        deletedVersionRows: 0,
        deletedFiles: 0,
        keptByReference: 2,
      });
      expect(reserveSubmissionOriginals(db, dataDir, intent)).toEqual(reserved);
      expect(() =>
        reserveSubmissionOriginals(db, dataDir, {
          ...intent,
          operationId: randomUUID(),
        }),
      ).toThrow(expect.objectContaining({ code: "NOTE_EVIDENCE_MISMATCH" }));
      expect(() =>
        reserveSubmissionOriginals(db, dataDir, {
          ...intent,
          originals: [
            {
              questionId,
              versionId: newer.versionId,
              revision: newer.revision,
            },
          ],
        }),
      ).toThrow(expect.objectContaining({ code: "NOTE_EVIDENCE_MISMATCH" }));
      const original = await readBody(first.versionId);
      expect(original.status).toBe(200);
      expect(Buffer.from(await original.arrayBuffer())).toEqual(firstBody);
      const originalImage = await readImage();
      expect(originalImage.status).toBe(200);
      expect(Buffer.from(await originalImage.arrayBuffer())).toEqual(
        Buffer.from(png),
      );
      expect(noteRowOf(db, attemptId, questionId)?.currentVersionId).toBe(
        newer.versionId,
      );
      expect(() =>
        db
          .delete(noteVersions)
          .where(eq(noteVersions.id, first.versionId))
          .run(),
      ).toThrow(
        expect.objectContaining({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" }),
      );

      const key = { attemptId, operationId: intent.operationId };
      expect(() =>
        settleSubmissionOriginalReservation(db, key, "projected"),
      ).toThrow(expect.objectContaining({ code: "NOTE_EVIDENCE_MISMATCH" }));
      expect(gcNoteVersions(db, dataDir, { now }).deletedVersionRows).toBe(0);
      expect(
        db
          .select()
          .from(evidenceTable)
          .where(eq(evidenceTable.attemptId, attemptId))
          .all(),
      ).toEqual([]);
      expect(
        db
          .select()
          .from(attemptSettlements)
          .where(eq(attemptSettlements.attemptId, attemptId))
          .all(),
      ).toEqual([]);

      const legacy = await submitAttemptRequest(
        app,
        aCookie,
        attemptId,
        declarationsWithFrozen(
          revisions.map((row) => row.questionId),
          questionId,
          newer,
        ),
      );
      expect(legacy.status).toBe(200);
      expect(() =>
        settleSubmissionOriginalReservation(db, key, "projected"),
      ).toThrow(expect.objectContaining({ code: "NOTE_EVIDENCE_MISMATCH" }));
      expect(gcNoteVersions(db, dataDir, { now }).deletedVersionRows).toBe(0);
      settleSubmissionOriginalReservation(db, key, "aborted");
      settleSubmissionOriginalReservation(db, key, "aborted");
      expect(() => reserveSubmissionOriginals(db, dataDir, intent)).toThrow(
        expect.objectContaining({ code: "NOTE_EVIDENCE_MISMATCH" }),
      );
      expect(gcNoteVersions(db, dataDir, { now })).toMatchObject({
        deletedVersionRows: 1,
        deletedImageRows: 1,
        deletedFiles: 1,
        keptByReference: 1,
        fileFailures: 0,
      });
      expect((await readBody(first.versionId)).status).toBe(404);
      expect((await readImage()).status).toBe(404);
      const current = await readBody(newer.versionId);
      expect(current.status).toBe(200);
      expect(Buffer.from(await current.arrayBuffer())).toEqual(newerBody);
    } finally {
      db.$client.close();
    }
  });

  it("不同学生的卷可复用操作号，终止后清除本卷不动待确认卷", async () => {
    const { app, db, dataDir, teacherCookie, unitId, aId, aCookie } =
      await createEvidenceFixture();
    try {
      const bId = await createStudent(
        app,
        teacherCookie,
        "李四",
        STUDENT_PASSWORD,
      );
      const bCookie = await loginStudent(app, "李四", STUDENT_PASSWORD);
      const operationId = randomUUID();
      const prepare = async (studentId: string, cookie: string) => {
        const attemptId = await freshNoteAttempt(
          app,
          teacherCookie,
          unitId,
          [studentId],
          cookie,
        );
        const revisions = await fetchSubmitRevisions(app, cookie, attemptId);
        const questionId = qAt(
          revisions.map((row) => row.questionId),
          1,
        );
        const emptyDraft = await putNoteReceipt(
          app,
          cookie,
          attemptId,
          questionId,
          0,
        );
        const intent = {
          studentId,
          attemptId,
          operationId,
          originals: [
            {
              questionId,
              versionId: emptyDraft.versionId,
              revision: emptyDraft.revision,
            },
          ],
        };
        const reserved = reserveSubmissionOriginals(db, dataDir, intent);
        return { intent, reserved };
      };

      const first = await prepare(aId, aCookie);
      const second = await prepare(bId, bCookie);
      expect(first.reserved[0]?.questionId).toBe(
        second.reserved[0]?.questionId,
      );
      expect(first.reserved[0]?.versionId).not.toBe(
        second.reserved[0]?.versionId,
      );
      const findAttempt = (id: string) =>
        db.select().from(attemptsTable).where(eq(attemptsTable.id, id)).get();
      expect(findAttempt(first.intent.attemptId)).toMatchObject({
        activatedAt: null,
      });
      expect(findAttempt(second.intent.attemptId)).toMatchObject({
        activatedAt: null,
      });

      const now = new Date(Date.now() + 8 * 24 * 60 * 60 * 1_000);
      expect(purgeOpenedAttempts(db, { enabled: true, now })).toBe(0);
      settleSubmissionOriginalReservation(db, first.intent, "aborted");
      expect(purgeOpenedAttempts(db, { enabled: true, now })).toBe(1);
      expect(findAttempt(first.intent.attemptId)).toBeUndefined();
      expect(findAttempt(second.intent.attemptId)).toMatchObject({
        activatedAt: null,
      });
      expect(reserveSubmissionOriginals(db, dataDir, second.intent)).toEqual(
        second.reserved,
      );
    } finally {
      db.$client.close();
    }
  });

  it("按操作原子预留，正式冻结相同版本后才能移交保护", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    const firstId = qAt(ids, 0);
    const secondId = qAt(ids, 1);
    const original = await putNoteReceipt(app, aCookie, attemptId, firstId);
    const second = await putNoteReceipt(app, aCookie, attemptId, secondId);
    const latest = await putNoteReceipt(app, aCookie, attemptId, secondId, 2, {
      baseRevision: second.revision,
    });
    const intent = {
      operationId: randomUUID(),
      attemptId,
      studentId: aId,
      originals: [
        {
          questionId: firstId,
          versionId: original.versionId,
          revision: original.revision,
        },
        {
          questionId: secondId,
          versionId: second.versionId,
          revision: second.revision,
        },
      ],
    };
    expect(() =>
      reserveSubmissionOriginals(db, dataDir, {
        ...intent,
        studentId: randomUUID(),
      }),
    ).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => reserveSubmissionOriginals(db, dataDir, intent)).toThrow(
      expect.objectContaining({ code: "NOTE_EVIDENCE_MISMATCH" }),
    );
    const corrected = {
      ...intent,
      originals: [
        {
          questionId: firstId,
          versionId: original.versionId,
          revision: original.revision,
        },
        {
          questionId: secondId,
          versionId: latest.versionId,
          revision: latest.revision,
        },
      ],
    };
    expect(
      reserveSubmissionOriginals(db, dataDir, { ...intent, originals: [] }),
    ).toEqual([]);
    const reserved = reserveSubmissionOriginals(db, dataDir, corrected);
    expect(reserved).toHaveLength(2);
    expect(() =>
      reserveSubmissionOriginals(db, dataDir, { ...intent, originals: [] }),
    ).toThrow(expect.objectContaining({ code: "NOTE_EVIDENCE_MISMATCH" }));
    expect(
      reserveSubmissionOriginals(db, dataDir, {
        ...corrected,
        originals: corrected.originals.toReversed(),
      }),
    ).toEqual(reserved);
    const key = { attemptId, operationId: intent.operationId };
    const evidence: SubmitEvidenceDeclaration[] = ids.map((questionId) => {
      const selection = corrected.originals.find(
        (item) => item.questionId === questionId,
      );
      return selection
        ? { ...selection, state: "frozen" }
        : { questionId, state: "none" };
    });
    expect((await submitWith(attemptId, evidence)).status).toBe(200);
    settleSubmissionOriginalReservation(db, key, "projected");
    settleSubmissionOriginalReservation(db, key, "projected");
    expect(() =>
      settleSubmissionOriginalReservation(db, key, "aborted"),
    ).toThrow(expect.objectContaining({ code: "NOTE_EVIDENCE_MISMATCH" }));
    expect(reserveSubmissionOriginals(db, dataDir, corrected)).toEqual(
      reserved,
    );
    expect(
      evidenceRowsOf(attemptId).filter(({ state }) => state === "frozen"),
    ).toEqual(
      expect.arrayContaining(
        corrected.originals.map(({ questionId, versionId }) =>
          expect.objectContaining({ questionId, versionId }),
        ),
      ),
    );
  });
});

// ---------- 拒绝分支 ----------

describe("T6R.10 证据声明拒绝分支（409 NOTE_EVIDENCE_MISMATCH）", () => {
  it("frozen 声明非 head 的 versionId（他人版本/不存在）→ 409 且零落行", async () => {
    const attemptId = await freshAttempt();
    const ids = await questionIdsOf(attemptId);
    // 另一 attempt 的合法版本（未授权引用）
    const otherAttempt = await freshAttempt();
    const otherReceipt = await putNoteReceipt(
      app,
      aCookie,
      otherAttempt,
      qAt(ids, 0),
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
    const receipt1 = await putNoteReceipt(app, aCookie, attemptId, notedId);
    // 「其他标签页」再存两版：head 前进到 3（声明仍按旧回执 v1 组装）
    await putNote(attemptId, notedId, 2, 1);
    await putNote(attemptId, notedId, 2, 2);

    const res = await submitWith(
      attemptId,
      declarationsWithFrozen(ids, notedId, receipt1),
    );
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
    const receipt1 = await putNoteReceipt(app, aCookie, attemptId, notedId);
    const res = await submitWith(
      attemptId,
      declarationsWithFrozen(ids, notedId, receipt1),
    );
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
    const receipt1 = await putNoteReceipt(app, aCookie, attemptId, notedId, 1, {
      mutationId,
    });
    const res = await submitWith(
      attemptId,
      declarationsWithFrozen(ids, notedId, receipt1),
    );
    expect(res.status).toBe(200);

    // 迟到重放（同 mutationId 同正文）：返回原回执，head/证据行不动
    const replayReceipt = await putNoteReceipt(
      app,
      aCookie,
      attemptId,
      notedId,
      1,
      { mutationId },
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
    const receipt1 = await putNoteReceipt(
      app,
      aCookie,
      firstAttempt,
      notedId,
      2,
    );
    const res1 = await submitWith(
      firstAttempt,
      declarationsWithFrozen(ids, notedId, receipt1),
    );
    expect(res1.status).toBe(200);
    const firstRow = evidenceRowsOf(firstAttempt).find(
      (r) => r.questionId === notedId,
    );

    // 新卷同题写新草稿并交卷
    const secondAttempt = await freshAttempt();
    const receipt2 = await putNoteReceipt(
      app,
      aCookie,
      secondAttempt,
      notedId,
      5,
    );
    const res2 = await submitWith(
      secondAttempt,
      declarationsWithFrozen(ids, notedId, receipt2),
    );
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
