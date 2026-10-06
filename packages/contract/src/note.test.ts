import { describe, expect, it } from "vitest";
import { INK_LOGICAL_WIDTH } from "./ink.ts";
import {
  NOTE_BODY_DECOMPRESSED_MAX_BYTES,
  NOTE_BODY_GZIP_MAX_BYTES,
  NOTE_COORD_MAX_X,
  NOTE_COORD_MAX_Y,
  NOTE_IMAGE_MAX_PIXEL_DIM,
  NOTE_IMAGE_PNG_MAX_BYTES,
  NOTE_MAX_POINTS_PER_STROKE,
  NOTE_MAX_TOTAL_POINTS,
  NOTE_PAPER_HEIGHT_DEFAULT,
  NOTE_PAPER_HEIGHT_MAX,
  NOTE_VERSION_IMAGES_MAX_BYTES,
  noteBodyHashSchema,
  noteDocSchema,
  noteErrorCodeSchema,
  noteHeadDataSchema,
  noteImageMetaSchema,
  noteImageUploadMetaSchema,
  noteIssueIsLimit,
  noteLocalBodyStateSchema,
  notePhaseSchema,
  noteRecordMetaSchema,
  noteServerBodyStateSchema,
  noteStatusOverviewSchema,
  noteSubmissionEvidenceMetaSchema,
  noteSubmissionEvidenceStateSchema,
  noteUploadMetaSchema,
  noteVersionMetaSchema,
  noteVersionReceiptSchema,
} from "./note.ts";

/**
 * 题目草稿契约自测（T6R.2）：锁定 NoteDoc v1 形状、四类正交状态、上传协议、
 * 元信息形状与限额常量。对照派单失败测试清单：
 * 空稿合法；默认背景／高度缺省合法；version≠1 拒绝；负值／超界／非有限坐标拒绝；
 * 点数／每笔点数超限拒绝；错误状态组合拒绝；非法 questionRevisionId 拒绝；
 * 新旧 InkDoc（无 paperHeightLogical/background 的旧形状）读入往返兼容。
 */

const P0 = { x: 100, y: 200, p: 0.5, t: 0 };

/** 最小合法 NoteDoc（显式全部字段） */
const FULL_DOC = {
  version: 1,
  ink: {
    width: INK_LOGICAL_WIDTH,
    strokes: [
      {
        tool: "pen",
        color: "#1f2328",
        weight: 4,
        points: [P0, { x: 120, y: 1240, p: 0.8, t: 30 }],
      },
    ],
  },
  paperHeightLogical: 1200,
  background: "line",
} as const;

/** NoteVersionMeta 夹具工厂（两处元信息用例共享，差异字段 spread 覆盖） */
const versionMeta = (
  o: Partial<{
    versionId: string;
    noteId: string;
    revision: number;
    hash: string;
    strokeCount: number;
    pointCount: number;
    paperWidth: number;
    paperHeight: number;
    serverSavedAt: string;
    renderVersion: number;
  }> = {},
) => ({
  versionId: "44444444-4444-4444-8444-444444444444",
  noteId: "33333333-3333-4333-8333-333333333333",
  revision: 1,
  hash: "a".repeat(64),
  strokeCount: 1,
  pointCount: 10,
  paperWidth: INK_LOGICAL_WIDTH,
  paperHeight: 800,
  serverSavedAt: "2026-10-06T02:00:00.000Z",
  renderVersion: 1,
  ...o,
});

describe("noteDocSchema：基本形状", () => {
  it("接受显式全字段的合法文档（y>1000 合法：纸张向下延伸）", () => {
    const parsed = noteDocSchema.parse(FULL_DOC);
    expect(parsed.paperHeightLogical).toBe(1200);
    expect(parsed.background).toBe("line");
  });

  it("空稿（0 笔）合法；缺省高度/背景宽容解析为默认值（800/grid）", () => {
    // 旧 InkDoc 的 atrament data 直接读入：不带 paperHeightLogical/background
    const legacy = {
      version: 1,
      ink: { width: INK_LOGICAL_WIDTH, strokes: [] },
    };
    const parsed = noteDocSchema.parse(legacy);
    expect(parsed.paperHeightLogical).toBe(NOTE_PAPER_HEIGHT_DEFAULT);
    expect(parsed.background).toBe("grid");
    expect(parsed.ink.strokes).toHaveLength(0);
  });

  it("旧形状读入往返兼容：补默认值后序列化再解析结果稳定", () => {
    const legacy = {
      version: 1,
      ink: {
        width: INK_LOGICAL_WIDTH,
        strokes: [
          {
            tool: "highlighter",
            color: "rgba(250, 204, 21, 0.45)",
            weight: 16,
            // 旧答题区笔迹常见 y>1000，读入草稿不得拒绝（≤3000 即可）
            points: [{ x: 0, y: 1240, p: 0.5, t: 0 }],
          },
        ],
      },
    };
    const once = noteDocSchema.parse(legacy);
    const twice = noteDocSchema.parse(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });

  it("version≠1 / 缺 version / 缺 ink 拒绝", () => {
    expect(noteDocSchema.safeParse({ ...FULL_DOC, version: 2 }).success).toBe(
      false,
    );
    const { version: _v, ...noVersion } = FULL_DOC;
    expect(noteDocSchema.safeParse(noVersion).success).toBe(false);
    const { ink: _i, ...noInk } = FULL_DOC;
    expect(noteDocSchema.safeParse(noInk).success).toBe(false);
  });

  it("paperHeightLogical 超上限/非正/非整数/非有限数拒绝；上限值本身合法", () => {
    expect(
      noteDocSchema.safeParse({
        ...FULL_DOC,
        paperHeightLogical: NOTE_PAPER_HEIGHT_MAX + 1,
      }).success,
    ).toBe(false);
    expect(
      noteDocSchema.safeParse({ ...FULL_DOC, paperHeightLogical: 0 }).success,
    ).toBe(false);
    expect(
      noteDocSchema.safeParse({ ...FULL_DOC, paperHeightLogical: 800.5 })
        .success,
    ).toBe(false);
    expect(
      noteDocSchema.safeParse({
        ...FULL_DOC,
        paperHeightLogical: Number.POSITIVE_INFINITY,
      }).success,
    ).toBe(false);
    expect(
      noteDocSchema.safeParse({
        ...FULL_DOC,
        paperHeightLogical: Number.NaN,
      }).success,
    ).toBe(false);
    expect(
      noteDocSchema.safeParse({
        ...FULL_DOC,
        paperHeightLogical: NOTE_PAPER_HEIGHT_MAX,
      }).success,
    ).toBe(true);
  });

  it("background 只接受 white/grid/line；缺省默认 grid", () => {
    expect(
      noteDocSchema.safeParse({ ...FULL_DOC, background: "dotted" }).success,
    ).toBe(false);
    expect(noteDocSchema.parse(FULL_DOC).background).toBe("line");
  });
});

describe("noteDocSchema：坐标与点数限额（暂定值，真机定标后修订）", () => {
  function docWithPoints(
    points: Array<{ x: number; y: number; p?: number; t?: number }>,
  ) {
    return {
      version: 1,
      ink: {
        width: INK_LOGICAL_WIDTH,
        strokes: [
          {
            tool: "pen",
            color: "#000",
            weight: 4,
            points: points.map((pt) => ({
              x: pt.x,
              y: pt.y,
              p: pt.p ?? 0.5,
              t: pt.t ?? 0,
            })),
          },
        ],
      },
    };
  }

  it("负值坐标拒绝（x/y 各一）", () => {
    expect(
      noteDocSchema.safeParse(docWithPoints([{ x: -1, y: 10 }])).success,
    ).toBe(false);
    expect(
      noteDocSchema.safeParse(docWithPoints([{ x: 10, y: -0.5 }])).success,
    ).toBe(false);
  });

  it("超界坐标拒绝（x>1000 / y>3000）；边界值 x=1000、y=3000 合法", () => {
    expect(
      noteDocSchema.safeParse(docWithPoints([{ x: 1000.5, y: 10 }])).success,
    ).toBe(false);
    expect(
      noteDocSchema.safeParse(docWithPoints([{ x: 10, y: 3000.5 }])).success,
    ).toBe(false);
    expect(
      noteDocSchema.safeParse(
        docWithPoints([{ x: NOTE_COORD_MAX_X, y: NOTE_COORD_MAX_Y }]),
      ).success,
    ).toBe(true);
  });

  it("非有限坐标拒绝（Infinity/NaN，含伪装在数组深处的）", () => {
    expect(
      noteDocSchema.safeParse(
        docWithPoints([
          { x: 100, y: 100 },
          { x: Number.POSITIVE_INFINITY, y: 100 },
        ]),
      ).success,
    ).toBe(false);
    expect(
      noteDocSchema.safeParse(
        docWithPoints([
          { x: 100, y: 100 },
          { x: Number.NaN, y: 100 },
        ]),
      ).success,
    ).toBe(false);
  });

  it("单笔点数超上限拒绝；恰好等于上限合法；限额 issue 携带结构标记 params.limit", () => {
    // p/t 缺省走 docWithPoints 默认分支（0.5/0）
    const exact = Array.from({ length: NOTE_MAX_POINTS_PER_STROKE }, () => ({
      x: 1,
      y: 1,
    }));
    const over = [...exact, { x: 1, y: 1, p: 0.5, t: 0 }];
    expect(noteDocSchema.safeParse(docWithPoints(over)).success).toBe(false);
    expect(noteDocSchema.safeParse(docWithPoints(exact)).success).toBe(true);
    // T6R.4：限额类 issue 带 params.limit===true（服务端 413/400 分级依据，
    // 契约锁定——措辞可改、标记不可丢）
    const overResult = noteDocSchema.safeParse(docWithPoints(over));
    expect(overResult.success).toBe(false);
    if (!overResult.success) {
      expect(overResult.error.issues.length).toBeGreaterThan(0);
      expect(overResult.error.issues.some(noteIssueIsLimit)).toBe(true);
    }
    // 对照：坐标越界（形状类）不带限额标记
    const shapeResult = noteDocSchema.safeParse(
      docWithPoints([{ x: -1, y: 1 }]),
    );
    expect(shapeResult.success).toBe(false);
    if (!shapeResult.success) {
      expect(shapeResult.error.issues.length).toBeGreaterThan(0);
      expect(shapeResult.error.issues.some(noteIssueIsLimit)).toBe(false);
    }
  });

  it("限额联动：NOTE_COORD_MAX_Y 与 NOTE_PAPER_HEIGHT_MAX 同源相等（防漂移）", () => {
    expect(NOTE_COORD_MAX_Y).toBe(NOTE_PAPER_HEIGHT_MAX);
  });

  it("全稿总点数超上限拒绝（多笔累计口径）；总量 issue 同样携带 params.limit", () => {
    // 151 笔 × 2000 点 = 302000 > 300000：单笔均不超限，靠总量拦截。
    // 151 份笔画共享同一份只读点数组（safeParse 不改写输入；点带全 p/t——
    // 缺 p/t 会先被基础 schema 拒，走不到 superRefine 的总量检查）
    const pts = Array.from({ length: NOTE_MAX_POINTS_PER_STROKE }, () => ({
      x: 1,
      y: 1,
      p: 0.5,
      t: 0,
    }));
    const strokes = Array.from({ length: 151 }, () => ({
      tool: "pen",
      color: "#000",
      weight: 4,
      points: pts,
    }));
    const result = noteDocSchema.safeParse({
      version: 1,
      ink: { width: INK_LOGICAL_WIDTH, strokes },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(noteIssueIsLimit)).toBe(true);
    }
  });
});

describe("四类正交状态", () => {
  it("本地正文状态值域：saving/saved/failed；混入其他维度字面量拒绝", () => {
    for (const v of ["saving", "saved", "failed"] as const) {
      expect(noteLocalBodyStateSchema.parse(v)).toBe(v);
    }
    expect(noteLocalBodyStateSchema.safeParse("synced").success).toBe(false);
    expect(noteLocalBodyStateSchema.safeParse("ready").success).toBe(false);
  });

  it("服务端正文状态值域：dirty/uploading/synced/conflict/denied", () => {
    for (const v of [
      "dirty",
      "uploading",
      "synced",
      "conflict",
      "denied",
    ] as const) {
      expect(noteServerBodyStateSchema.parse(v)).toBe(v);
    }
    expect(noteServerBodyStateSchema.safeParse("saved").success).toBe(false);
    expect(noteServerBodyStateSchema.safeParse("frozen").success).toBe(false);
  });

  it("提交证据状态值域：none/frozen/missing/legacy_unverified", () => {
    for (const v of [
      "none",
      "frozen",
      "missing",
      "legacy_unverified",
    ] as const) {
      expect(noteSubmissionEvidenceStateSchema.parse(v)).toBe(v);
    }
    expect(noteSubmissionEvidenceStateSchema.safeParse("saved").success).toBe(
      false,
    );
    expect(
      noteSubmissionEvidenceStateSchema.safeParse("unverified").success,
    ).toBe(false);
  });

  it("四维总览：合法组合通过，任一维度混进非法字面量整体拒绝", () => {
    const ok = {
      local: "saved",
      server: "synced",
      images: "ready",
      evidence: "frozen",
    };
    expect(noteStatusOverviewSchema.parse(ok)).toEqual(ok);
    expect(
      noteStatusOverviewSchema.safeParse({ ...ok, local: "synced" }).success,
    ).toBe(false);
    expect(
      noteStatusOverviewSchema.safeParse({ ...ok, server: "saved" }).success,
    ).toBe(false);
    expect(
      noteStatusOverviewSchema.safeParse({ ...ok, images: "dirty" }).success,
    ).toBe(false);
    expect(
      noteStatusOverviewSchema.safeParse({ ...ok, evidence: "ready" }).success,
    ).toBe(false);
  });
});

describe("phase 值域（首版只放行 scratch 的约束在服务层，契约三值齐全）", () => {
  it("scratch/correction/supplement 全部合法；original 不是 phase（是证据角色）", () => {
    for (const v of ["scratch", "correction", "supplement"] as const) {
      expect(notePhaseSchema.parse(v)).toBe(v);
    }
    expect(notePhaseSchema.safeParse("original").success).toBe(false);
  });
});

describe("元信息形状", () => {
  const RECORD = {
    noteId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    questionId: "练习四-7",
    questionRevisionId: "33333333-3333-4333-8333-333333333333",
    phase: "scratch",
    revision: 3,
    currentVersionId: "44444444-4444-4444-8444-444444444444",
    serverSavedAt: "2026-10-06T02:00:00.000Z",
  };

  it("NoteRecord 元信息：合法行通过；revision 与版本指针一致性校验", () => {
    expect(noteRecordMetaSchema.parse(RECORD).revision).toBe(3);
    // revision=0（建行未同步）⇒ 指针与时间都必须为 null
    expect(
      noteRecordMetaSchema.safeParse({ ...RECORD, revision: 0 }).success,
    ).toBe(false);
    expect(
      noteRecordMetaSchema.safeParse({
        ...RECORD,
        revision: 0,
        currentVersionId: null,
        serverSavedAt: null,
      }).success,
    ).toBe(true);
    // revision≥1 但缺版本指针 ⇒ 拒绝
    expect(
      noteRecordMetaSchema.safeParse({ ...RECORD, currentVersionId: null })
        .success,
    ).toBe(false);
    expect(
      noteRecordMetaSchema.safeParse({ ...RECORD, serverSavedAt: null })
        .success,
    ).toBe(false);
  });

  it("非法 questionRevisionId（空串/纯空白/超长）拒绝", () => {
    expect(
      noteRecordMetaSchema.safeParse({ ...RECORD, questionRevisionId: "" })
        .success,
    ).toBe(false);
    expect(
      noteRecordMetaSchema.safeParse({ ...RECORD, questionRevisionId: "  " })
        .success,
    ).toBe(false);
    expect(
      noteRecordMetaSchema.safeParse({
        ...RECORD,
        questionRevisionId: `x-${"a".repeat(512)}`,
      }).success,
    ).toBe(false);
    // 非空、含内部空格的复合串合法（具体铸造规则由 T6R.3 定）
    expect(
      noteRecordMetaSchema.safeParse({
        ...RECORD,
        questionRevisionId: "练习四-7 @ v3 @ snap",
      }).success,
    ).toBe(true);
  });

  it("paperWidth 恒等于 INK_LOGICAL_WIDTH（literal 锚定，错值拒绝）", () => {
    const version = versionMeta();
    expect(noteVersionMetaSchema.parse(version).paperWidth).toBe(
      INK_LOGICAL_WIDTH,
    );
    expect(
      noteVersionMetaSchema.safeParse({ ...version, paperWidth: 999 }).success,
    ).toBe(false);
  });

  it("NoteVersion 元信息：字段齐全通过；hash 非 64 位 hex 拒绝", () => {
    const version = versionMeta({
      noteId: RECORD.noteId,
      revision: 3,
      strokeCount: 12,
      pointCount: 2400,
      paperHeight: 1200,
    });
    expect(noteVersionMetaSchema.parse(version).revision).toBe(3);
    expect(
      noteVersionMetaSchema.safeParse({ ...version, hash: "zz" }).success,
    ).toBe(false);
    expect(
      noteVersionMetaSchema.safeParse({ ...version, hash: "A".repeat(64) })
        .success,
    ).toBe(false);
    expect(
      noteVersionMetaSchema.safeParse({ ...version, revision: 0 }).success,
    ).toBe(false);
  });

  it("NoteImage 元信息：规格/裁剪区/状态合法；ready 与 hash 一致性校验", () => {
    const image = {
      imageId: "55555555-5555-4555-8555-555555555555",
      noteVersionId: "44444444-4444-4444-8444-444444444444",
      spec: "analysis",
      pageIndex: 2,
      crop: { x: 0, y: 800, width: 1000, height: 760 },
      pixelWidth: 1000,
      pixelHeight: 760,
      state: "ready",
      hash: "b".repeat(64),
    };
    expect(noteImageMetaSchema.parse(image).pageIndex).toBe(2);
    // ready 必须有文件 hash
    expect(
      noteImageMetaSchema.safeParse({ ...image, hash: null }).success,
    ).toBe(false);
    // 非 ready 状态不得携带 hash
    expect(
      noteImageMetaSchema.safeParse({ ...image, state: "pending" }).success,
    ).toBe(false);
    expect(
      noteImageMetaSchema.safeParse({ ...image, state: "pending", hash: null })
        .success,
    ).toBe(true);
    // 未知规格 / 裁剪区越界（x+width>1000、y+height>3000）拒绝
    expect(
      noteImageMetaSchema.safeParse({ ...image, spec: "poster" }).success,
    ).toBe(false);
    expect(
      noteImageMetaSchema.safeParse({
        ...image,
        crop: { x: 100, y: 0, width: 1000, height: 100 },
      }).success,
    ).toBe(false);
    expect(
      noteImageMetaSchema.safeParse({
        ...image,
        crop: { x: 0, y: 2300, width: 100, height: 800 },
      }).success,
    ).toBe(false);
  });

  it("提交证据元信息：frozen 必须指向版本，其余状态不得携带版本引用", () => {
    const frozen = {
      attemptId: "22222222-2222-4222-8222-222222222222",
      questionId: "练习四-7",
      state: "frozen",
      versionId: "44444444-4444-4444-8444-444444444444",
      recordedAt: "2026-10-06T03:00:00.000Z",
    };
    expect(noteSubmissionEvidenceMetaSchema.parse(frozen).state).toBe("frozen");
    // frozen 缺版本引用 ⇒ 拒绝
    expect(
      noteSubmissionEvidenceMetaSchema.safeParse({
        ...frozen,
        versionId: null,
      }).success,
    ).toBe(false);
    // none / missing / legacy_unverified 均不得携带版本引用
    for (const state of ["none", "missing", "legacy_unverified"] as const) {
      expect(
        noteSubmissionEvidenceMetaSchema.safeParse({ ...frozen, state })
          .success,
      ).toBe(false);
      expect(
        noteSubmissionEvidenceMetaSchema.safeParse({
          ...frozen,
          state,
          versionId: null,
        }).success,
      ).toBe(true);
    }
  });
});

describe("上传协议（CAS + 幂等）", () => {
  it("baseRevision ≥0 整数、mutationId 为 uuid；违例拒绝", () => {
    expect(
      noteUploadMetaSchema.parse({
        baseRevision: 0,
        mutationId: "66666666-6666-4666-8666-666666666666",
      }).baseRevision,
    ).toBe(0);
    expect(
      noteUploadMetaSchema.safeParse({
        baseRevision: -1,
        mutationId: "66666666-6666-4666-8666-666666666666",
      }).success,
    ).toBe(false);
    expect(
      noteUploadMetaSchema.safeParse({
        baseRevision: 1.5,
        mutationId: "66666666-6666-4666-8666-666666666666",
      }).success,
    ).toBe(false);
    expect(
      noteUploadMetaSchema.safeParse({
        baseRevision: 0,
        mutationId: "not-uuid",
      }).success,
    ).toBe(false);
    expect(
      noteUploadMetaSchema.safeParse({
        baseRevision: 1_000_001,
        mutationId: "66666666-6666-4666-8666-666666666666",
      }).success,
    ).toBe(false);
  });

  it("服务端回执：revision≥1、hash 为 64 位 hex、savedAt 非空", () => {
    const receipt = {
      noteId: "11111111-1111-4111-8111-111111111111",
      revision: 1,
      versionId: "44444444-4444-4444-8444-444444444444",
      hash: "c".repeat(64),
      savedAt: "2026-10-06T02:00:00.000Z",
    };
    expect(noteVersionReceiptSchema.parse(receipt).revision).toBe(1);
    expect(
      noteVersionReceiptSchema.safeParse({ ...receipt, revision: 0 }).success,
    ).toBe(false);
    expect(
      noteVersionReceiptSchema.safeParse({ ...receipt, savedAt: "" }).success,
    ).toBe(false);
  });

  it("正文 hash 形状：64 位小写 hex", () => {
    expect(noteBodyHashSchema.parse("0123456789abcdef".repeat(4))).toHaveLength(
      64,
    );
    expect(
      noteBodyHashSchema.safeParse("0123456789ABCDEF".repeat(4)).success,
    ).toBe(false);
  });
});

describe("错误码与限额常量", () => {
  it("note 错误码集合（UPPER_SNAKE，与 attempt/ink 模块同风格）", () => {
    for (const code of [
      "NOTE_NOT_FOUND",
      "NOTE_VALIDATION_FAILED",
      "NOTE_LIMIT_EXCEEDED",
      "NOTE_REVISION_CONFLICT",
      "NOTE_MUTATION_MISMATCH",
    ] as const) {
      expect(noteErrorCodeSchema.parse(code)).toBe(code);
    }
    expect(noteErrorCodeSchema.safeParse("NOTE_MISSING").success).toBe(false);
    expect(
      noteErrorCodeSchema.safeParse("note_revision_conflict").success,
    ).toBe(false);
  });

  it("限额常量锁定暂定值（真机定标后修订须改这里与注释）", () => {
    expect(NOTE_BODY_GZIP_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(NOTE_BODY_DECOMPRESSED_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(NOTE_MAX_TOTAL_POINTS).toBe(300_000);
    expect(NOTE_MAX_POINTS_PER_STROKE).toBe(2000);
    expect(NOTE_COORD_MAX_X).toBe(1000);
    expect(NOTE_COORD_MAX_Y).toBe(3000);
    expect(NOTE_PAPER_HEIGHT_DEFAULT).toBe(800);
    expect(NOTE_PAPER_HEIGHT_MAX).toBe(3000);
  });
});

// ---------- T6R.5：读/图路由的响应与请求形状 ----------

describe("T6R.5 路由形状：noteHeadData / noteImageUploadMeta", () => {
  /** 最小合法 noteImageMeta（head 投影 images 数组元素） */
  const imageMeta = (o: Partial<{ imageId: string; state: "ready" | "pending"; hash: string | null }> = {}) => ({
    imageId: "55555555-5555-4555-8555-555555555555",
    noteVersionId: "44444444-4444-4444-8444-444444444444",
    spec: "analysis",
    pageIndex: 0,
    crop: { x: 0, y: 0, width: 1000, height: 800 },
    pixelWidth: 1000,
    pixelHeight: 800,
    state: "ready",
    hash: "b".repeat(64),
    ...o,
  });

  it("空态（notCreated）：note=null + images=[] + evidence=null 合法——显式空态标记", () => {
    const parsed = noteHeadDataSchema.parse({
      note: null,
      images: [],
      evidence: null,
    });
    expect(parsed.note).toBeNull();
    expect(parsed.evidence).toBeNull();
  });

  it("完整头投影合法：note + 该版本派生图 + 交卷证据", () => {
    const parsed = noteHeadDataSchema.parse({
      note: {
        noteId: "33333333-3333-4333-8333-333333333333",
        attemptId: "22222222-2222-4222-8222-222222222222",
        questionId: "p4-q7",
        questionRevisionId: "resp-1",
        phase: "scratch",
        revision: 2,
        currentVersionId: "44444444-4444-4444-8444-444444444444",
        serverSavedAt: "2026-10-06T02:00:00.000Z",
      },
      images: [imageMeta(), imageMeta({ imageId: "66666666-6666-4666-8666-666666666666", pageIndex: 1 })],
      evidence: {
        attemptId: "22222222-2222-4222-8222-222222222222",
        questionId: "p4-q7",
        state: "frozen",
        versionId: "44444444-4444-4444-8444-444444444444",
        recordedAt: "2026-10-06T03:00:00.000Z",
      },
    });
    expect(parsed.images).toHaveLength(2);
    expect(parsed.evidence?.state).toBe("frozen");
  });

  it("note 非空时形状仍受 noteRecordMeta 约束（revision=0 带版本 id 拒绝）", () => {
    expect(
      noteHeadDataSchema.safeParse({
        note: {
          noteId: "33333333-3333-4333-8333-333333333333",
          attemptId: "22222222-2222-4222-8222-222222222222",
          questionId: "p4-q7",
          questionRevisionId: "resp-1",
          phase: "scratch",
          revision: 0,
          currentVersionId: "44444444-4444-4444-8444-444444444444",
          serverSavedAt: "2026-10-06T02:00:00.000Z",
        },
        images: [],
        evidence: null,
      }).success,
    ).toBe(false);
  });

  it("补图上传元信息：合法形状通过；crop 越硬上限 / 像素维超上限 / 非整数拒绝", () => {
    const valid = {
      spec: "thumbnail",
      pageIndex: 0,
      crop: { x: 0, y: 760, width: 1000, height: 40 },
      pixelWidth: 500,
      pixelHeight: 20,
    };
    expect(noteImageUploadMetaSchema.parse(valid).spec).toBe("thumbnail");
    // crop 越硬上限（y+height>3000）
    expect(
      noteImageUploadMetaSchema.safeParse({
        ...valid,
        crop: { x: 0, y: 0, width: 1000, height: 3001 },
      }).success,
    ).toBe(false);
    // 像素维超防御上限
    expect(
      noteImageUploadMetaSchema.safeParse({
        ...valid,
        pixelWidth: NOTE_IMAGE_MAX_PIXEL_DIM + 1,
      }).success,
    ).toBe(false);
    // 非整数 / 负 pageIndex / 未知 spec
    expect(
      noteImageUploadMetaSchema.safeParse({ ...valid, pageIndex: 1.5 }).success,
    ).toBe(false);
    expect(
      noteImageUploadMetaSchema.safeParse({ ...valid, pageIndex: -1 }).success,
    ).toBe(false);
    expect(
      noteImageUploadMetaSchema.safeParse({ ...valid, spec: "huge" }).success,
    ).toBe(false);
  });

  it("图片限额常量锁定暂定值（真机定标后修订须改这里与注释）", () => {
    expect(NOTE_IMAGE_PNG_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(NOTE_VERSION_IMAGES_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(NOTE_IMAGE_MAX_PIXEL_DIM).toBe(4096);
  });
});
