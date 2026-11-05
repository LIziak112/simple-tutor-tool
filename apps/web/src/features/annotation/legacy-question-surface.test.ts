import {
  type AnnotationBaseRef,
  type AnnotationSurfaceLayout,
  type AttemptQuestionPublic,
  annotationDocSchema,
  annotationSurfaceCompatibilitySchema,
  stableContentHash64,
} from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compatibleSurfaceEvidence,
  normalizeSurfaceFont,
} from "./annotation-layout-compatibility";
import type { AnnotationLocalRecord } from "./annotation-store";
import measuredFill from "./fixed-frame-fill-20261105.fixture.json";
import {
  type FrozenQuestionImageState,
  resolveFrozenQuestionSurface,
} from "./frozen-surface-resolver";
import {
  measureQuestionSurface,
  questionSurfaceMatchesLayout,
  verifiedLegacySurfaceCompatibility,
} from "./question-base-image";

const question: AttemptQuestionPublic = {
  id: "question-a",
  questionRevisionId: "11111111-1111-4111-8111-111111111111",
  type: "fill",
  stemMd: "公开题面 [[]]",
  difficulty: 1,
  knowledge: [],
  hintCount: 0,
};
const baseId = "22222222-2222-4222-8222-222222222222";
const otherBaseId = "33333333-3333-4333-8333-333333333333";
const layout: AnnotationSurfaceLayout = {
  renderVersion: 2,
  questionRevisionId: question.questionRevisionId,
  cssWidth: 300,
  cssHeight: 200,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
};
const compatibility = annotationSurfaceCompatibilitySchema.parse({
  version: 1,
  contentSignature: "a".repeat(64),
  blocks: [{ tag: "DIV", x: 0, y: 0, width: 300, height: 200 }],
  fonts: [["sans-serif", "16px", "400", "28px", "normal"]],
  textRects: [],
});
const formats: Array<{ name: string; layout: AnnotationSurfaceLayout }> = [
  { name: "v2 只有哈希", layout },
  { name: "v2 有 compatibility", layout: { ...layout, compatibility } },
  {
    name: "v3 有控件和 compatibility",
    layout: {
      ...layout,
      compatibility,
      renderVersion: 3,
      controls: [
        {
          slotId: "slot-1",
          kind: "text",
          x: 20,
          y: 30,
          width: 112,
          height: 44,
        },
      ],
    },
  },
];
// 本组只检验 resolver 门禁；浏览器的 PNG 解码结果由 image 参数注入。
const png = new Blob(["resolver-fixture"], { type: "image/png" });
const decodedLocal = {
  sourceUrl: "blob:local-fixture",
  decoded: {
    url: "blob:local-fixture",
    blob: png,
    width: 600,
    height: 400,
    failed: false,
  },
} satisfies FrozenQuestionImageState;
const missingImage: FrozenQuestionImageState = {
  sourceUrl: null,
  decoded: null,
};
function record(savedLayout = layout): AnnotationLocalRecord {
  return {
    localBase: { png, layout: savedLayout },
    doc: {
      version: 1,
      baseWidth: 600,
      baseHeight: 400,
      strokes: [
        {
          tool: "pen",
          color: "#dc2626",
          weight: 4,
          points: [{ x: 20, y: 30, p: 0.5, t: 0 }],
        },
      ],
    },
    pending: null,
    baseRevision: 0,
    annotationId: null,
    sealedAt: null,
    base: null,
    baseDisabledReason: null,
    conflict: null,
    retained: null,
    denied: null,
    local: "saved",
    localError: null,
    editedAt: 0,
    docVersion: 1,
  };
}
function cloudBase(savedLayout = layout): AnnotationBaseRef {
  return {
    baseId,
    state: "ready",
    stale: false,
    pixelWidth: 600,
    pixelHeight: 400,
    downloadUrl: "/fixture.png",
    layout: savedLayout,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("阶段 0：旧稿来源与 PNG 门禁现状", () => {
  it("v1 无 layout：有效尺寸和已解码 PNG 仍只能进入 legacy 只读分支", () => {
    const legacy: AnnotationLocalRecord = {
      ...record(),
      localBase: null,
      doc: { version: 1, baseWidth: 1440, baseHeight: 400, strokes: [] },
      base: {
        baseId,
        state: "ready",
        stale: false,
        pixelWidth: 1440,
        pixelHeight: 400,
        downloadUrl: "/legacy.png",
      },
    };
    expect(
      resolveFrozenQuestionSurface(
        legacy,
        {
          sourceUrl: "/legacy.png",
          decoded: {
            url: "/legacy.png",
            blob: null,
            width: 1440,
            height: 400,
            failed: false,
          },
        },
        false,
      ),
    ).toMatchObject({
      status: "legacy",
      source: null,
      readOnly: true,
      canReadInk: false,
      canWrite: false,
    });
  });

  it.each(formats)(
    "$name：未解码先 waiting，解码后 ready，与几何兼容无关",
    ({ layout: savedLayout }) => {
      const local = record(savedLayout);
      const before = JSON.stringify(local);
      expect(
        resolveFrozenQuestionSurface(local, missingImage, false),
      ).toMatchObject({
        status: "waiting",
        source: { kind: "local" },
        canReadInk: false,
        canWrite: false,
      });
      expect(
        resolveFrozenQuestionSurface(local, decodedLocal, false),
      ).toMatchObject({
        status: "ready",
        canReadInk: true,
        canWrite: true,
      });
      expect(JSON.stringify(local)).toBe(before);
      expect(local.localBase?.png).toBe(png);
    },
  );

  it("云端 ready 布局与正文齐全仍要求同 URL 的图片解码", () => {
    const cloud = { ...record(), localBase: null, base: cloudBase() };
    expect(
      resolveFrozenQuestionSurface(cloud, missingImage, false).status,
    ).toBe("waiting");
    expect(
      resolveFrozenQuestionSurface(
        cloud,
        {
          sourceUrl: "/fixture.png",
          decoded: {
            ...decodedLocal.decoded,
            url: "/fixture.png",
            blob: null,
          },
        },
        false,
      ).status,
    ).toBe("ready");
    expect(
      resolveFrozenQuestionSurface(
        cloud,
        {
          sourceUrl: "/fixture.png",
          decoded: { ...decodedLocal.decoded, url: "/old.png", blob: null },
        },
        false,
      ).status,
    ).toBe("waiting");
  });

  it.each(["pending", "conflict", "retained"] as const)(
    "%s：异云稿不能接管本机未同步的 PNG 与正文",
    (state) => {
      const local = record();
      local.base = {
        ...cloudBase({ ...layout, geometrySignature: "d".repeat(64) }),
        baseId: otherBaseId,
      };
      if (state === "pending")
        local.pending = {
          mutationId: "44444444-4444-4444-8444-444444444444",
          doc: local.doc,
        };
      if (state === "conflict")
        local.conflict = { kind: "layout", current: null, reason: "布局冲突" };
      if (state === "retained") local.retained = { reason: "保留本机稿" };
      const before = JSON.stringify(local);
      expect(
        resolveFrozenQuestionSurface(local, decodedLocal, false),
      ).toMatchObject({
        status: "ready",
        source: { kind: "local", blob: png, layout },
        canReadInk: true,
      });
      expect(JSON.stringify(local)).toBe(before);
    },
  );

  it("只有云端 pending 且无本机原稿时不能当作已恢复", () => {
    const local = record();
    local.localBase = null;
    local.base = {
      ...cloudBase(),
      state: "pending",
      pixelWidth: null,
      pixelHeight: null,
    };
    delete local.base.downloadUrl;
    expect(
      resolveFrozenQuestionSurface(local, missingImage, false),
    ).toMatchObject({
      status: "blocked",
      canReadInk: false,
      canWrite: false,
    });
  });

  it("封存与擦空墓碑仍可读取原域，封存不恢复写权", () => {
    const local = record();
    local.sealedAt = "2026-11-05T00:00:00Z";
    const erased = local.doc.strokes[0];
    if (!erased) throw new Error("夹具缺少待擦除笔画");
    local.doc = {
      ...local.doc,
      strokes: [],
      deleted: [
        {
          ...erased,
          id: "stroke-1",
          deletedAt: 1,
          deletedBy: "clear",
        },
      ],
    };
    expect(annotationDocSchema.safeParse(local.doc).success).toBe(true);
    expect(
      resolveFrozenQuestionSurface(local, decodedLocal, false),
    ).toMatchObject({
      status: "ready",
      readOnly: true,
      canReadInk: true,
      canWrite: false,
    });
    expect(local.doc.deleted).toHaveLength(1);
  });

  it("错 baseId、坏图、坏坐标和未知版本都保留记录并阻断", () => {
    const wrongBase = record();
    wrongBase.localBase = { png, layout, boundBaseId: otherBaseId };
    wrongBase.base = cloudBase();
    const invalidCases = [
      wrongBase,
      { ...record(), doc: { ...record().doc, baseWidth: 601 } },
      { ...record(), doc: null },
      {
        ...record(),
        localBase: { png: new Blob([], { type: "image/png" }), layout },
      },
      {
        ...record(),
        localBase: {
          png,
          layout: {
            ...layout,
            renderVersion: 99,
          } as unknown as AnnotationSurfaceLayout,
        },
      },
    ];
    for (const invalid of invalidCases) {
      const before = JSON.stringify(invalid);
      expect(
        resolveFrozenQuestionSurface(invalid, decodedLocal, false),
      ).toMatchObject({
        status: "blocked",
        canReadInk: false,
        canWrite: false,
      });
      expect(JSON.stringify(invalid)).toBe(before);
    }
    expect(
      resolveFrozenQuestionSurface(
        record(),
        {
          ...decodedLocal,
          decoded: { ...decodedLocal.decoded, failed: true },
        },
        false,
      ).status,
    ).toBe("blocked");
  });
});

describe("阶段 0：真实题面几何兼容现状", () => {
  it("现状：实测填空稿字体相同、26 个行框、最大边界差 2px，旧判定仍拒绝", () => {
    expect(measuredFill.desktop.fonts.map(normalizeSurfaceFont)).toEqual(
      measuredFill.ipad.fonts.map(normalizeSurfaceFont),
    );
    expect(measuredFill.desktop.textRects).toHaveLength(26);
    expect(measuredFill.ipad.textRects).toHaveLength(26);
    const maxEdgeDelta = Math.max(
      ...["blocks", "textRects"].flatMap((key) => {
        const left =
          key === "blocks"
            ? measuredFill.desktop.blocks
            : measuredFill.desktop.textRects;
        const right =
          key === "blocks"
            ? measuredFill.ipad.blocks
            : measuredFill.ipad.textRects;
        return left.flatMap((rect, index) => {
          const other = right[index];
          if (!other) throw new Error("实测夹具的对应区域缺失");
          return [
            Math.abs(rect.x - other.x),
            Math.abs(rect.y - other.y),
            Math.abs(rect.x + rect.width - other.x - other.width),
            Math.abs(rect.y + rect.height - other.y - other.height),
          ];
        });
      }),
    );
    expect(maxEdgeDelta).toBe(2);
    // 批准的 10px 标准应返回 true；阶段 0 仅刻画旧实现，需求 red 另存日志。
    expect(
      compatibleSurfaceEvidence(
        {
          ...measuredFill.desktop,
          fonts: measuredFill.desktop.fonts.map(normalizeSurfaceFont),
        },
        {
          ...measuredFill.ipad,
          fonts: measuredFill.ipad.fonts.map(normalizeSurfaceFont),
        },
      ),
    ).toBe(false);
  });

  it("只有哈希的 v2：原几何可命中，0.5px 改变后不能从哈希恢复旧边界", async () => {
    const surface = document.createElement("div");
    let height = 200;
    vi.spyOn(surface, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, 300, height),
    );
    const measure = measureQuestionSurface(surface);
    const saved: AnnotationSurfaceLayout = {
      ...layout,
      contentSignature: stableContentHash64({
        type: question.type,
        stemMd: question.stemMd,
        options: [],
      }),
      geometrySignature: stableContentHash64(measure.blocks),
      fontSignature: stableContentHash64(measure.fonts),
    };
    await expect(
      questionSurfaceMatchesLayout(question, surface, saved),
    ).resolves.toBe(true);
    await expect(
      verifiedLegacySurfaceCompatibility(question, surface, saved),
    ).resolves.toMatchObject({ blocks: measure.blocks });
    height = 199.5;
    await expect(
      questionSurfaceMatchesLayout(question, surface, saved),
    ).resolves.toBe(false);
    await expect(
      verifiedLegacySurfaceCompatibility(question, surface, saved),
    ).resolves.toBeNull();
  });

  it("相同几何但异题版本不能命中；resolver 自身并未收到当前题身份", async () => {
    const surface = document.createElement("div");
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 300, 200),
    );
    const measure = measureQuestionSurface(surface);
    const saved = {
      ...layout,
      compatibility: {
        ...compatibility,
        contentSignature: stableContentHash64({
          type: question.type,
          stemMd: question.stemMd,
          options: [],
        }),
        blocks: measure.blocks,
        fonts: measure.fonts,
      },
    };
    await expect(
      questionSurfaceMatchesLayout(
        { ...question, questionRevisionId: "other-revision" },
        surface,
        saved,
      ),
    ).resolves.toBe(false);
    expect(
      resolveFrozenQuestionSurface(
        record({
          ...layout,
          questionRevisionId: "44444444-4444-4444-8444-444444444444",
        }),
        decodedLocal,
        false,
      ).status,
    ).toBe("ready");
  });
});
