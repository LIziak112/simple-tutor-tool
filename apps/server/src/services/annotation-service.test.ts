import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { AnnotationDoc, Question, QuestionAnswers } from "@tutor/contract";
import { annotationDocSchema } from "@tutor/contract";
import { stemMdLeaksAnswers } from "@tutor/md-dsl";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import {
  annotationBases as annotationBasesTable,
  annotations as annotationsTable,
  questions as questionsTable,
  responses as responsesTable,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
  submitAttemptStatus,
} from "../test/evidence-fixtures.ts";
import { expectHttpError } from "../test/expect-http-error.ts";
import { gzipJson, makeNotePng, makeStudent } from "../test/note-fixtures.ts";
import {
  annotationBaseImageBytes,
  annotationBaseRelPath,
  annotationBodyRelPath,
  assembleAnnotationBase,
  assembleAnnotationPairs,
  canonicalAnnotationJson,
  getAnnotationView,
  putAnnotationDoc,
  registerBaseImage,
  sealAttemptAnnotations,
} from "./annotation-service.ts";

/**
 * T6R.20 服务层测试（失败测试先行）：覆盖任务条目五项失败测试的服务端半边——
 * - 没有可靠底图不能落墨：base pending/缺失时 PUT 409；
 * - 跨角色图不含隐藏答案：装配载荷仅学生 stem 投影（stemMdLeaksAnswers＋
 *   哨兵标记双检）；
 * - 订正不改旧标注：sealed 后 PUT 409；correction 另开记录；
 * - 底图身份三要素：上传校验/ready 永不重生成/stale 判定；
 * - CAS/幂等/seal 幂等/直出授权/成对装配（底图缺失跳过 strokes）。
 */

const SENTINELS = {
  answer: "42",
  solution: "哨兵解析：先算括号内再取相反数",
  hint: "哨兵提示：从数轴方向入手",
} as const;

const Q = "复习题-1";
const UNIT = "unit-x";

interface World {
  readonly db: Db;
  readonly dataDir: string;
  readonly studentId: string;
  readonly otherStudentId: string;
}

function makeWorld(): World {
  const db = createTestDb();
  return {
    db,
    dataDir: createTestDir(),
    studentId: makeStudent(db),
    otherStudentId: makeStudent(db),
  };
}

interface PaperOptions {
  readonly status?: "draft" | "submitted";
  readonly stemMd?: string;
  readonly answers?: QuestionAnswers;
}

/** 建一份单题卷（fill 题＋答案/解析/提示哨兵；缺省 draft）并返回定位四件套 */
function makePaper(
  world: World,
  options: PaperOptions = {},
): { attemptId: string; revisionId: string } {
  const stemMd =
    options.stemMd ??
    `计算 $(-3)+7-(-2)$ 的结果，填在括号里：[[${SENTINELS.answer}]]`;
  const { attemptId, rowIds } = frozenDraftAttempt(
    world.db,
    world.studentId,
    [
      {
        questionId: Q,
        snapshotJson: snapshotJsonOf({
          id: Q,
          stemMd,
          answers: options.answers ?? {
            kind: "fill",
            blanks: [[SENTINELS.answer]],
          },
          solutionMd: SENTINELS.solution,
          hints: [SENTINELS.hint],
        }),
        unitId: UNIT,
      },
    ],
    { attemptUnitId: UNIT },
  );
  if (options.status === "submitted") {
    submitAttemptStatus(world.db, attemptId);
  }
  return { attemptId, revisionId: rowIds[0] ?? "" };
}

/** 最小合法 AnnotationDoc（底图 1440×height） */
function annotationDoc(height = 900, strokes = 1): AnnotationDoc {
  return annotationDocSchema.parse({
    version: 1,
    baseWidth: 1440,
    baseHeight: height,
    strokes: Array.from({ length: strokes }, (_, i) => ({
      tool: "pen",
      color: "#c0392b",
      weight: 6,
      points: [
        { x: 10 + i, y: 20, p: 0.5, t: 0 },
        { x: 40 + i, y: 60, p: 0.8, t: 25 },
      ],
    })),
  });
}

/** 底图 PNG（宽恒 1440；makeNotePng 是魔数+IHDR+IEND 的最小合法 PNG） */
function basePng(height = 900, padding = 0): Uint8Array {
  return makeNotePng(1440, height, padding);
}

/** 走完两阶段：preview → 回传 PNG → ready（返回 preview 的 baseId） */
function readyBase(
  world: World,
  attemptId: string,
  revisionId: string,
  png: Uint8Array = basePng(),
  phase: "scratch" | "correction" = "scratch",
): string {
  const preview = assembleAnnotationBase(
    world.db,
    world.studentId,
    attemptId,
    Q,
    phase,
  );
  registerBaseImage(
    world.db,
    world.dataDir,
    world.studentId,
    attemptId,
    Q,
    png,
    {
      questionRevisionId: revisionId,
      baseRenderVersion: preview.baseRenderVersion,
      phase,
    },
  );
  return preview.base.baseId;
}

// ---------- assembleAnnotationBase ----------

describe("assembleAnnotationBase：载荷装配与泄露防线", () => {
  it("建 pending 行并返回学生 stem 投影载荷（不含 snapshotHash/答案哨兵）", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    const preview = assembleAnnotationBase(
      world.db,
      world.studentId,
      attemptId,
      Q,
    );
    expect(preview.base.state).toBe("pending");
    expect(preview.base.stale).toBe(false);
    expect(preview.maxWidthPx).toBe(1440);
    expect(preview.baseRenderVersion).toBe(1);
    expect(preview.questionRevisionId).toBe(revisionId);
    expect(preview.questionNo).toBe(1);
    // 题面含题干与脱敏括号（[[42]] → [[]]），绝不含答案/解析/提示哨兵
    expect(preview.questionMd).toContain("[[]]");
    expect(preview.questionMd).not.toContain(SENTINELS.answer);
    expect(preview.questionMd).not.toContain(SENTINELS.solution);
    expect(preview.questionMd).not.toContain(SENTINELS.hint);
    // 双检①：stemMdLeaksAnswers 对投影后题面为 false
    expect(stemMdLeaksAnswers(preview.questionMd)).toBe(false);
    // 双检②：载荷结构性不含 snapshotHash（F1 离线答案 oracle 防线）
    expect("snapshotHash" in preview).toBe(false);
    // 整包 JSON 不含解析/提示哨兵（答案 "42" 是十六进制子串会撞 UUID/hash，
    // 答案级断言只对 questionMd 做精确内容检查）
    const json = JSON.stringify({ ok: true, data: preview });
    expect(json).not.toContain(SENTINELS.solution);
    expect(json).not.toContain(SENTINELS.hint);
    assertNoLeak(JSON.parse(json));
    // 行已建（pending）
    const row = world.db
      .select()
      .from(annotationBasesTable)
      .where(eq(annotationBasesTable.attemptId, attemptId))
      .get();
    expect(row?.state).toBe("pending");
    expect(row?.questionRevisionId).toBe(revisionId);
  });

  it("幂等：重复调用同一 baseId；ready 后仍同 baseId 且携带直出 URL", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    const first = assembleAnnotationBase(
      world.db,
      world.studentId,
      attemptId,
      Q,
    );
    const second = assembleAnnotationBase(
      world.db,
      world.studentId,
      attemptId,
      Q,
    );
    expect(second.base.baseId).toBe(first.base.baseId);
    registerBaseImage(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      basePng(),
      {
        questionRevisionId: revisionId,
        baseRenderVersion: 1,
        phase: "scratch",
      },
    );
    const third = assembleAnnotationBase(
      world.db,
      world.studentId,
      attemptId,
      Q,
    );
    expect(third.base.baseId).toBe(first.base.baseId);
    expect(third.base.state).toBe("ready");
    expect(third.base.downloadUrl).toBe(
      `/api/student/attempts/${attemptId}/annotation-base/${first.base.baseId}/image.png`,
    );
  });

  it("::image 与 ::graph 独立成行时进素材清单（参数化图表）", () => {
    const world = makeWorld();
    const { attemptId } = makePaper(world, {
      stemMd: `看图回答。\n\n::image{src="blobs/media/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.png"}\n\n函数图像如下，过原点的是：\n\n::graph{fn="x^2" range="[-2,2]"}\n\n填在括号里：[[1]]`,
    });
    const preview = assembleAnnotationBase(
      world.db,
      world.studentId,
      attemptId,
      Q,
    );
    expect(preview.mediaSrcs).toContain(
      "blobs/media/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.png",
    );
    expect(preview.graphFigures).toEqual([{ fn: "x^2", range: "[-2,2]" }]);
    // 题面里图表被替换为参数化静态说明（不要求读者猜原图形）
    expect(preview.questionMd).toContain("x^2");
  });

  it("他学生 403；attempt 不存在 404；题目不在卷内 404", () => {
    const world = makeWorld();
    const { attemptId } = makePaper(world);
    try {
      assembleAnnotationBase(world.db, world.otherStudentId, attemptId, Q);
      throw new Error("应当抛 403");
    } catch (err) {
      expectHttpError(err, 403, "FORBIDDEN");
    }
    try {
      assembleAnnotationBase(world.db, world.studentId, randomUUID(), Q);
      throw new Error("应当抛 404");
    } catch (err) {
      expectHttpError(err, 404, "ATTEMPT_NOT_FOUND");
    }
    try {
      assembleAnnotationBase(world.db, world.studentId, attemptId, "不在卷内");
      throw new Error("应当抛 404");
    } catch (err) {
      expectHttpError(err, 404, "QUESTION_NOT_FOUND");
    }
  });

  it("投影哨兵：题干任务列表形态（- [x] 答案）触发 materialOf 500 拒绝装配", () => {
    const world = makeWorld();
    const { attemptId } = makePaper(world, {
      stemMd: `判断并选择：\n\n- [x] ${SENTINELS.answer}\n- [ ] 别的`,
      answers: { kind: "final", answer: SENTINELS.answer },
    });
    try {
      assembleAnnotationBase(world.db, world.studentId, attemptId, Q);
      throw new Error("应当抛 500 EXPORT_ASSEMBLY_BROKEN");
    } catch (err) {
      expectHttpError(err, 500, "EXPORT_ASSEMBLY_BROKEN");
    }
  });
});

// ---------- registerBaseImage ----------

describe("registerBaseImage：身份校验与落盘", () => {
  it("ready：文件落 blobs/annotations/<hash>.png（绝不进 media 段）", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    const preview = assembleAnnotationBase(
      world.db,
      world.studentId,
      attemptId,
      Q,
    );
    const png = basePng(960);
    const receipt = registerBaseImage(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      png,
      {
        questionRevisionId: revisionId,
        baseRenderVersion: preview.baseRenderVersion,
        phase: "scratch",
      },
    );
    expect(receipt.state).toBe("ready");
    expect(receipt.pixelWidth).toBe(1440);
    expect(receipt.pixelHeight).toBe(960);
    const absPath = join(
      world.dataDir,
      annotationBaseRelPath(receipt.imageHash),
    );
    expect(absPath).toContain(join("blobs", "annotations"));
    expect(existsSync(absPath)).toBe(true);
    expect(new Uint8Array(readFileSync(absPath))).toEqual(png);
  });

  it("无 base 行 404；回传身份错 409 ANNOTATION_BASE_STALE", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    try {
      registerBaseImage(
        world.db,
        world.dataDir,
        world.studentId,
        attemptId,
        Q,
        basePng(),
        {
          questionRevisionId: revisionId,
          baseRenderVersion: 1,
          phase: "scratch",
        },
      );
      throw new Error("应当抛 404");
    } catch (err) {
      expectHttpError(err, 404, "ANNOTATION_NOT_FOUND");
    }
    assembleAnnotationBase(world.db, world.studentId, attemptId, Q);
    try {
      registerBaseImage(
        world.db,
        world.dataDir,
        world.studentId,
        attemptId,
        Q,
        basePng(),
        {
          questionRevisionId: "别的版本",
          baseRenderVersion: 1,
          phase: "scratch",
        },
      );
      throw new Error("应当抛 409");
    } catch (err) {
      expectHttpError(err, 409, "ANNOTATION_BASE_STALE");
    }
  });

  it("非 PNG/宽度不符/高超上限 400；超字节 413", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    const meta = {
      questionRevisionId: revisionId,
      baseRenderVersion: 1,
      phase: "scratch" as const,
    };
    assembleAnnotationBase(world.db, world.studentId, attemptId, Q);
    const cases: ReadonlyArray<[Uint8Array, number, string]> = [
      [new Uint8Array([1, 2, 3]), 400, "ANNOTATION_BASE_IMAGE_INVALID"],
      [makeNotePng(720, 900), 400, "ANNOTATION_BASE_IMAGE_INVALID"],
      [basePng(4097), 400, "ANNOTATION_BASE_IMAGE_INVALID"],
      [
        basePng(900, ANNOTATION_BASE_PNG_PADDING_OVER),
        413,
        "ANNOTATION_LIMIT_EXCEEDED",
      ],
    ];
    for (const [png, status, code] of cases) {
      try {
        registerBaseImage(
          world.db,
          world.dataDir,
          world.studentId,
          attemptId,
          Q,
          png,
          meta,
        );
        throw new Error(`应当抛 ${code}`);
      } catch (err) {
        expectHttpError(err, status, code);
      }
    }
  });

  it("ready 永不重生成：同字节幂等返回；异字节 409 ANNOTATION_BASE_ALREADY_READY", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    const meta = {
      questionRevisionId: revisionId,
      baseRenderVersion: 1,
      phase: "scratch" as const,
    };
    assembleAnnotationBase(world.db, world.studentId, attemptId, Q);
    const first = registerBaseImage(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      basePng(900),
      meta,
    );
    const again = registerBaseImage(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      basePng(900),
      meta,
    );
    expect(again.imageHash).toBe(first.imageHash);
    expect(again.updatedAt).toBe(first.updatedAt);
    try {
      registerBaseImage(
        world.db,
        world.dataDir,
        world.studentId,
        attemptId,
        Q,
        basePng(960),
        meta,
      );
      throw new Error("应当抛 409");
    } catch (err) {
      expectHttpError(err, 409, "ANNOTATION_BASE_ALREADY_READY");
    }
  });
});

/** 超限额底图的 padding（8MiB 上限 + 1） */
const ANNOTATION_BASE_PNG_PADDING_OVER = 8 * 1024 * 1024 + 1;

// ---------- putAnnotationDoc ----------

describe("putAnnotationDoc：CAS/幂等/门槛", () => {
  it("ready 底图后写入 revision 1；正文文件落 blobs/annotation-bodies/<hash>.json.gz", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId);
    const doc = annotationDoc(900, 2);
    const receipt = putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(doc),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    expect(receipt.revision).toBe(1);
    const absBody = join(world.dataDir, annotationBodyRelPath(receipt.hash));
    expect(absBody).toContain(join("blobs", "annotation-bodies"));
    expect(existsSync(absBody)).toBe(true);
    // 落盘字节 = 规范化 JSON 的 gzip（hash 与 canonical 对齐）
    const round = JSON.parse(
      new TextDecoder().decode(
        gunzipSync(new Uint8Array(readFileSync(absBody))),
      ),
    ) as unknown;
    expect(round).toEqual(JSON.parse(canonicalAnnotationJson(doc)));
  });

  it("没有可靠底图不能落墨：base 缺失/pending 一律 409 ANNOTATION_BASE_NOT_READY", () => {
    const world = makeWorld();
    const { attemptId } = makePaper(world);
    try {
      putAnnotationDoc(
        world.db,
        world.dataDir,
        world.studentId,
        attemptId,
        Q,
        gzipJson(annotationDoc()),
        {
          baseRevision: 0,
          mutationId: randomUUID(),
        },
      );
      throw new Error("应当抛 409");
    } catch (err) {
      expectHttpError(err, 409, "ANNOTATION_BASE_NOT_READY");
    }
    assembleAnnotationBase(world.db, world.studentId, attemptId, Q);
    try {
      putAnnotationDoc(
        world.db,
        world.dataDir,
        world.studentId,
        attemptId,
        Q,
        gzipJson(annotationDoc()),
        {
          baseRevision: 0,
          mutationId: randomUUID(),
        },
      );
      throw new Error("应当抛 409");
    } catch (err) {
      expectHttpError(err, 409, "ANNOTATION_BASE_NOT_READY");
    }
  });

  it("文档坐标域与底图几何不一致 400", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId, basePng(960));
    try {
      putAnnotationDoc(
        world.db,
        world.dataDir,
        world.studentId,
        attemptId,
        Q,
        gzipJson(annotationDoc(900)),
        {
          baseRevision: 0,
          mutationId: randomUUID(),
        },
      );
      throw new Error("应当抛 400");
    } catch (err) {
      expectHttpError(err, 400, "ANNOTATION_VALIDATION_FAILED");
    }
  });

  it("CAS：baseRevision 落后 409 附 _current；两客户端同 baseRevision 仅一个成功", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId);
    const first = putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    expect(first.revision).toBe(1);
    try {
      putAnnotationDoc(
        world.db,
        world.dataDir,
        world.studentId,
        attemptId,
        Q,
        gzipJson(annotationDoc(900, 2)),
        {
          baseRevision: 0,
          mutationId: randomUUID(),
        },
      );
      throw new Error("应当抛 409");
    } catch (err) {
      expectHttpError(err, 409, "ANNOTATION_REVISION_CONFLICT", {
        _current: { revision: 1, annotationId: first.annotationId },
      });
    }
    const second = putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc(900, 2)),
      { baseRevision: 1, mutationId: randomUUID() },
    );
    expect(second.revision).toBe(2);
  });

  it("mutationId 幂等：丢回执重试原样返回；同 id 异文/跨题 409 MISMATCH", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId);
    const mutationId = randomUUID();
    const receipt = putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      { baseRevision: 0, mutationId },
    );
    const replay = putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      { baseRevision: 0, mutationId },
    );
    expect(replay).toEqual(receipt);
    try {
      putAnnotationDoc(
        world.db,
        world.dataDir,
        world.studentId,
        attemptId,
        Q,
        gzipJson(annotationDoc(900, 2)),
        {
          baseRevision: 1,
          mutationId,
        },
      );
      throw new Error("应当抛 409");
    } catch (err) {
      expectHttpError(err, 409, "ANNOTATION_MUTATION_MISMATCH");
    }
  });

  it("交卷后 scratch 新写 409 ALREADY_SUBMITTED；幂等重放不受门槛约束", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId);
    const mutationId = randomUUID();
    const receipt = putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      { baseRevision: 0, mutationId },
    );
    submitAttemptStatus(world.db, attemptId);
    try {
      putAnnotationDoc(
        world.db,
        world.dataDir,
        world.studentId,
        attemptId,
        Q,
        gzipJson(annotationDoc(900, 2)),
        {
          baseRevision: 1,
          mutationId: randomUUID(),
        },
      );
      throw new Error("应当抛 409");
    } catch (err) {
      expectHttpError(err, 409, "ALREADY_SUBMITTED");
    }
    // 丢回执重试：同 mutationId 同文——交卷后仍返回原回执
    const replay = putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      { baseRevision: 0, mutationId },
    );
    expect(replay).toEqual(receipt);
  });

  it("correction：draft 上 409 ANNOTATION_NOT_SUBMITTED；交卷后另开新记录", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    try {
      putAnnotationDoc(
        world.db,
        world.dataDir,
        world.studentId,
        attemptId,
        Q,
        gzipJson(annotationDoc()),
        {
          baseRevision: 0,
          mutationId: randomUUID(),
          phase: "correction",
        },
      );
      throw new Error("应当抛 409（无 base 且 draft）");
    } catch (err) {
      // base gate 先于状态门槛——draft 上 correction 无底图先撞 NOT_READY
      expectHttpError(err, 409, "ANNOTATION_BASE_NOT_READY");
    }
    submitAttemptStatus(world.db, attemptId);
    // correction 底图独立于 scratch 底图（另开记录）
    const correctionBase = assembleAnnotationBase(
      world.db,
      world.studentId,
      attemptId,
      Q,
      "correction",
    );
    expect(correctionBase.base.state).toBe("pending");
    registerBaseImage(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      basePng(880),
      {
        questionRevisionId: revisionId,
        baseRenderVersion: 1,
        phase: "correction",
      },
    );
    const receipt = putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc(880)),
      { baseRevision: 0, mutationId: randomUUID(), phase: "correction" },
    );
    expect(receipt.revision).toBe(1);
  });

  it("sealed 后 PUT 409 ANNOTATION_SEALED；scratch 记录 bytes 不变（订正不改旧标注）", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId);
    const receipt = putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    const absBody = join(world.dataDir, annotationBodyRelPath(receipt.hash));
    const bytesBefore = readFileSync(absBody);
    submitAttemptStatus(world.db, attemptId);
    const seal = sealAttemptAnnotations(world.db, world.studentId, attemptId);
    expect(seal.sealedCount).toBe(1);
    try {
      putAnnotationDoc(
        world.db,
        world.dataDir,
        world.studentId,
        attemptId,
        Q,
        gzipJson(annotationDoc(900, 2)),
        {
          baseRevision: 1,
          mutationId: randomUUID(),
        },
      );
      throw new Error("应当抛 409");
    } catch (err) {
      expectHttpError(err, 409, "ANNOTATION_SEALED");
    }
    // 旧记录字节不变（重试也不换文件）
    expect(readFileSync(absBody)).toEqual(bytesBefore);
    const row = world.db
      .select()
      .from(annotationsTable)
      .where(eq(annotationsTable.id, receipt.annotationId))
      .get();
    expect(row?.revision).toBe(1);
  });

  it("限额：gzip 字节超限 413；点数超限 413；形状错误 400", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId);
    // gzip 字节超限（>1MiB）
    try {
      putAnnotationDoc(
        world.db,
        world.dataDir,
        world.studentId,
        attemptId,
        Q,
        new Uint8Array(1024 * 1024 + 1),
        {
          baseRevision: 0,
          mutationId: randomUUID(),
        },
      );
      throw new Error("应当抛 413");
    } catch (err) {
      expectHttpError(err, 413, "ANNOTATION_LIMIT_EXCEEDED");
    }
    // 单笔点数超限（2001 点——不经 schema.parse 构造：超限文档本就过不了契约）
    const fatStroke = {
      version: 1,
      baseWidth: 1440,
      baseHeight: 900,
      strokes: [
        {
          tool: "pen",
          color: "#000",
          weight: 4,
          points: Array.from({ length: 2001 }, (_, i) => ({
            x: (i % 1400) + 0.5,
            y: (i % 800) + 0.5,
            p: 0.5,
            t: i,
          })),
        },
      ],
    };
    try {
      putAnnotationDoc(
        world.db,
        world.dataDir,
        world.studentId,
        attemptId,
        Q,
        gzipJson(fatStroke),
        {
          baseRevision: 0,
          mutationId: randomUUID(),
        },
      );
      throw new Error("应当抛 413");
    } catch (err) {
      expectHttpError(err, 413, "ANNOTATION_LIMIT_EXCEEDED");
    }
    // 形状错误（version=2）
    try {
      putAnnotationDoc(
        world.db,
        world.dataDir,
        world.studentId,
        attemptId,
        Q,
        gzipJson({ version: 2 }),
        {
          baseRevision: 0,
          mutationId: randomUUID(),
        },
      );
      throw new Error("应当抛 400");
    } catch (err) {
      expectHttpError(err, 400, "ANNOTATION_VALIDATION_FAILED");
    }
  });
});

// ---------- getAnnotationView / 直出 ----------

describe("getAnnotationView 与底图直出", () => {
  it("学生本人视图：base ready＋doc＋meta；教师视图同形状；他学生 403", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId);
    const receipt = putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    const view = getAnnotationView(
      world.db,
      world.dataDir,
      { kind: "student", id: world.studentId },
      attemptId,
      Q,
    );
    expect(view.base?.state).toBe("ready");
    expect(view.base?.stale).toBe(false);
    expect(view.doc?.baseHeight).toBe(900);
    expect(view.annotation?.revision).toBe(1);
    expect(view.annotation?.annotationId).toBe(receipt.annotationId);
    // 视图不含解析/提示哨兵（assertNoLeak 双检；答案数字会撞 hex 子串，不参与
    // 整包 JSON 子串断言——题面级答案断言在装配载荷用例）
    const json = JSON.stringify({ ok: true, data: view });
    expect(json).not.toContain(SENTINELS.solution);
    expect(json).not.toContain(SENTINELS.hint);
    assertNoLeak(JSON.parse(json));
    // 教师视图（教师域 URL）
    const teacherView = getAnnotationView(
      world.db,
      world.dataDir,
      { kind: "teacher", id: TEST_TEACHER_ID },
      attemptId,
      Q,
    );
    expect(teacherView.base?.downloadUrl).toMatch(
      /^\/api\/teacher\/annotation-bases\/.+\/image\.png$/,
    );
    // 他学生 403
    try {
      getAnnotationView(
        world.db,
        world.dataDir,
        { kind: "student", id: world.otherStudentId },
        attemptId,
        Q,
      );
      throw new Error("应当抛 403");
    } catch (err) {
      expectHttpError(err, 403, "FORBIDDEN");
    }
  });

  it("无底图空态（base/doc/annotation 全 null）；pending 无 downloadUrl", () => {
    const world = makeWorld();
    const { attemptId } = makePaper(world);
    const empty = getAnnotationView(
      world.db,
      world.dataDir,
      { kind: "student", id: world.studentId },
      attemptId,
      Q,
    );
    expect(empty.base).toBeNull();
    expect(empty.doc).toBeNull();
    expect(empty.annotation).toBeNull();
    assembleAnnotationBase(world.db, world.studentId, attemptId, Q);
    const pending = getAnnotationView(
      world.db,
      world.dataDir,
      { kind: "student", id: world.studentId },
      attemptId,
      Q,
    );
    expect(pending.base?.state).toBe("pending");
    expect(pending.base?.downloadUrl).toBeUndefined();
    expect(pending.doc).toBeNull();
  });

  it("stale：直改 snapshotHash 后视图标旧版（旧版本题干的标注）", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makeLivePaper(world);
    readyBase(world, attemptId, revisionId);
    world.db
      .update(annotationBasesTable)
      .set({ snapshotHash: `${"0".repeat(63)}1` })
      .where(eq(annotationBasesTable.attemptId, attemptId))
      .run();
    const view = getAnnotationView(
      world.db,
      world.dataDir,
      { kind: "student", id: world.studentId },
      attemptId,
      Q,
    );
    expect(view.base?.stale).toBe(true);
  });

  it("直出：学生本人/教师域可取原字节；他学生 404；跨 attempt baseId 404", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    const baseId = readyBase(world, attemptId, revisionId);
    const png = basePng();
    const bytes = annotationBaseImageBytes(
      world.db,
      world.dataDir,
      { kind: "student", id: world.studentId },
      attemptId,
      baseId,
    );
    expect(new Uint8Array(bytes)).toEqual(png);
    const teacherBytes = annotationBaseImageBytes(
      world.db,
      world.dataDir,
      { kind: "teacher", id: TEST_TEACHER_ID },
      undefined,
      baseId,
    );
    expect(new Uint8Array(teacherBytes)).toEqual(png);
    try {
      annotationBaseImageBytes(
        world.db,
        world.dataDir,
        { kind: "student", id: world.otherStudentId },
        attemptId,
        baseId,
      );
      throw new Error("应当抛 403");
    } catch (err) {
      expectHttpError(err, 403, "FORBIDDEN");
    }
    // 他学生的 attempt 上引用别人的 baseId：404（不暴露存在性）
    const { attemptId: otherAttempt } = makePaper(world);
    try {
      annotationBaseImageBytes(
        world.db,
        world.dataDir,
        { kind: "student", id: world.studentId },
        otherAttempt,
        baseId,
      );
      throw new Error("应当抛 404");
    } catch (err) {
      expectHttpError(err, 404, "ANNOTATION_NOT_FOUND");
    }
  });

  it("seal 幂等：重复 seal sealedCount=0（审查修复 2 起 seal 在交卷后）", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId);
    putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      {
        baseRevision: 0,
        mutationId: randomUUID(),
      },
    );
    submitAttemptStatus(world.db, attemptId);
    expect(
      sealAttemptAnnotations(world.db, world.studentId, attemptId).sealedCount,
    ).toBe(1);
    expect(
      sealAttemptAnnotations(world.db, world.studentId, attemptId).sealedCount,
    ).toBe(0);
  });
});

// ---------- 审查修复 2：seal 时序（交卷不可逆点后 + 懒补封自愈） ----------

describe("seal 时序：门槛与懒补封（审查修复 2）", () => {
  it("draft 期 seal scratch → 409（杀自害自封）；此后标注仍可编辑（交卷中止不留死锁）", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId);
    putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    try {
      sealAttemptAnnotations(world.db, world.studentId, attemptId);
      throw new Error("应当抛 409");
    } catch (err) {
      expectHttpError(err, 409, "ANNOTATION_NOT_SUBMITTED");
    }
    // 交卷中止（继续作答）：标注未被锁死——CAS 下一版照常写入
    const second = putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc(900, 2)),
      { baseRevision: 1, mutationId: randomUUID() },
    );
    expect(second.revision).toBe(2);
  });

  it("draft 期 seal correction 合法（幂等空封 sealedCount=0，不拦订正检查点语义）", () => {
    const world = makeWorld();
    const { attemptId } = makePaper(world);
    const seal = sealAttemptAnnotations(
      world.db,
      world.studentId,
      attemptId,
      "correction",
    );
    expect(seal.sealedCount).toBe(0);
  });

  it("已交卷未 seal：getAnnotationView 懒补封（sealedAt 回填、幂等）", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId);
    putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    submitAttemptStatus(world.db, attemptId);
    // 未显式 seal——视图读取入口现场补封（客户端 seal 网络失败的自愈路径）
    const view = getAnnotationView(
      world.db,
      world.dataDir,
      { kind: "student", id: world.studentId },
      attemptId,
      Q,
    );
    expect(view.annotation?.sealedAt).not.toBeNull();
    // 幂等：再次读取不重复计数、值稳定
    const again = getAnnotationView(
      world.db,
      world.dataDir,
      { kind: "student", id: world.studentId },
      attemptId,
      Q,
    );
    expect(again.annotation?.sealedAt).toBe(view.annotation?.sealedAt);
  });

  it("已交卷未 seal：assembleAnnotationPairs 懒补封——未显式 seal 也成对收录", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId);
    putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    submitAttemptStatus(world.db, attemptId);
    const asm = assembleAnnotationPairs(world.db, world.dataDir, [
      { rows: responseRowsOf(world.db, attemptId) },
    ]);
    expect(asm.pairs).toHaveLength(1);
    expect(asm.pairs[0]?.phase).toBe("scratch");
  });
});

// ---------- 审查修复 4：stale 判定真化（与题库当前内容比对） ----------

/** 从冻结快照镜像建 questions 表 live 行（同内容——knowledge 空口径） */
function insertLiveQuestionFromSnapshot(
  world: World,
  snapshotJson: string,
): void {
  const q = JSON.parse(snapshotJson) as Question;
  world.db
    .insert(questionsTable)
    .values({
      id: q.id,
      teacherId: TEST_TEACHER_ID,
      unitId: UNIT,
      order: 0,
      type: q.type,
      difficulty: q.difficulty,
      stemMd: q.stemMd,
      optionsJson: q.options !== undefined ? JSON.stringify(q.options) : null,
      answersJson: q.answers !== undefined ? JSON.stringify(q.answers) : null,
      hintsJson: JSON.stringify(q.hints),
      solutionMd: q.solutionMd ?? null,
      sourceMd: q.sourceMd,
      version: 1,
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    })
    .run();
}

/** live 题行 + 同内容冻结快照卷（knowledge 空数组——无考点关联即同内容） */
function makeLivePaper(world: World): {
  attemptId: string;
  revisionId: string;
} {
  const snapshotJson = snapshotJsonOf({
    id: Q,
    stemMd: `计算 $(-3)+7-(-2)$ 的结果，填在括号里：[[${SENTINELS.answer}]]`,
    answers: { kind: "fill", blanks: [[SENTINELS.answer]] },
    solutionMd: SENTINELS.solution,
    hints: [SENTINELS.hint],
    knowledge: [],
  });
  insertLiveQuestionFromSnapshot(world, snapshotJson);
  const { attemptId, rowIds } = frozenDraftAttempt(
    world.db,
    world.studentId,
    [{ questionId: Q, snapshotJson, unitId: UNIT }],
    { attemptUnitId: UNIT },
  );
  return { attemptId, revisionId: rowIds[0] ?? "" };
}



describe("stale 判定真化（审查修复 4）", () => {
  it("题库当前行与冻结快照同内容 → stale=false（真化判定的基线）", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makeLivePaper(world);
    readyBase(world, attemptId, revisionId);
    const view = getAnnotationView(
      world.db,
      world.dataDir,
      { kind: "student", id: world.studentId },
      attemptId,
      Q,
    );
    expect(view.base?.stale).toBe(false);
  });

  it("教师编辑题库 → 回看不动旧 base（同 baseId/旧题面）且 stale=true（G-L2）", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makeLivePaper(world);
    const baseId = readyBase(world, attemptId, revisionId);
    // 教师改题库（建卷后行不重铸——只影响之后新建的卷；旧标注锚定旧题面）
    world.db
      .update(questionsTable)
      .set({ stemMd: "改版后的新题干（内容已变化）", version: 2 })
      .where(eq(questionsTable.id, Q))
      .run();
    const view = getAnnotationView(
      world.db,
      world.dataDir,
      { kind: "student", id: world.studentId },
      attemptId,
      Q,
    );
    expect(view.base?.baseId).toBe(baseId); // 不重建、不换底图
    expect(view.base?.stale).toBe(true);
    // 装配载荷同口径：旧 base 幂等复用 + stale 标记
    const preview = assembleAnnotationBase(
      world.db,
      world.studentId,
      attemptId,
      Q,
    );
    expect(preview.base.baseId).toBe(baseId);
    expect(preview.base.stale).toBe(true);
  });

  it("题目软删 → stale=true（圈画仍锚定旧题面，如实标注）", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makeLivePaper(world);
    readyBase(world, attemptId, revisionId);
    world.db
      .update(questionsTable)
      .set({ deletedAt: "2026-10-08T00:00:00.000Z" })
      .where(eq(questionsTable.id, Q))
      .run();
    const view = getAnnotationView(
      world.db,
      world.dataDir,
      { kind: "student", id: world.studentId },
      attemptId,
      Q,
    );
    expect(view.base?.stale).toBe(true);
  });

  it("题库无 live 行（防御态）→ 不指认改版（stale=false——横幅口径需要证据）", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId);
    const view = getAnnotationView(
      world.db,
      world.dataDir,
      { kind: "student", id: world.studentId },
      attemptId,
      Q,
    );
    expect(view.base?.stale).toBe(false);
  });
});

// ---------- assembleAnnotationPairs ----------

/** 该 attempt 的 responses 行（scope 组装用） */
function responseRowsOf(db: Db, attemptId: string) {
  return db
    .select()
    .from(responsesTable)
    .where(eq(responsesTable.attemptId, attemptId))
    .all();
}

describe("assembleAnnotationPairs：成对装配（导出/学习包共用）", () => {
  it("已封存标注出成对文件（base＋strokes）；draft 进行中不收录", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId);
    putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc(900, 2)),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    // draft 进行中（未交卷未封存）：不收录
    const open = assembleAnnotationPairs(world.db, world.dataDir, [
      { rows: responseRowsOf(world.db, attemptId) },
    ]);
    expect(open.pairs).toHaveLength(0);
    // 交卷后（审查修复 2：显式 seal 或装配入口懒补封）→ 成对收录
    submitAttemptStatus(world.db, attemptId);
    sealAttemptAnnotations(world.db, world.studentId, attemptId);
    const asm = assembleAnnotationPairs(world.db, world.dataDir, [
      { rows: responseRowsOf(world.db, attemptId) },
    ]);
    expect(asm.pairs).toHaveLength(1);
    const pair = asm.pairs[0];
    if (pair === undefined) throw new Error("缺少成对条目");
    expect(pair.ref).toBe("a001");
    expect(pair.phase).toBe("scratch");
    expect(pair.base).not.toBeNull();
    expect(pair.base?.bytes).toBe(basePng().byteLength);
    expect(pair.strokesJson).not.toBeNull();
    expect(JSON.parse(pair.strokesJson ?? "null")).toEqual(
      JSON.parse(canonicalAnnotationJson(annotationDoc(900, 2))),
    );
    expect(asm.byResponseRowId.get(revisionId)).toHaveLength(1);
    expect(pair.missingReason).toBeUndefined();
  });

  it("底图文件丢失：整体进缺失清单，绝不导出孤立的圈（strokesJson=null）", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    const baseId = readyBase(world, attemptId, revisionId);
    putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      {
        baseRevision: 0,
        mutationId: randomUUID(),
      },
    );
    submitAttemptStatus(world.db, attemptId);
    sealAttemptAnnotations(world.db, world.studentId, attemptId);
    // 删除底图文件（保留行——模拟磁盘丢失）
    const baseRow = world.db
      .select()
      .from(annotationBasesTable)
      .where(eq(annotationBasesTable.id, baseId))
      .get();
    if (baseRow?.imagePath === undefined || baseRow.imagePath === null) {
      throw new Error("测试前置失败：底图行缺路径");
    }
    rmSync(join(world.dataDir, baseRow.imagePath));
    const asm = assembleAnnotationPairs(world.db, world.dataDir, [
      { rows: responseRowsOf(world.db, attemptId) },
    ]);
    const pair = asm.pairs[0];
    if (pair === undefined) throw new Error("缺少成对条目");
    expect(pair.base).toBeNull();
    expect(pair.strokesJson).toBeNull();
    expect(pair.missingReason).toContain("底图");
    expect(asm.byResponseRowId.get(revisionId)).toHaveLength(1);
  });

  it("scratch 与已封存 correction 各占一条（独立编号）", () => {
    const world = makeWorld();
    const { attemptId, revisionId } = makePaper(world);
    readyBase(world, attemptId, revisionId);
    putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      {
        baseRevision: 0,
        mutationId: randomUUID(),
      },
    );
    submitAttemptStatus(world.db, attemptId);
    sealAttemptAnnotations(world.db, world.studentId, attemptId);
    // 订正另开
    readyBase(world, attemptId, revisionId, basePng(880), "correction");
    putAnnotationDoc(
      world.db,
      world.dataDir,
      world.studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc(880)),
      {
        baseRevision: 0,
        mutationId: randomUUID(),
        phase: "correction",
      },
    );
    sealAttemptAnnotations(world.db, world.studentId, attemptId, "correction");
    const asm = assembleAnnotationPairs(world.db, world.dataDir, [
      { rows: responseRowsOf(world.db, attemptId) },
    ]);
    expect(asm.pairs.map((pair) => pair.ref)).toEqual(["a001", "a002"]);
    expect(asm.pairs.map((pair) => pair.phase)).toEqual([
      "scratch",
      "correction",
    ]);
  });
});
