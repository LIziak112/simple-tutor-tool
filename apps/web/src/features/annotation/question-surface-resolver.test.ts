import type { AnnotationSurfaceLayout } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  type AnnotationLocalRecord,
  getAnnotationView,
  installAnnotationBackend,
  memoryAnnotationBackend,
  resetAnnotationStoreForTest,
  writeLocalAnnotationBase,
} from "./annotation-store";
import { resolveQuestionSurface } from "./question-surface-resolver";

const revision = "11111111-1111-4111-8111-111111111111";
const baseId = "22222222-2222-4222-8222-222222222222";
const layout: AnnotationSurfaceLayout = {
  renderVersion: 4,
  renderProfile: "whole-question-v1",
  questionRevisionId: revision,
  cssWidth: 300,
  cssHeight: 200,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
  compatibility: {
    version: 1,
    contentSignature: "a".repeat(64),
    blocks: [{ tag: "DIV", node: "root", x: 0, y: 0, width: 300, height: 200 }],
    fonts: [["sans-serif", "16px", "400", "28px", "normal"]],
    textRects: [],
  },
};
function record(): AnnotationLocalRecord {
  return {
    localBase: {
      png: new Blob([], { type: "image/png" }),
      layout,
      boundBaseId: baseId,
    },
    doc: { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
    base: {
      baseId,
      state: "ready",
      stale: false,
      pixelWidth: 600,
      pixelHeight: 400,
      layout,
    },
    pending: null,
    baseRevision: 0,
    annotationId: null,
    sealedAt: null,
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

describe("真实题面原位来源判定", () => {
  it("消费实际公开视图：无 pending 字段不误判待传，pendingMutationId 缺本机布局须阻断", async () => {
    resetAnnotationStoreForTest();
    installAnnotationBackend(memoryAnnotationBackend());
    const session = { origin: "https://test.example", studentId: "student" };
    const scope = {
      attemptId: "attempt",
      questionId: "q",
      phase: "scratch" as const,
    };
    const local = record();
    if (!local.localBase) throw new Error("缺少夹具");
    await writeLocalAnnotationBase(
      session,
      scope,
      { ...local.localBase, png: new Blob(["png"], { type: "image/png" }) },
      local.doc,
    );
    const view = getAnnotationView(session, scope);
    if (!view) throw new Error("视图未读取");
    expect(
      resolveQuestionSurface(
        { ...view, localBase: null, base: local.base },
        revision,
      ).status,
    ).toBe("metadata-ready");
    expect(
      resolveQuestionSurface(
        {
          ...view,
          localBase: null,
          base: local.base,
          pendingMutationId: "pending",
        },
        revision,
      ).status,
    ).toBe("blocked");
    expect(
      resolveQuestionSurface(
        { ...view, pendingMutationId: "pending" },
        revision,
      ).source?.kind,
    ).toBe("local");
  });
  it("元数据和正文恢复独立于 PNG 存在/解码，尚未准入几何或开笔", () => {
    const local = record();
    expect(resolveQuestionSurface(local, revision)).toMatchObject({
      status: "metadata-ready",
      geometry: "unverified",
      source: { kind: "local", baseId, pixelWidth: 600, pixelHeight: 400 },
      readOnly: false,
    });
    expect(
      resolveQuestionSurface({ ...local, localBase: null }, revision),
    ).toMatchObject({ status: "metadata-ready", source: { kind: "cloud" } });
    expect(resolveQuestionSurface(null, revision).status).toBe("none");
    if (!local.base) throw new Error("缺少底图夹具");
    expect(
      resolveQuestionSurface(
        { ...local, base: { ...local.base, stale: true } },
        revision,
      ).status,
    ).toBe("metadata-ready");
    expect(
      resolveQuestionSurface(
        { ...local, localBase: null, base: null },
        revision,
      ).status,
    ).toBe("blocked");
  });
  it("只读不旁路异题、错底图、布局与正文坐标域保护", () => {
    const local = record();
    const invalid = [
      {
        ...local,
        localBase: {
          ...local.localBase,
          layout: { ...layout, questionRevisionId: "other" },
        },
      },
      {
        ...local,
        localBase: {
          ...local.localBase,
          png: new Blob(),
          layout,
          boundBaseId: "33333333-3333-4333-8333-333333333333",
        },
      },
      { ...local, doc: { ...local.doc, baseWidth: 601 } },
      {
        ...local,
        base: {
          ...local.base,
          baseId,
          state: "ready",
          stale: false,
          pixelWidth: 600,
          pixelHeight: 400,
          layout: { ...layout, geometrySignature: "d".repeat(64) },
        },
      },
    ];
    for (const broken of invalid) {
      const before = JSON.stringify(broken);
      expect(
        resolveQuestionSurface(broken as AnnotationLocalRecord, revision, true)
          .status,
      ).toBe("blocked");
      expect(JSON.stringify(broken)).toBe(before);
    }
    expect(resolveQuestionSurface(local, "other", true).reason).toContain(
      "题目版本",
    );
  });
  it("pending、冲突和保留本机始终选本机基准，不拿云端去配本机正文", () => {
    for (const state of [
      { pending: { mutationId: "mutation", doc: record().doc } },
      {
        conflict: { kind: "layout" as const, reason: "待裁决", current: null },
      },
      { retained: { reason: "保留本机" } },
    ]) {
      const local = {
        ...record(),
        ...state,
        base: {
          ...record().base,
          baseId: "33333333-3333-4333-8333-333333333333",
          state: "ready" as const,
          stale: false,
          pixelWidth: 600,
          pixelHeight: 400,
          layout: { ...layout, geometrySignature: "d".repeat(64) },
        },
      };
      const before = JSON.stringify(local);
      expect(resolveQuestionSurface(local, revision)).toMatchObject({
        status: "metadata-ready",
        source: { kind: "local", baseId },
      });
      expect(JSON.stringify(local)).toBe(before);
    }
    expect(
      resolveQuestionSurface(
        {
          ...record(),
          localBase: null,
          pending: { mutationId: "mutation", doc: record().doc },
        },
        revision,
      ).status,
    ).toBe("blocked");
  });
  it("封存事实和外部锁定只读，未知/坏协议及 v1 无位置证据明确保稿", () => {
    expect(
      resolveQuestionSurface({ ...record(), sealedAt: "2026-11-05" }, revision)
        .readOnly,
    ).toBe(true);
    expect(resolveQuestionSurface(record(), revision, true).readOnly).toBe(
      true,
    );
    for (const invalid of [
      {
        ...record(),
        localBase: {
          png: new Blob(),
          layout: { ...layout, renderVersion: 999 },
        },
      },
      { ...record(), doc: { ...record().doc, version: 999 } },
      { ...record(), doc: null },
      {
        ...record(),
        localBase: null,
        base: {
          ...record().base,
          baseId,
          state: "ready",
          stale: false,
          pixelWidth: 600,
          pixelHeight: 400,
          layout: undefined,
        },
      },
    ]) {
      const result = resolveQuestionSurface(
        invalid as unknown as AnnotationLocalRecord,
        revision,
      );
      expect(result.status).toBe("blocked");
      expect(result.reason).toContain("保留");
    }
  });
  it.each([2, 3])("旧 v%s 缺证据不能伪装成几何就绪", (renderVersion) => {
    const { compatibility: _proof, renderProfile: _profile, ...core } = layout;
    const legacy = {
      ...core,
      renderVersion,
      ...(renderVersion === 3
        ? {
            controls: [
              {
                slotId: "slot-1",
                kind: "text",
                x: 0,
                y: 0,
                width: 100,
                height: 44,
              },
            ],
          }
        : {}),
    } as AnnotationSurfaceLayout;
    const local = {
      ...record(),
      localBase: { png: new Blob(), layout: legacy },
      base: null,
    };
    expect(resolveQuestionSurface(local, revision)).toMatchObject({
      status: "legacy-evidence-required",
      geometry: "unverified",
      source: { layout: legacy },
    });
  });
});
