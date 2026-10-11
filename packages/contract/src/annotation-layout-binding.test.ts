import { expect, it } from "vitest";
import {
  annotationBaseCreateRequestSchema,
  annotationBasePreviewDataSchema,
  annotationBaseRefSchema,
  annotationViewDataSchema,
} from "./annotation";

const revision = "11111111-1111-4111-8111-111111111111";
const layout = {
  renderVersion: 2,
  questionRevisionId: revision,
  cssWidth: 300,
  cssHeight: 200,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
};
const base = {
  baseId: revision,
  state: "pending",
  stale: false,
  pixelWidth: null,
  pixelHeight: null,
  layout,
};
const preview = {
  base,
  baseRenderVersion: 2,
  maxWidthPx: 600,
  questionRevisionId: revision,
  questionNo: 1,
  questionMd: "公开题面",
  mediaSrcs: [],
  graphFigures: [],
  interactionNotes: [],
};

it("旧首建无字段保持兼容，新首建只接受严格公开布局", () => {
  expect(annotationBaseCreateRequestSchema.parse({})).toEqual({});
  expect(annotationBaseCreateRequestSchema.parse({ layout })).toEqual({
    layout,
  });
  expect(
    annotationBaseCreateRequestSchema.safeParse({
      layout: { ...layout, snapshotHash: "secret" },
    }).success,
  ).toBe(false);
});
it("新版预览往返保留布局且宽度必须匹配，不放宽旧1440规则", () => {
  expect(annotationBasePreviewDataSchema.parse(preview).base.layout).toEqual(
    layout,
  );
  expect(
    annotationBasePreviewDataSchema.safeParse({ ...preview, maxWidthPx: 601 })
      .success,
  ).toBe(false);
  expect(
    annotationBasePreviewDataSchema.safeParse({
      ...preview,
      baseRenderVersion: 1,
    }).success,
  ).toBe(false);
  expect(
    annotationBasePreviewDataSchema.safeParse({
      ...preview,
      questionRevisionId: "22222222-2222-4222-8222-222222222222",
    }).success,
  ).toBe(false);
});
it("ready底图实际像素几何必须与布局相符", () => {
  expect(
    annotationBaseRefSchema.parse({
      ...base,
      state: "ready",
      pixelWidth: 600,
      pixelHeight: 400,
    }).layout,
  ).toEqual(layout);
  expect(
    annotationBaseRefSchema.safeParse({
      ...base,
      state: "ready",
      pixelWidth: 1440,
      pixelHeight: 400,
    }).success,
  ).toBe(false);
});

it("新版回看使用实际宽度，历史回看仍要求1440", () => {
  const view = { base, maxWidthPx: 600, doc: null, annotation: null };
  expect(annotationViewDataSchema.parse(view).maxWidthPx).toBe(600);
  expect(
    annotationViewDataSchema.safeParse({
      ...view,
      base: { ...base, layout: undefined },
    }).success,
  ).toBe(false);
});
