import type { AnnotationDoc } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * seal-correction-annotation（2026-10 订正重构，自 AnnotationLayer 内嵌按钮
 * 抽出）例程测试：订正工作台「保存订正」统一封存圈画——无圈画返回 0 不
 * 封存、conflict/denied/pending 中文错误、有内容先追平（PUT 回执落地）
 * 再 seal(attemptId,'correction')。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    putAnnotationDocApi: vi.fn(),
    sealAttemptAnnotationsApi: vi.fn(async () => ({
      phase: "correction" as const,
      sealedCount: 1,
    })),
  };
});

import { putAnnotationDocApi, sealAttemptAnnotationsApi } from "@/lib/api";
import {
  applyAnnotationConflict,
  applyAnnotationDenied,
  installAnnotationBackend,
  memoryAnnotationBackend,
  resetAnnotationStoreForTest,
  settleAnnotationPersistence,
  writeAnnotationDoc,
} from "./annotation-store";
import {
  bindAnnotationSession,
  resetAnnotationSession,
} from "./annotation-sync";
import { sealCorrectionAnnotation } from "./seal-correction-annotation";

const putDocMock = vi.mocked(putAnnotationDocApi);
const sealMock = vi.mocked(sealAttemptAnnotationsApi);

const SESSION = { origin: "https://t.example", studentId: "s-1" };
const SCOPE = {
  attemptId: "a1",
  questionId: "q1",
  phase: "correction" as const,
};

const DOC: AnnotationDoc = {
  version: 1,
  baseWidth: 1440,
  baseHeight: 900,
  strokes: [
    {
      tool: "pen",
      color: "#dc2626",
      weight: 5.76,
      points: [
        { x: 100, y: 100, p: 0.5, t: 0 },
        { x: 200, y: 140, p: 0.5, t: 40 },
      ],
    },
  ],
};

beforeEach(() => {
  installAnnotationBackend(memoryAnnotationBackend());
  resetAnnotationStoreForTest();
  resetAnnotationSession();
  bindAnnotationSession(SESSION);
  putDocMock.mockReset();
  sealMock.mockReset();
  sealMock.mockResolvedValue({ phase: "correction", sealedCount: 1 });
});

afterEach(() => {
  resetAnnotationSession();
});

import { afterEach } from "vitest";

describe("sealCorrectionAnnotation：订正圈画检查点", () => {
  it("无记录 → 返回 0、不触发封存（空白不产生检查点）", async () => {
    expect(await sealCorrectionAnnotation(SCOPE)).toBe(0);
    expect(sealMock).not.toHaveBeenCalled();
  });

  it("有圈画：先追平（PUT 回执落地）再 seal(attemptId,'correction')，返回笔数", async () => {
    putDocMock.mockResolvedValue({
      annotationId: "00000000-0000-4000-8000-000000000001",
      revision: 1,
      hash: "a".repeat(64),
      savedAt: "2026-10-08T00:00:00Z",
    });
    writeAnnotationDoc(SESSION, SCOPE, DOC);
    await settleAnnotationPersistence();
    const strokes = await sealCorrectionAnnotation(SCOPE);
    expect(strokes).toBe(1);
    expect(putDocMock).toHaveBeenCalled(); // 追平先于 seal
    expect(sealMock).toHaveBeenCalledWith("a1", "correction");
  });

  it("conflict 终态 → 中文错误（先在圈画区裁决），不 seal", async () => {
    writeAnnotationDoc(SESSION, SCOPE, DOC);
    await applyAnnotationConflict(
      SESSION,
      SCOPE,
      "revision",
      null,
      "服务端已有另一份订正圈画",
    );
    await expect(sealCorrectionAnnotation(SCOPE)).rejects.toThrow(
      /同步冲突待处理/,
    );
    expect(sealMock).not.toHaveBeenCalled();
  });

  it("denied(access) 终态 → 中文错误带原因，不 seal", async () => {
    writeAnnotationDoc(SESSION, SCOPE, DOC);
    await applyAnnotationDenied(SESSION, SCOPE, "access", "已无权限访问该练习");
    await expect(sealCorrectionAnnotation(SCOPE)).rejects.toThrow(
      /订正圈画同步被拒：已无权限访问该练习/,
    );
    expect(sealMock).not.toHaveBeenCalled();
  });

  it("pending 未清（追平失败）→ 中文错误，不 seal", async () => {
    writeAnnotationDoc(SESSION, SCOPE, DOC);
    await settleAnnotationPersistence();
    // 追平时 PUT 失败 → pending 仍在
    putDocMock.mockRejectedValue(new Error("网络中断"));
    await expect(sealCorrectionAnnotation(SCOPE)).rejects.toThrow(
      /还没同步完成/,
    );
    expect(sealMock).not.toHaveBeenCalled();
  });
});
