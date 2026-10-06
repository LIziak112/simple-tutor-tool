import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { QuestionAnswers } from "@tutor/contract";
import { reviewPackSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import {
  assignments,
  attempts as attemptsTable,
  noteImages,
  responses as responsesTable,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { readZipEntries } from "../lib/zip-read.ts";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
  submitAttemptStatus,
} from "../test/evidence-fixtures.ts";
import {
  gzipJson,
  makeNotePng,
  makeStudent,
  noteDoc,
} from "../test/note-fixtures.ts";
import { insertEvidence } from "../test/note-world.ts";
import { saveMedia } from "./media-service.ts";
import { attachNoteImage, saveNoteVersion } from "./note-service.ts";
import {
  assembleReviewPack,
  buildReviewPackZip,
  previewReviewPack,
  zipReviewPack,
  type ReviewPackPrincipal,
} from "./review-pack-service.ts";

/**
 * T6R.13 单题完整导出服务测试（任务清单失败测试逐项）：
 * - 双角色一键一题包：teacher 携答案/判定/评语/真实 id；**学生包 id 剥离 +
 *   答案/判定/解析/提示全量哨兵扫描**（pack.json 键级 + 全 zip 文本内容级 +
 *   条目名级，AGENTS 第 3 条 + 安全审查留档硬要求）；
 * - 答案公布 gate（after_due 截止前）服务端执行：学生 released=false 且包
 *   形态不变（结构性无判定）；教师包不受 gate；
 * - 丢图片：分析图文件删除/未生成 → manifest.missing 显式原因 + complete=
 *   false + review.md「不完整」；媒体缺失同口径；
 * - 生成期间状态变化：装配后文件消失 → 打包显式 500 不产出静默缺件 zip；
 *   重新请求按当前状态重装配（缺失如实标记）；
 * - 权限：题不在卷内 404、他人 attempt 学生 403 / 乙教师 404；
 * - 预览与下载同源（files 路径集合 = zip 条目集合；reviewMd 逐字节一致）；
 *   schema.json 与 schema:export 产物逐字节一致；附件 downloadUrl 按角色给出。
 */

const TEACHER: ReviewPackPrincipal = { kind: "teacher", id: TEST_TEACHER_ID };

const NOW = "2026-10-07T08:00:00.000Z";

/** 泄露哨兵常量（题库侧秘密内容，学生包任何文件不得出现） */
const SECRET_ANSWER_TEXT = "42";
const SECRET_SOLUTION = "解析哨兵：先算括号内再取相反数";
const SECRET_HINT = "提示哨兵：从数轴方向入手";
const SECRET_COMMENT = "评语哨兵：过程跳步需当面确认";

const QUESTION_ID = "复习题-1";

/** 学生主体快捷封装 */
function studentOf(id: string): ReviewPackPrincipal {
  return { kind: "student", id };
}

/** 世界夹具：一题 fill（带答案/解析/提示）+ 一页 ready 分析图 + frozen 证据 */
async function makeWorld(
  db: Db,
  dataDir: string,
  options: {
    studentId: string;
    stemMd?: string;
    withNote?: boolean;
    pendingAnalysisRow?: boolean;
  },
): Promise<{
  attemptId: string;
  versionId: string | null;
  /** ready 分析图行（含盘上路径），删除文件做缺失用例用 */
  analysisPath: string | null;
}> {
  const stemMd =
    options.stemMd ??
    `计算 $(-3)+7-(-2)$ 的结果，填在括号里：[[${SECRET_ANSWER_TEXT}]]`;
  const { attemptId } = frozenDraftAttempt(db, options.studentId, [
    {
      questionId: QUESTION_ID,
      snapshotJson: snapshotJsonOf({
        id: QUESTION_ID,
        stemMd,
        answers: {
          kind: "fill",
          blanks: [[SECRET_ANSWER_TEXT]],
        } satisfies QuestionAnswers,
        solutionMd: SECRET_SOLUTION,
        hints: [SECRET_HINT],
      }),
    },
  ]);
  let versionId: string | null = null;
  let analysisPath: string | null = null;
  if (options.withNote !== false) {
    const receipt = saveNoteVersion(
      db,
      dataDir,
      options.studentId,
      attemptId,
      QUESTION_ID,
      gzipJson(noteDoc(3, 40)),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    versionId = receipt.versionId;
    attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: options.studentId },
      receipt.versionId,
      makeNotePng(1000, 800),
      {
        spec: "analysis",
        pageIndex: 0,
        crop: { x: 0, y: 0, width: 1000, height: 800 },
        pixelWidth: 1000,
        pixelHeight: 800,
      },
    );
    const row = db
      .select()
      .from(noteImages)
      .where(eq(noteImages.noteVersionId, receipt.versionId))
      .get();
    // noteImages.path 相对 DATA_DIR（已含 blobs/notes 前缀；root 只做包含校验）
    analysisPath = row === undefined ? null : join(dataDir, row.path);
    if (options.pendingAnalysisRow) {
      // 直插 pending 态分析图行（未生成）：显式缺失原因
      db.insert(noteImages)
        .values({
          id: randomUUID(),
          noteVersionId: receipt.versionId,
          spec: "analysis",
          pageIndex: 1,
          cropX: 0,
          cropY: 760,
          cropW: 1000,
          cropH: 640,
          pixelWidth: 1000,
          pixelHeight: 640,
          path: "pending/未生成.png",
          state: "pending",
        })
        .run();
    }
  }
  submitAttemptStatus(db, attemptId);
  if (options.withNote !== false) {
    insertEvidence(db, attemptId, QUESTION_ID, "frozen", versionId);
  }
  return { attemptId, versionId, analysisPath };
}

/** 教师批注夹具（评语 + 判定哨兵进 responses 行） */
function markByTeacher(db: Db, attemptId: string): void {
  db.update(responsesTable)
    .set({ teacherComment: SECRET_COMMENT, finalCorrect: false })
    .where(eq(responsesTable.attemptId, attemptId))
    .run();
}

function entriesOf(bytes: Uint8Array): Map<string, Buffer> {
  return new Map(
    readZipEntries(Buffer.from(bytes)).map((entry) => [entry.name, entry.data]),
  );
}

describe("T6R.13 双角色一键一题包（服务层）", () => {
  it("教师包全链：zip 结构完整、pack.json 过 schema、携带答案/判定/评语/真实 id", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const world = await makeWorld(db, dataDir, { studentId: s1 });
    markByTeacher(db, world.attemptId);

    const zip = await buildReviewPackZip(db, dataDir, TEACHER, world.attemptId, QUESTION_ID, {
      now: NOW,
    });
    expect(zip.filename).toMatch(/^review-pack-q1-\d{8}-\d{6}\.zip$/);
    const entries = entriesOf(zip.bytes);
    for (const fixed of [
      "review.md",
      "pack.json",
      "schema.json",
      "questions/q001/stem.md",
      "evidence/e001-original-01.png",
    ]) {
      expect(entries.has(fixed), `zip 缺 ${fixed}`).toBe(true);
    }
    const pack = reviewPackSchema.parse(
      JSON.parse(entries.get("pack.json")?.toString("utf8") ?? "{}"),
    );
    expect(pack.role).toBe("teacher");
    expect(pack.question.answers).toEqual({
      kind: "fill",
      blanks: [[SECRET_ANSWER_TEXT]],
    });
    expect(pack.question.solutionMd).toBe(SECRET_SOLUTION);
    expect(pack.response.teacherComment).toBe(SECRET_COMMENT);
    expect(pack.response.attemptId).toBe(world.attemptId);
    expect(pack.response.studentId).toBe(s1);
    expect(pack.question.questionId).toBe(QUESTION_ID);
    expect(pack.evidence.version?.versionId).toBe(world.versionId);
    // manifest：files 全在 zip
    for (const file of pack.manifest.files) {
      expect(entries.has(file.path), `manifest 条目不在 zip：${file.path}`).toBe(
        true,
      );
    }
    // 教师题面含参考答案节
    const stem = entries.get("questions/q001/stem.md")?.toString("utf8") ?? "";
    expect(stem).toContain("参考答案");
    expect(stem).toContain(SECRET_ANSWER_TEXT);
  });

  it("学生包：id 剥离 + 答案/判定/解析/提示/评语全量哨兵扫描（键级 + 内容级 + 文件名级）", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const world = await makeWorld(db, dataDir, { studentId: s1 });
    markByTeacher(db, world.attemptId);

    const zip = await buildReviewPackZip(
      db,
      dataDir,
      studentOf(s1),
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    const entries = entriesOf(zip.bytes);
    const pack = JSON.parse(entries.get("pack.json")?.toString("utf8") ?? "{}");

    // —— 键级：pack.json 无教师域键（schema superRefine 已拒，这里锁深扫） ——
    expect(pack.role).toBe("student");
    const packText = JSON.stringify(pack);
    for (const forbiddenKey of [
      '"questionId"',
      '"attemptId"',
      '"studentId"',
      '"versionId"',
      '"answers"',
      '"solutionMd"',
      '"autoCorrect"',
      '"finalCorrect"',
      '"teacherMark"',
      '"teacherComment"',
    ]) {
      expect(packText, `学生 pack.json 出现 ${forbiddenKey}`).not.toContain(
        forbiddenKey,
      );
    }

    // —— 内容级：全部文本文件不含答案/解析/提示/评语哨兵与真实 id ——
    const textEntries = [...entries.entries()].filter(([name]) =>
      /\.(md|json)$/.test(name),
    );
    expect(textEntries.length).toBeGreaterThanOrEqual(3);
    for (const [name, data] of textEntries) {
      const text = data.toString("utf8");
      expect(text, `${name} 泄露答案哨兵`).not.toContain(SECRET_ANSWER_TEXT);
      expect(text, `${name} 泄露解析哨兵`).not.toContain(SECRET_SOLUTION);
      expect(text, `${name} 泄露提示哨兵`).not.toContain(SECRET_HINT);
      expect(text, `${name} 泄露评语哨兵`).not.toContain(SECRET_COMMENT);
      expect(text, `${name} 泄露 attemptId`).not.toContain(world.attemptId);
      expect(text, `${name} 泄露 versionId`).not.toContain(world.versionId ?? "");
      expect(text, `${name} 泄露 questionId`).not.toContain(QUESTION_ID);
    }
    // 填空脱敏：题面是 [[]] 空框不是 [[42]]
    const stem = entries.get("questions/q001/stem.md")?.toString("utf8") ?? "";
    expect(stem).toContain("[[]]");
    // 夹具未作答：answerText=null（学生自己的答案位）
    expect(pack.response.answerText).toBeNull();

    // —— 文件名级：zip 条目名不含真实 id ——
    for (const name of entries.keys()) {
      expect(name).not.toContain(world.attemptId);
      expect(name).not.toContain(world.versionId ?? "");
      expect(name).not.toContain(QUESTION_ID);
    }
    // 学生包 review.md 声明不含参考答案与判定
    const review = entries.get("review.md")?.toString("utf8") ?? "";
    expect(review).toContain("不含参考答案");
  });

  it("学生包已作答：answerText 进包；媒体配图随包附上", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const media = saveMedia(
      dataDir,
      makeNotePng(40, 40).slice() as Uint8Array<ArrayBuffer>,
    );
    const world = await makeWorld(db, dataDir, {
      studentId: s1,
      stemMd: `看图回答：\n\n::image{src="${media.src}"}\n\n图中等式成立吗：[[是]]`,
    });
    db.update(responsesTable)
      .set({ answerJson: '{"kind":"fill","values":["是"]}' })
      .where(eq(responsesTable.attemptId, world.attemptId))
      .run();
    const zip = await buildReviewPackZip(
      db,
      dataDir,
      studentOf(s1),
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    const entries = entriesOf(zip.bytes);
    expect(entries.has(media.src)).toBe(true);
    const pack = reviewPackSchema.parse(
      JSON.parse(entries.get("pack.json")?.toString("utf8") ?? "{}"),
    );
    expect(pack.response.answerText).toBe("是");
    const stem = entries.get("questions/q001/stem.md")?.toString("utf8") ?? "";
    expect(stem).toContain("**学生答案**：是");
  });

  it("媒体缺失：manifest.missing 显式原因、zip 无该条目、complete=false", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const media = saveMedia(
      dataDir,
      makeNotePng(40, 40).slice() as Uint8Array<ArrayBuffer>,
    );
    const world = await makeWorld(db, dataDir, {
      studentId: s1,
      stemMd: `看图回答：::image{src="${media.src}"} [[图]]`,
    });
    rmSync(join(dataDir, ...media.src.split("/")));
    const preview = previewReviewPack(
      db,
      dataDir,
      studentOf(s1),
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    expect(preview.complete).toBe(false);
    expect(
      preview.missing.some((m) => m.path === media.src && m.reason.length > 0),
    ).toBe(true);
    const zip = await buildReviewPackZip(
      db,
      dataDir,
      studentOf(s1),
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    expect(entriesOf(zip.bytes).has(media.src)).toBe(false);
  });

  it("丢分析图：文件删除/未生成 → 显式缺失 + review.md「不完整」，不静默消失", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const world = await makeWorld(db, dataDir, {
      studentId: s1,
      pendingAnalysisRow: true,
    });
    // 删掉已 attach 的第 0 页文件（行仍 ready，盘上没了）
    rmSync(world.analysisPath ?? "");
    const preview = previewReviewPack(
      db,
      dataDir,
      studentOf(s1),
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    expect(preview.complete).toBe(false);
    expect(preview.missing).toHaveLength(2); // 删除的第 0 页 + pending 的第 1 页
    expect(preview.missing.map((m) => m.path)).toContain(
      "evidence/e001-original-01.png",
    );
    expect(preview.reviewMd).toContain("不完整");
    expect(preview.reviewMd).toContain("不要假装看到了图片");
  });

  it("生成期间状态变化：装配后文件消失 → 打包显式 500；重新请求按现状重装配", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const world = await makeWorld(db, dataDir, { studentId: s1 });
    const assembly = assembleReviewPack(
      db,
      dataDir,
      studentOf(s1),
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    // 装配（stat 通过）之后、写 zip 之前文件被删：不得产出静默缺件 zip
    rmSync(world.analysisPath ?? "");
    await expect(zipReviewPack(assembly)).rejects.toMatchObject({
      status: 500,
      code: "EXPORT_ASSEMBLY_BROKEN",
    });
    // 重新完整请求：按当前状态重装配 → 缺失显式、zip 可用、complete=false
    const zip = await buildReviewPackZip(
      db,
      dataDir,
      studentOf(s1),
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    const entries = entriesOf(zip.bytes);
    expect(entries.has("evidence/e001-original-01.png")).toBe(false);
    const pack = reviewPackSchema.parse(
      JSON.parse(entries.get("pack.json")?.toString("utf8") ?? "{}"),
    );
    expect(pack.manifest.missing).toHaveLength(1);
  });

  it("after_due 截止前：学生 released=false（包形态不变——结构性无判定）；教师不受 gate", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const assignmentId = randomUUID();
    db.insert(assignments)
      .values({
        id: assignmentId,
        teacherId: TEST_TEACHER_ID,
        courseId: null,
        title: "截止后公布作业",
        answerRelease: "after_due",
        dueAt: "2026-12-31T00:00:00.000Z",
        createdAt: "2026-10-01T00:00:00.000Z",
      })
      .run();
    const world = await makeWorld(db, dataDir, { studentId: s1 });
    db.update(attemptsTable)
      .set({ assignmentId })
      .where(eq(attemptsTable.id, world.attemptId))
      .run();

    const studentPreview = previewReviewPack(
      db,
      dataDir,
      studentOf(s1),
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    expect(studentPreview.released).toBe(false);
    expect(studentPreview.answersIncluded).toBe(false);
    expect(studentPreview.reviewMd).toContain("尚未公布");

    const teacherPreview = previewReviewPack(
      db,
      dataDir,
      TEACHER,
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    expect(teacherPreview.released).toBe(true);
    expect(teacherPreview.answersIncluded).toBe(true);
  });

  it("无草稿题：evidenceState=not_collected、无 evidence 条目、complete=true（纯文字包）", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const world = await makeWorld(db, dataDir, { studentId: s1, withNote: false });
    const preview = previewReviewPack(
      db,
      dataDir,
      studentOf(s1),
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    expect(preview.evidenceState).toBe("not_collected");
    expect(preview.complete).toBe(true);
    const zip = await buildReviewPackZip(
      db,
      dataDir,
      studentOf(s1),
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    expect(entriesOf(zip.bytes).has("evidence/e001-original-01.png")).toBe(
      false,
    );
  });

  it("draft（未交卷）attempt 也可导出：快照行已冻结，证据 not_collected", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const { attemptId } = frozenDraftAttempt(db, s1, [
      { questionId: QUESTION_ID, snapshotJson: snapshotJsonOf({ id: QUESTION_ID }) },
    ]);
    const preview = previewReviewPack(
      db,
      dataDir,
      studentOf(s1),
      attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    expect(preview.evidenceState).toBe("not_collected");
    expect(preview.questionPresent).toBe(true);
  });

  it("权限：题不在这份作答 404 QUESTION_NOT_FOUND；他人 attempt 学生 403；乙教师 404", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const s2 = makeStudent(db);
    const world = await makeWorld(db, dataDir, { studentId: s1 });
    try {
      previewReviewPack(db, dataDir, studentOf(s1), world.attemptId, "不存在的题", {
        now: NOW,
      });
      expect.unreachable("应抛 404");
    } catch (err) {
      expect(err).toMatchObject({ status: 404, code: "QUESTION_NOT_FOUND" });
    }
    try {
      previewReviewPack(db, dataDir, studentOf(s2), world.attemptId, QUESTION_ID, {
        now: NOW,
      });
      expect.unreachable("应抛 403");
    } catch (err) {
      expect(err).toMatchObject({ status: 403, code: "FORBIDDEN" });
    }
    try {
      previewReviewPack(
        db,
        dataDir,
        { kind: "teacher", id: "teacher-b-t6r13-000001" },
        world.attemptId,
        QUESTION_ID,
        { now: NOW },
      );
      expect.unreachable("应抛 404");
    } catch (err) {
      expect(err).toMatchObject({ status: 404, code: "ATTEMPT_NOT_FOUND" });
    }
  });

  it("预览与下载同源：files 路径集合 = zip 条目集合；reviewMd 逐字节一致；downloadUrl 按角色", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const world = await makeWorld(db, dataDir, { studentId: s1 });
    const preview = previewReviewPack(
      db,
      dataDir,
      studentOf(s1),
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    const zip = await buildReviewPackZip(
      db,
      dataDir,
      studentOf(s1),
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    const entries = entriesOf(zip.bytes);
    expect(new Set(preview.files.map((f) => f.path))).toEqual(
      new Set(entries.keys()),
    );
    expect(preview.reviewMd).toBe(
      entries.get("review.md")?.toString("utf8") ?? "",
    );
    // attachments：ready 附角色化 downloadUrl（evidence 图走 note-versions 直出）
    const evidence = preview.attachments.find(
      (a) => a.kind === "evidence" && a.state === "ready",
    );
    expect(evidence?.downloadUrl).toContain(
      `/api/student/note-versions/${world.versionId}/images/`,
    );
    const teacherPreview = previewReviewPack(
      db,
      dataDir,
      TEACHER,
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    const teacherEvidence = teacherPreview.attachments.find(
      (a) => a.kind === "evidence" && a.state === "ready",
    );
    expect(teacherEvidence?.downloadUrl).toContain("/api/teacher/note-versions/");
  });

  it("schema.json 与 pnpm schema:export 产物逐字节一致", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const world = await makeWorld(db, dataDir, { studentId: s1 });
    const zip = await buildReviewPackZip(
      db,
      dataDir,
      studentOf(s1),
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    const artifact = readFileSync(
      join(
        fileURLToPath(new URL(".", import.meta.url)),
        "../../../../docs/dsl/schema/review-pack.json",
      ),
      "utf8",
    );
    expect(entriesOf(zip.bytes).get("schema.json")?.toString("utf8")).toBe(
      artifact,
    );
  });

  it("注入小上限：413 EXPORT_TOO_LARGE（防御口径）", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const world = await makeWorld(db, dataDir, { studentId: s1 });
    await expect(
      buildReviewPackZip(db, dataDir, studentOf(s1), world.attemptId, QUESTION_ID, {
        now: NOW,
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ status: 413, code: "EXPORT_TOO_LARGE" });
  });

  it("图表题：stem.md 参数化说明 + review.md 数据说明行（未附静态图）", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const world = await makeWorld(db, dataDir, {
      studentId: s1,
      stemMd:
        "观察函数图像后填空：\n\n::graph{fn=\"x^2\" range=\"-2,2\"}\n\n开口方向：[[向上]]",
    });
    const zip = await buildReviewPackZip(
      db,
      dataDir,
      studentOf(s1),
      world.attemptId,
      QUESTION_ID,
      { now: NOW },
    );
    const entries = entriesOf(zip.bytes);
    const stem = entries.get("questions/q001/stem.md")?.toString("utf8") ?? "";
    expect(stem).toContain("【图表·静态导出】");
    expect(stem).toContain("x^2");
    expect(entries.get("review.md")?.toString("utf8")).toContain(
      "参数化文本说明",
    );
  });

  it("教师 stem.md：判定/评语分节呈现（评语哨兵进教师包是合法的）", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const world = await makeWorld(db, dataDir, { studentId: s1 });
    db.update(responsesTable)
      .set({ teacherComment: SECRET_COMMENT, finalCorrect: true, autoCorrect: true })
      .where(eq(responsesTable.attemptId, world.attemptId))
      .run();
    const zip = await buildReviewPackZip(db, dataDir, TEACHER, world.attemptId, QUESTION_ID, {
      now: NOW,
    });
    const stem = entriesOf(zip.bytes)
      .get("questions/q001/stem.md")
      ?.toString("utf8");
    expect(stem).toContain("判定");
    expect(stem).toContain(SECRET_COMMENT);
  });
});
