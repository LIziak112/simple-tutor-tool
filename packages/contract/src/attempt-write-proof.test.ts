import { describe, expect, it } from "vitest";
import { annotationUploadMetaSchema } from "./annotation.ts";
import { attemptAnswerSaveRequestSchema } from "./attempt.ts";
import { inkWriteMetaSchema } from "./ink.ts";
import { noteUploadMetaSchema } from "./note.ts";

const token = "2026-11-14T00:00:00.000Z";
const meta = {
  baseRevision: 0,
  mutationId: "00000000-0000-4000-8000-000000000001",
};
describe("真实正文写入的冻结凭据", () => {
  it.each([
    inkWriteMetaSchema,
    noteUploadMetaSchema,
    annotationUploadMetaSchema,
  ])("保留原协议，新增凭据原样保留且拒绝非法日期", (schema) => {
    expect(schema.safeParse(meta).success).toBe(true);
    expect(schema.parse({ ...meta, expectedFrozenAt: token })).toMatchObject({
      expectedFrozenAt: token,
    });
    expect(schema.parse({ ...meta, expectedFrozenAt: null })).toMatchObject({
      expectedFrozenAt: null,
    });
    expect(
      schema.safeParse({ ...meta, expectedFrozenAt: "旧稿" }).success,
    ).toBe(false);
  });
  it("答案与笔迹使用同一冻结凭据口径", () => {
    const body = {
      answer: { kind: "judge", value: true },
      ...meta,
      expectedFrozenAt: token,
    };
    expect(attemptAnswerSaveRequestSchema.parse(body)).toMatchObject({
      expectedFrozenAt: token,
    });
  });
});
