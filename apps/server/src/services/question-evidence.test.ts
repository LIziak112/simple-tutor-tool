import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { QuestionAnswers } from "@tutor/contract";
import { stemMdLeaksAnswers } from "@tutor/md-dsl";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import {
  type Attempt,
  attempts as attemptsTable,
  noteImages,
  type ResponseRow,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { HttpError } from "../lib/http-error.ts";
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
import { attemptResponseRows } from "./attempt-service.ts";
import { saveMedia } from "./media-service.ts";
import { attachNoteImage, saveNoteVersion } from "./note-service.ts";
import {
  assembleQuestionEvidence,
  type EvidenceRole,
  evidenceImageFileName,
  questionRevisionKey,
} from "./question-evidence.ts";

/**
 * T6R.12 题目证据共享装配服务测试（任务清单失败测试逐项）：
 * - 同 qid 两轮不同数值／选项／解析一一配对（按内容身份分配 q 条目，
 *   不是「同 qid 取最新」）；同内容跨轮去重共享条目；
 * - 同内容去重不串教师（去重键含教师域）；
 * - 角色投影先于素材装配：学生角色任何层级都只出学生端投影题干，
 *   答案/解析/提示绝不进入装配结果的任何字符串（哨兵扫描整个装配对象），
 *   学生角色的媒体扫描也只扫投影后的题干（解析里的图不进学生包）；
 * - 证据装配：frozen 版本摘要 + 分析图清单（ready 附文件；
 *   未生成/失败/文件删除 → 显式缺失原因）；missing/none/legacy_unverified/
 *   not_collected 如实呈现；
 * - 化名文件名不含真实 id（学生/attempt/version/question id 都不进路径）；
 * - 媒体引用保留：历史快照里的 ::image 引用按存在性登记（缺失不静默消失）。
 *
 * 夹具直插 DB（同 note-service.test.ts 口径）：saveNoteVersion 拒写已交卷
 * attempt，因此先以 draft 存稿、补图后再置 submitted 并插证据行。
 */

const TEACHER_B_ID = "teacher-b-t6r12-000001";

/** scope 条目：attempt + 展示序行（attemptResponseRows 按 rowid 序＝夹具插入序） */
function scopeOf(
  db: Db,
  attemptId: string,
): {
  attempt: Attempt;
  rows: ResponseRow[];
} {
  const attempt = db
    .select()
    .from(attemptsTable)
    .where(eq(attemptsTable.id, attemptId))
    .get();
  if (attempt === undefined) throw new Error("夹具 attempt 不存在");
  return { attempt, rows: attemptResponseRows(db, attemptId) };
}

/** 快捷装配薄壳（默认教师 answer 层、不含证据） */
function assemble(
  db: Db,
  dataDir: string,
  teacherId: string,
  scopes: ReadonlyArray<{ attempt: Attempt; rows: ResponseRow[] }>,
  options: {
    role?: EvidenceRole;
    questionLevel?: "stem" | "answer" | "solution";
    includeEvidence?: boolean;
  } = {},
) {
  return assembleQuestionEvidence(db, dataDir, teacherId, scopes, {
    role: options.role ?? "teacher",
    ...(options.questionLevel !== undefined
      ? { questionLevel: options.questionLevel }
      : {}),
    includeEvidence: options.includeEvidence ?? false,
  });
}

// ---------- 同 qid 两轮不同内容一一配对 ----------

describe("T6R.12 快照一一配对（同 qid 多版本）", () => {
  it("两轮不同数值/选项/解析 → 两个 q 条目，各 response 行指向自己的版本", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const round1 = frozenDraftAttempt(db, s1, [
      {
        questionId: "加法练习-1",
        snapshotJson: snapshotJsonOf({
          id: "加法练习-1",
          stemMd: "计算 $2+3=[[5]]$",
          answers: { kind: "fill", blanks: [["5"]] } satisfies QuestionAnswers,
          solutionMd: "解析一：2+3=5",
        }),
      },
    ]);
    submitAttemptStatus(db, round1.attemptId, "2026-10-01T06:00:00.000Z");
    const round2 = frozenDraftAttempt(db, s1, [
      {
        questionId: "加法练习-1",
        snapshotJson: snapshotJsonOf({
          id: "加法练习-1",
          type: "choice",
          stemMd: "12+13 = ？",
          options: [{ text: "25" }, { text: "35" }, { text: "24" }],
          answers: { kind: "choice", index: 0 } satisfies QuestionAnswers,
          solutionMd: "解析二：12+13=25",
        }),
      },
    ]);
    submitAttemptStatus(db, round2.attemptId, "2026-10-03T06:00:00.000Z");

    const result = assemble(
      db,
      dataDir,
      TEST_TEACHER_ID,
      [scopeOf(db, round1.attemptId), scopeOf(db, round2.attemptId)],
      { questionLevel: "solution" },
    );

    // 同 qid 不同内容 → 两个条目（v1「同 qid 取最新」缺陷在此修复）
    expect(result.revisions).toHaveLength(2);
    const [q1, q2] = result.revisions;
    expect(q1?.material.stemMd).toContain("2+3");
    expect(q1?.material.solutionMd).toBe("解析一：2+3=5");
    expect(q2?.material.stemMd).toContain("12+13");
    expect(q2?.material.options).toEqual(["25", "35", "24"]);
    expect(q2?.material.solutionMd).toBe("解析二：12+13=25");
    // 两轮 response 行各指向自己的快照条目（一一配对的核心断言）
    const row1 = result.refByResponseRowId.get(round1.rowIds[0] ?? "");
    const row2 = result.refByResponseRowId.get(round2.rowIds[0] ?? "");
    expect(row1).toBe(q1?.ref);
    expect(row2).toBe(q2?.ref);
    // 内容身份不同
    expect(q1?.snapshotHash).not.toBe(q2?.snapshotHash);
  });

  it("同内容跨轮/跨 attempt 去重共享条目；缺失快照显式缺失不回填", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const sameJson = snapshotJsonOf({
      id: "稳定题-2",
      stemMd: "恒定题干 [[7]]",
    });
    const a1 = frozenDraftAttempt(db, s1, [
      { questionId: "稳定题-2", snapshotJson: sameJson },
    ]);
    submitAttemptStatus(db, a1.attemptId, "2026-10-01T06:00:00.000Z");
    const a2 = frozenDraftAttempt(db, s1, [
      { questionId: "稳定题-2", snapshotJson: sameJson },
      // 升级遗留行：无快照（questionSnapshotJson=null）
      { questionId: "旧题-3", snapshotJson: null },
    ]);
    submitAttemptStatus(db, a2.attemptId, "2026-10-04T06:00:00.000Z");

    const result = assemble(
      db,
      dataDir,
      TEST_TEACHER_ID,
      [scopeOf(db, a1.attemptId), scopeOf(db, a2.attemptId)],
      { questionLevel: "answer" },
    );

    // 同内容两轮 → 一个条目；缺失快照 → 独立条目 present=false 空题干
    expect(result.revisions).toHaveLength(2);
    const stable = result.revisions.find((r) => r.questionId === "稳定题-2");
    const missing = result.revisions.find((r) => r.questionId === "旧题-3");
    expect(stable?.present).toBe(true);
    expect(missing?.present).toBe(false);
    expect(missing?.material.stemMd).toBe("");
    expect(missing?.snapshotHash).toBeNull();
    // 两条 a2 行分别指向正确条目（同内容复用 + 缺失独立）
    expect(result.refByResponseRowId.get(a2.rowIds[0] ?? "")).toBe(stable?.ref);
    expect(result.refByResponseRowId.get(a2.rowIds[1] ?? "")).toBe(
      missing?.ref,
    );
  });
});

// ---------- 去重键含教师域（同内容不串教师） ----------

describe("T6R.12 同内容去重不串教师", () => {
  it("去重键含教师域：同 hash 不同教师 → 不同键", () => {
    const hash = "a".repeat(64);
    expect(questionRevisionKey(TEST_TEACHER_ID, hash)).not.toBe(
      questionRevisionKey(TEACHER_B_ID, hash),
    );
    // 缺失快照的键同样按教师 + 题目隔离
    expect(questionRevisionKey(TEST_TEACHER_ID, null, "q-1")).not.toBe(
      questionRevisionKey(TEACHER_B_ID, null, "q-1"),
    );
  });

  it("教师 A 的装配不含教师 B 域的任何数据（域过滤 + 独立条目实例）", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const sameJson = snapshotJsonOf({
      id: "共享考点题-9",
      stemMd: "同内容题干 [[3]]",
    });
    const sA = makeStudent(db);
    const sB = makeStudent(db, TEACHER_B_ID);
    const aA = frozenDraftAttempt(db, sA, [
      { questionId: "共享考点题-9", snapshotJson: sameJson },
    ]);
    submitAttemptStatus(db, aA.attemptId);
    const aB = frozenDraftAttempt(db, sB, [
      { questionId: "共享考点题-9", snapshotJson: sameJson },
    ]);
    submitAttemptStatus(db, aB.attemptId);

    const forA = assemble(db, dataDir, TEST_TEACHER_ID, [
      scopeOf(db, aA.attemptId),
    ]);
    const forB = assemble(db, dataDir, TEACHER_B_ID, [
      scopeOf(db, aB.attemptId),
    ]);

    // 两教师各自装配：同内容 hash 相同，但条目/引用是各自域的独立实例
    expect(forA.revisions).toHaveLength(1);
    expect(forB.revisions).toHaveLength(1);
    expect(forA.revisions[0]?.snapshotHash).toBe(
      forB.revisions[0]?.snapshotHash,
    );
    // A 的装配结果（含证据条目——attempt/student id 会出现在其中）不含
    // B 域的任何 id；A 自己的 id 在场
    const forAWithEvidence = assemble(
      db,
      dataDir,
      TEST_TEACHER_ID,
      [scopeOf(db, aA.attemptId)],
      { includeEvidence: true },
    );
    const dumpA = JSON.stringify(forAWithEvidence);
    expect(dumpA).not.toContain(sB);
    expect(dumpA).not.toContain(aB.attemptId);
    expect(dumpA).toContain(sA);
    expect(dumpA).toContain(aA.attemptId);
  });
});

// ---------- 服务端泄露哨兵（materialOf 运行时守卫，编排者复审 A1） ----------

describe("T6R.12 服务端泄露哨兵：学生角色投影后仍含答案标记 → 500 拒绝装配", () => {
  /**
   * 恶意/畸形快照：fill 题**不带 options 字段**但题干内嵌任务列表（DSL 层
   * 非法、契约层宽容放行的形态）——studentStemMd 只在有 options 时剥任务
   * 列表，投影后 `- [x]` 正确项标记原样保留 → 哨兵命中。
   * 该守卫防未来学生端路由直返 material 绕过投影不变量（前端守卫只是纵深）。
   */
  const leakyStem = "选择：\n\n- [x] 正确项甲\n- [ ] 干扰项乙\n";

  function leakyWorld() {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const a1 = frozenDraftAttempt(db, s1, [
      {
        questionId: "恶意题-1",
        snapshotJson: snapshotJsonOf({ id: "恶意题-1", stemMd: leakyStem }),
      },
    ]);
    submitAttemptStatus(db, a1.attemptId);
    return { db, dataDir, attemptId: a1.attemptId };
  }

  it("学生角色：投影后仍含答案标记 → 抛 500 EXPORT_ASSEMBLY_BROKEN，不出任何材料", () => {
    const { db, dataDir, attemptId } = leakyWorld();
    let caught: unknown;
    try {
      assemble(db, dataDir, TEST_TEACHER_ID, [scopeOf(db, attemptId)], {
        role: "student",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const httpErr = caught as HttpError;
    expect(httpErr.status).toBe(500);
    expect(httpErr.code).toBe("EXPORT_ASSEMBLY_BROKEN");
    expect(httpErr.message).toContain("答案标记");
  });

  it("教师角色不受哨兵影响（同一快照照常装配；stem 层投影逻辑不变）", () => {
    const { db, dataDir, attemptId } = leakyWorld();
    const result = assemble(
      db,
      dataDir,
      TEST_TEACHER_ID,
      [scopeOf(db, attemptId)],
      {
        role: "teacher",
        questionLevel: "stem",
      },
    );
    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0]?.material.stemMd).toContain("[x]");
  });
});

// ---------- 角色投影先于素材装配（学生包泄露） ----------

describe("T6R.12 角色投影先于素材装配", () => {
  /** 带答案哨兵的题：题干空、答案、解析、提示各含独立哨兵串 */
  const SENTRY = {
    answer: "秘密答案99",
    solution: "解析哨兵：因为所以",
    hint: "提示哨兵内容X",
  };

  function sentryWorld() {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const a1 = frozenDraftAttempt(db, s1, [
      {
        questionId: "哨兵题-1",
        snapshotJson: snapshotJsonOf({
          id: "哨兵题-1",
          type: "choice",
          stemMd: `下列正确的是（已知答案为 [[${SENTRY.answer}]] 属于填空写法）`,
          options: [{ text: "甲" }, { text: "乙" }],
          answers: { kind: "choice", index: 1 } satisfies QuestionAnswers,
          solutionMd: `${SENTRY.solution}，选乙。`,
          hints: [SENTRY.hint],
        }),
      },
    ]);
    submitAttemptStatus(db, a1.attemptId);
    return { db, dataDir, attemptId: a1.attemptId };
  }

  it("学生角色：任何层级请求都只出学生端投影，哨兵不进装配对象任何字符串", () => {
    const { db, dataDir, attemptId } = sentryWorld();
    for (const level of ["stem", "answer", "solution"] as const) {
      const result = assemble(
        db,
        dataDir,
        TEST_TEACHER_ID,
        [scopeOf(db, attemptId)],
        { role: "student", questionLevel: level },
      );
      const dump = JSON.stringify(result);
      expect(dump, `学生角色 level=${level} 不得含答案哨兵`).not.toContain(
        SENTRY.answer,
      );
      expect(dump, `学生角色 level=${level} 不得含解析哨兵`).not.toContain(
        SENTRY.solution,
      );
      expect(dump, `学生角色 level=${level} 不得含提示哨兵`).not.toContain(
        SENTRY.hint,
      );
      // 投影题干无任务列表/非空标记（md-dsl oracle 谓词）
      const stem = result.revisions[0]?.material.stemMd ?? "";
      expect(stemMdLeaksAnswers(stem)).toBe(false);
      // 结构性：answers/solutionMd 字段不出现
      expect(dump).not.toContain('"answers"');
      expect(dump).not.toContain('"solutionMd"');
      // 选项文本保留（完整选项——学生可读但不含正误）
      expect(result.revisions[0]?.material.options).toEqual(["甲", "乙"]);
    }
  });

  it("教师层级：stem 层同样学生端投影；answer/solution 层保留原文", () => {
    const { db, dataDir, attemptId } = sentryWorld();
    const stem = assemble(
      db,
      dataDir,
      TEST_TEACHER_ID,
      [scopeOf(db, attemptId)],
      {
        questionLevel: "stem",
      },
    );
    expect(stem.revisions[0]?.material.stemMd).not.toContain(SENTRY.answer);
    expect(JSON.stringify(stem)).not.toContain(SENTRY.solution);

    const solution = assemble(
      db,
      dataDir,
      TEST_TEACHER_ID,
      [scopeOf(db, attemptId)],
      {
        questionLevel: "solution",
      },
    );
    expect(solution.revisions[0]?.material.stemMd).toContain(SENTRY.answer);
    expect(solution.revisions[0]?.material.solutionMd).toContain(
      SENTRY.solution,
    );
    expect(solution.revisions[0]?.material.answers).toEqual({
      kind: "choice",
      index: 1,
    });
  });

  it("学生角色的媒体扫描只扫投影后的文本：解析里的图不进学生包", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    // 两张真实图片（内容寻址落盘）
    const stemImg = saveMedia(
      dataDir,
      makeNotePng(40, 40).slice() as Uint8Array<ArrayBuffer>,
    );
    const solutionImg = saveMedia(
      dataDir,
      makeNotePng(41, 41).slice() as Uint8Array<ArrayBuffer>,
    );
    const s1 = makeStudent(db);
    const a1 = frozenDraftAttempt(db, s1, [
      {
        questionId: "图题-5",
        snapshotJson: snapshotJsonOf({
          id: "图题-5",
          stemMd: `看图作答：\n\n:::image{src="${stemImg.src}"}\n\n[[答案]]`,
          answers: {
            kind: "fill",
            blanks: [["答案"]],
          } satisfies QuestionAnswers,
          solutionMd: `:::image{src="${solutionImg.src}"}\n\n解析配图`,
        }),
      },
    ]);
    submitAttemptStatus(db, a1.attemptId);

    const student = assemble(
      db,
      dataDir,
      TEST_TEACHER_ID,
      [scopeOf(db, a1.attemptId)],
      {
        role: "student",
        questionLevel: "solution", // 学生角色忽略层级——解析图仍不得进入
      },
    );
    expect(student.media.map((m) => m.src)).toEqual([stemImg.src]);
    expect(JSON.stringify(student)).not.toContain(solutionImg.src);

    const teacher = assemble(
      db,
      dataDir,
      TEST_TEACHER_ID,
      [scopeOf(db, a1.attemptId)],
      {
        questionLevel: "solution",
      },
    );
    expect(teacher.media.map((m) => m.src).sort()).toEqual(
      [stemImg.src, solutionImg.src].sort(),
    );
  });
});

// ---------- 证据装配 ----------

describe("T6R.12 证据装配（submission_evidence + 分析图）", () => {
  /** 证据世界：一 attempt 三题——frozen（两页分析图）/ missing / none；另有行删除模拟 not_collected */
  function evidenceWorld() {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const a1 = frozenDraftAttempt(db, s1, [
      {
        questionId: "frozen-题",
        snapshotJson: snapshotJsonOf({ id: "frozen-题" }),
      },
      {
        questionId: "missing-题",
        snapshotJson: snapshotJsonOf({ id: "missing-题" }),
      },
      {
        questionId: "none-题",
        snapshotJson: snapshotJsonOf({ id: "none-题" }),
      },
      {
        questionId: "legacy-题",
        snapshotJson: snapshotJsonOf({ id: "legacy-题" }),
      },
      {
        questionId: "未采集-题",
        snapshotJson: snapshotJsonOf({ id: "未采集-题" }),
      },
    ]);
    // frozen-题：draft 期存稿 + 两页分析图，随后交卷固定
    const receipt = saveNoteVersion(
      db,
      dataDir,
      s1,
      a1.attemptId,
      "frozen-题",
      gzipJson(noteDoc(3, 40)),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    const png1 = makeNotePng(1000, 800);
    const png2 = makeNotePng(1000, 640);
    attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: s1 },
      receipt.versionId,
      png1,
      {
        spec: "analysis",
        pageIndex: 0,
        crop: { x: 0, y: 0, width: 1000, height: 800 },
        pixelWidth: 1000,
        pixelHeight: 800,
      },
    );
    attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: s1 },
      receipt.versionId,
      png2,
      {
        spec: "analysis",
        pageIndex: 1,
        crop: { x: 0, y: 760, width: 1000, height: 640 },
        pixelWidth: 1000,
        pixelHeight: 640,
      },
    );
    // 缩略图：不进证据包（只有 analysis 规格参与装配）
    attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: s1 },
      receipt.versionId,
      makeNotePng(200, 160),
      {
        spec: "thumbnail",
        pageIndex: 0,
        crop: { x: 0, y: 0, width: 1000, height: 800 },
        pixelWidth: 200,
        pixelHeight: 160,
      },
    );
    submitAttemptStatus(db, a1.attemptId);
    insertEvidence(db, a1.attemptId, "frozen-题", "frozen", receipt.versionId);
    insertEvidence(db, a1.attemptId, "missing-题", "missing", null);
    insertEvidence(db, a1.attemptId, "none-题", "none", null);
    insertEvidence(db, a1.attemptId, "legacy-题", "legacy_unverified", null);
    // 未采集-题：无证据行（旧客户端兼容交卷）
    return {
      db,
      dataDir,
      s1,
      attemptId: a1.attemptId,
      rowIds: a1.rowIds,
      versionId: receipt.versionId,
      png2Bytes: png2.byteLength,
    };
  }

  it("frozen 携带版本摘要与两页分析图（ready 附文件与字节）；四态如实呈现", () => {
    const world = evidenceWorld();
    const result = assemble(
      world.db,
      world.dataDir,
      TEST_TEACHER_ID,
      [scopeOf(world.db, world.attemptId)],
      { includeEvidence: true },
    );

    expect(result.evidence).toHaveLength(5);
    const [frozen, missing, none, legacy, notCollected] = result.evidence;
    expect(frozen?.state).toBe("frozen");
    expect(frozen?.phase).toBe("scratch");
    expect(frozen?.version?.versionId).toBe(world.versionId);
    expect(frozen?.version?.strokeCount).toBe(3);
    expect(frozen?.images).toHaveLength(2);
    expect(frozen?.images[0]?.state).toBe("ready");
    expect(frozen?.images[0]?.file).toBe(
      evidenceImageFileName(frozen?.ref ?? "e000", "scratch", 0),
    );
    expect(frozen?.images[0]?.bytes).toBeGreaterThan(0);
    expect(frozen?.images[1]?.crop).toEqual({
      x: 0,
      y: 760,
      width: 1000,
      height: 640,
    });
    expect(missing?.state).toBe("missing");
    expect(none?.state).toBe("none");
    expect(legacy?.state).toBe("legacy_unverified");
    expect(notCollected?.state).toBe("not_collected");
    // 非 frozen 无版本摘要与图片
    expect(missing?.version).toBeUndefined();
    expect(missing?.images).toEqual([]);
    // 每行 response 的证据引用（includeEvidence 时恒有 eRef）
    for (const rowId of world.rowIds) {
      expect(result.evidenceRefByResponseRowId.get(rowId)).toBeDefined();
    }
    const frozenRowId = world.rowIds[0] ?? "";
    expect(result.evidenceRefByResponseRowId.get(frozenRowId)).toBe(
      frozen?.ref,
    );
    // 证据条目回指题目条目
    expect(frozen?.questionRef).toBe(
      result.refByResponseRowId.get(frozenRowId ?? ""),
    );
  });

  it("文件缺失清单：分析图文件被删/未生成 → 显式缺失原因，不静默消失", () => {
    const world = evidenceWorld();
    // 删除第二页分析图文件（磁盘缺失）
    const imgRow = world.db
      .select()
      .from(noteImages)
      .where(eq(noteImages.noteVersionId, world.versionId))
      .all()
      .find((r) => r.spec === "analysis" && r.pageIndex === 1);
    if (imgRow === undefined) throw new Error("夹具缺第二页分析图");
    rmSync(join(world.dataDir, imgRow.path), { force: true });

    const result = assemble(
      world.db,
      world.dataDir,
      TEST_TEACHER_ID,
      [scopeOf(world.db, world.attemptId)],
      { includeEvidence: true },
    );

    // 第二页：文件被删 → missing + 原因
    const frozen = result.evidence[0];
    expect(frozen?.images[1]?.state).toBe("missing");
    expect(frozen?.images[1]?.file).toMatch(/evidence\/e001-original-02\.png/);
    const deleted = result.missingEvidenceImages.find((m) =>
      m.file.endsWith("original-02.png"),
    );
    expect(deleted?.reason).toContain("文件缺失");
    expect(deleted?.evidenceRef).toBe(frozen?.ref);
  });

  it("frozen 版本零分析图（未生成）→ 预测路径进缺失清单", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const s1 = makeStudent(db);
    const a1 = frozenDraftAttempt(db, s1, [
      { questionId: "零图题", snapshotJson: snapshotJsonOf({ id: "零图题" }) },
    ]);
    const receipt = saveNoteVersion(
      db,
      dataDir,
      s1,
      a1.attemptId,
      "零图题",
      gzipJson(noteDoc(1, 10)),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    submitAttemptStatus(db, a1.attemptId);
    insertEvidence(db, a1.attemptId, "零图题", "frozen", receipt.versionId);

    const result = assemble(
      db,
      dataDir,
      TEST_TEACHER_ID,
      [scopeOf(db, a1.attemptId)],
      {
        includeEvidence: true,
      },
    );
    const zero = result.evidence[0];
    expect(zero?.state).toBe("frozen");
    expect(zero?.version?.versionId).toBe(receipt.versionId);
    expect(zero?.images).toEqual([]);
    expect(result.missingEvidenceImages).toHaveLength(1);
    expect(result.missingEvidenceImages[0]?.file).toBe(
      "evidence/e001-original-01.png",
    );
    expect(result.missingEvidenceImages[0]?.reason).toContain("未生成");
  });

  it("化名文件名不含真实 id（学生/attempt/version/question id 均不进路径）", () => {
    const world = evidenceWorld();
    const result = assemble(
      world.db,
      world.dataDir,
      TEST_TEACHER_ID,
      [scopeOf(world.db, world.attemptId)],
      { includeEvidence: true },
    );
    const allFiles = [
      ...result.evidence.flatMap((e) => e.images.map((img) => img.file)),
      ...result.missingEvidenceImages.map((m) => m.file),
    ];
    expect(allFiles.length).toBeGreaterThan(0);
    for (const file of allFiles) {
      expect(file).toMatch(
        /^evidence\/e\d{3,}-(original|correction|supplement)-\d{2}\.png$/,
      );
      expect(file).not.toContain(world.s1);
      expect(file).not.toContain(world.attemptId);
      expect(file).not.toContain(world.versionId);
      expect(file).not.toContain("frozen-题");
    }
  });
});

// ---------- 媒体引用保留 ----------

describe("T6R.12 媒体引用保留（历史引用与缺失清单）", () => {
  it("历史快照引用的媒体随包登记；缺失文件进缺失清单并带题号关联", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const present = saveMedia(
      dataDir,
      makeNotePng(50, 50).slice() as Uint8Array<ArrayBuffer>,
    );
    const missingHash = `${"b".repeat(64)}.png`;
    const s1 = makeStudent(db);
    const a1 = frozenDraftAttempt(db, s1, [
      {
        questionId: "媒体题-6",
        snapshotJson: snapshotJsonOf({
          id: "媒体题-6",
          stemMd: `:::image{src="${present.src}"}\n\n:::image{src="blobs/media/${missingHash}"}`,
        }),
      },
    ]);
    submitAttemptStatus(db, a1.attemptId);

    const result = assemble(db, dataDir, TEST_TEACHER_ID, [
      scopeOf(db, a1.attemptId),
    ]);
    expect(result.media).toHaveLength(1);
    expect(result.media[0]?.src).toBe(present.src);
    expect(result.media[0]?.bytes).toBeGreaterThan(0);
    expect(result.media[0]?.questionRefs).toHaveLength(1);
    expect(result.missingMedia).toHaveLength(1);
    expect(result.missingMedia[0]?.src).toBe(`blobs/media/${missingHash}`);
    expect(result.missingMedia[0]?.reason.length).toBeGreaterThan(0);
  });
});
