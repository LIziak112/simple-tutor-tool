import type { AnnotationSurfaceLayout } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import type { AnnotationLocalRecord } from "./annotation-store";
import { resolveFrozenQuestionSurface } from "./frozen-surface-resolver";

const layout: AnnotationSurfaceLayout = {
  renderVersion: 2,
  questionRevisionId: "11111111-1111-4111-8111-111111111111",
  cssWidth: 300,
  cssHeight: 200,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
};
const png = new Blob(["png"], { type: "image/png" });
const oldBaseId = "22222222-2222-4222-8222-222222222222";
const newBaseId = "33333333-3333-4333-8333-333333333333";
function record(): AnnotationLocalRecord {
  return {
    localBase: { png, layout },
    doc: { version: 1, baseWidth: 600, baseHeight: 400, strokes: [] },
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
const localImage = {
  sourceUrl: "blob:original",
  decoded: {
    url: "blob:original",
    blob: png,
    width: 600,
    height: 400,
    failed: false,
  },
};

describe("固定原稿统一恢复判定", () => {
  it("v2 原稿与图像真正就绪后可读写；外层锁定仅禁写不藏墨", () => {
    expect(
      resolveFrozenQuestionSurface(record(), localImage, false),
    ).toMatchObject({
      status: "ready",
      source: { kind: "local", blob: png },
      canReadInk: true,
      canWrite: true,
    });
    expect(
      resolveFrozenQuestionSurface(record(), localImage, true),
    ).toMatchObject({
      status: "ready",
      canReadInk: true,
      canWrite: false,
    });
    expect(
      resolveFrozenQuestionSurface(
        { ...record(), sealedAt: "2026-11-05T00:00:00Z" },
        localImage,
        false,
      ),
    ).toMatchObject({
      status: "ready",
      canReadInk: true,
      canWrite: false,
    });
  });

  it("同像素尺寸但本机 PNG 绑定旧 baseId 时，采用新云稿只可使用新云图", () => {
    const changed = {
      ...record(),
      localBase: { png, layout, boundBaseId: oldBaseId },
      base: {
        baseId: newBaseId,
        state: "ready" as const,
        stale: false,
        pixelWidth: 600,
        pixelHeight: 400,
        layout,
        downloadUrl: "/new-base.png",
      },
    };
    const withOldImage = resolveFrozenQuestionSurface(
      changed,
      localImage,
      false,
    );
    expect(withOldImage).toMatchObject({
      status: "blocked",
      source: null,
      canReadInk: false,
      canWrite: false,
    });
    expect(
      resolveFrozenQuestionSurface(
        {
          ...changed,
          localBase: {
            png: new Blob(["cloud"], { type: "image/png" }),
            layout,
            boundBaseId: newBaseId,
          },
        },
        { sourceUrl: null, decoded: null },
        false,
      ),
    ).toMatchObject({
      status: "waiting",
      source: { kind: "local" },
    });
  });

  it("未同步本机 A 与云端 B 同尺寸异布局时，本机 PNG 和待传 doc 一起保留", () => {
    const local = record();
    const changed = {
      ...local,
      pending: {
        mutationId: "44444444-4444-4444-8444-444444444444",
        doc: local.doc,
      },
      base: {
        baseId: newBaseId,
        state: "ready" as const,
        stale: false,
        pixelWidth: 600,
        pixelHeight: 400,
        layout: { ...layout, geometrySignature: "d".repeat(64) },
        downloadUrl: "/new-base.png",
      },
    };
    expect(
      resolveFrozenQuestionSurface(changed, localImage, false),
    ).toMatchObject({
      status: "ready",
      source: { kind: "local", blob: png },
      canReadInk: true,
    });
    expect(
      resolveFrozenQuestionSurface(
        {
          ...changed,
          pending: null,
          retained: { reason: "保留本机稿" },
        },
        localImage,
        false,
      ),
    ).toMatchObject({
      status: "ready",
      source: { kind: "local", blob: png },
      canWrite: true,
    });
  });

  it("尺寸坏图、未知布局和正文坐标错配都不创建可编辑画布", () => {
    expect(
      resolveFrozenQuestionSurface(
        record(),
        {
          ...localImage,
          decoded: { ...localImage.decoded, width: 601 },
        },
        false,
      ),
    ).toMatchObject({ status: "blocked", canReadInk: false, canWrite: false });
    expect(
      resolveFrozenQuestionSurface(
        {
          ...record(),
          doc: { ...record().doc, baseWidth: 601 },
        },
        localImage,
        false,
      ),
    ).toMatchObject({ status: "blocked", canReadInk: false, canWrite: false });
    expect(
      resolveFrozenQuestionSurface(
        {
          // 故意模拟部署后出现的未知持久协议版本。
          ...record(),
          localBase: {
            png,
            layout: {
              ...layout,
              renderVersion: 99,
            } as unknown as AnnotationSurfaceLayout,
          },
        },
        localImage,
        false,
      ),
    ).toMatchObject({ status: "blocked", canReadInk: false, canWrite: false });
  });
});
