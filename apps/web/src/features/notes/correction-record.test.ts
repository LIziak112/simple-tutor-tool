import type { NoteHeadData, NoteRecordMeta } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCorrectionRecord,
  getNoteRecord,
  installNoteBackend,
  memoryNoteBackend,
  peekNoteRecord,
  resetNoteStoreForTest,
  writeNoteDoc,
} from "@/features/notes/note-store";
import {
  correctionHeadKey,
  type RecoverOutcome,
  hasRecoverableScratch,
  openCorrectionOf,
  recoverScratchAsSupplement,
  seedOpenCorrection,
} from "@/features/notes/correction-record";
import {
  DOC_A,
  DOC_B,
  headOf,
  SCOPE,
  SESSION_A,
  waitForLocalSaved,
} from "@/features/notes/note-test-utils";

/**
 * correction-record（T6R.15 前端）测试：订正/补充稿的本地记录编排——
 * - openCorrectionOf / hasRecoverableScratch 纯函数（未封存行定位、
 *   D8 找回判定）；
 * - seedOpenCorrection：head.corrections 未封存行 → 本地 correction 记录
 *   对齐 + 条件拉正文播种（serverAhead 口径照 use-note-head）；
 * - recoverScratchAsSupplement（D8）：本地 scratch 未同步内容复制到
 *   supplement 新记录（scratch 记录保留不动）。
 * 正文出网 mock @/lib/api（口径同 note-store/note-sync 测试）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentNoteDocumentApi: vi.fn(),
  };
});

import { fetchStudentNoteDocumentApi } from "@/lib/api";

const docMock = vi.mocked(fetchStudentNoteDocumentApi);

/** 订正行工厂（未封存缺省；sealedAt 传非空即封存行） */
function correctionRow(overrides: Partial<NoteRecordMeta> = {}): NoteRecordMeta {
  return {
    noteId: "88888888-8888-4888-8888-888888888801",
    attemptId: SCOPE.attemptId,
    questionId: SCOPE.questionId,
    questionRevisionId: "qrev-1",
    phase: "correction",
    revision: 2,
    currentVersionId: "33333333-3333-4333-8333-333333333388",
    serverSavedAt: "2026-10-07T01:00:00.000Z",
    sealedAt: null,
    stuckAt: null,
    errorCause: null,
    ...overrides,
  };
}

/** 含未封存订正行的 head（其余投影空态） */
function headWithCorrection(row: NoteRecordMeta): NoteHeadData {
  return {
    ...headOf({ note: null }),
    corrections: [row],
  };
}

const CORRECTION_SCOPE = { ...SCOPE, phase: "correction" as const };
const SUPPLEMENT_SCOPE = { ...SCOPE, phase: "supplement" as const };

beforeEach(() => {
  installNoteBackend(memoryNoteBackend());
  docMock.mockReset();
});

afterEach(() => {
  resetNoteStoreForTest();
  vi.clearAllMocks();
});

describe("openCorrectionOf：未封存行定位（纯函数）", () => {
  it("多行中取 sealedAt==null 的未封存行；全封存/空数组返回 null", () => {
    const sealed = correctionRow({
      noteId: "88888888-8888-4888-8888-888888888802",
      sealedAt: "2026-10-07T02:00:00.000Z",
    });
    const open = correctionRow();
    expect(openCorrectionOf(headWithCorrection(sealed))).toBeNull();
    expect(
      openCorrectionOf({ ...headOf({ note: null }), corrections: [] }),
    ).toBeNull();
    expect(
      openCorrectionOf({
        ...headOf({ note: null }),
        corrections: [sealed, open],
      }),
    ).toBe(open);
  });
});

describe("hasRecoverableScratch：D8 找回判定（纯函数）", () => {
  it("null/无笔迹/已全同步 → false；有笔迹且未同步（pending/从未上送）→ true", () => {
    expect(hasRecoverableScratch(null)).toBe(false);
    expect(
      hasRecoverableScratch({
        doc: { version: 1, ink: { width: 1000, strokes: [] } },
        pending: { mutationId: "m", doc: DOC_A },
        baseRevision: 0,
        noteId: null,
        lastHead: null,
        conflict: null,
        denied: null,
        local: "saved",
        localError: null,
        editedAt: 1,
        docVersion: 1,
        totalPoints: 2,
      }),
    ).toBe(false); // 无笔迹：空稿没有可找回的内容
    expect(
      hasRecoverableScratch({
        doc: { version: 1, ink: DOC_A.ink },
        pending: { mutationId: "m", doc: DOC_A },
        baseRevision: 0,
        noteId: null,
        lastHead: null,
        conflict: null,
        denied: null,
        local: "saved",
        localError: null,
        editedAt: 1,
        docVersion: 1,
        totalPoints: 2,
      }),
    ).toBe(true); // 从未上送
    expect(
      hasRecoverableScratch({
        doc: { version: 1, ink: DOC_A.ink },
        pending: null,
        baseRevision: 1,
        noteId: "22222222-2222-4222-8222-222222222222",
        lastHead: null,
        conflict: null,
        denied: null,
        local: "saved",
        localError: null,
        editedAt: 1,
        docVersion: 1,
        totalPoints: 2,
      }),
    ).toBe(false); // 已全同步（服务端工作稿持有同样内容）
  });
});

describe("seedOpenCorrection：未封存行对齐与条件播种", () => {
  it("head 无未封存行 → no-op 不建记录", async () => {
    const sealedHead = headWithCorrection(
      correctionRow({ sealedAt: "2026-10-07T02:00:00.000Z" }),
    );
    await seedOpenCorrection(SESSION_A, SCOPE.attemptId, SCOPE.questionId, sealedHead);
    expect(await getNoteRecord(SESSION_A, CORRECTION_SCOPE)).toBeNull();
    expect(docMock).not.toHaveBeenCalled();
  });

  it("本地无记录 → 对齐 baseRevision/noteId 并拉正文播种（pending 清空）", async () => {
    docMock.mockResolvedValue(DOC_B);
    const head = headWithCorrection(correctionRow());
    await seedOpenCorrection(SESSION_A, SCOPE.attemptId, SCOPE.questionId, head);
    const record = await getNoteRecord(SESSION_A, CORRECTION_SCOPE);
    expect(record?.baseRevision).toBe(2);
    expect(record?.noteId).toBe("88888888-8888-4888-8888-888888888801");
    expect(docMock).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333388",
    );
    expect(record?.doc.ink.strokes.length).toBe(DOC_B.ink.strokes.length);
    expect(record?.pending).toBeNull();
  });

  it("revision=0 空白新行 → 只对齐 head 不拉正文（无版本可读）", async () => {
    const head = headWithCorrection(
      correctionRow({ revision: 0, currentVersionId: null, serverSavedAt: null }),
    );
    await seedOpenCorrection(SESSION_A, SCOPE.attemptId, SCOPE.questionId, head);
    const record = await getNoteRecord(SESSION_A, CORRECTION_SCOPE);
    expect(record?.baseRevision).toBe(0);
    expect(record?.noteId).toBe("88888888-8888-4888-8888-888888888801");
    expect(docMock).not.toHaveBeenCalled();
  });

  it("本地领先（同 noteId、baseRevision 相等、有 pending）→ 不拉正文、pending 保留", async () => {
    docMock.mockResolvedValue(DOC_B);
    const head = headWithCorrection(correctionRow());
    // 本地对同一行已有待传新内容（baseRevision 已对齐 2）
    await seedOpenCorrection(SESSION_A, SCOPE.attemptId, SCOPE.questionId, {
      ...head,
    });
    writeNoteDoc(SESSION_A, CORRECTION_SCOPE, DOC_A);
    const withPending = peekNoteRecord(SESSION_A, CORRECTION_SCOPE);
    expect(withPending?.pending).not.toBeNull();

    docMock.mockClear();
    await seedOpenCorrection(SESSION_A, SCOPE.attemptId, SCOPE.questionId, head);
    expect(docMock).not.toHaveBeenCalled();
    const after = peekNoteRecord(SESSION_A, CORRECTION_SCOPE);
    expect(after?.pending).not.toBeNull(); // 未同步本地稿不被覆盖
    expect(after?.doc.ink.strokes.length).toBe(DOC_A.ink.strokes.length);
  });

  it("换行（noteId 变化，创建新订正后）→ 弃本地旧稿拉新行正文（serverAhead）", async () => {
    // 旧行残留 + 清除（CorrectionSection 创建新行后的既定次序）
    writeNoteDoc(SESSION_A, CORRECTION_SCOPE, DOC_A);
    await clearCorrectionRecord(SESSION_A, CORRECTION_SCOPE);
    docMock.mockResolvedValue(DOC_B);
    const newRow = correctionRow({
      noteId: "88888888-8888-4888-8888-888888888899",
      revision: 1,
      currentVersionId: "33333333-3333-4333-8333-333333333399",
    });
    await seedOpenCorrection(
      SESSION_A,
      SCOPE.attemptId,
      SCOPE.questionId,
      headWithCorrection(newRow),
    );
    const record = await getNoteRecord(SESSION_A, CORRECTION_SCOPE);
    expect(docMock).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333399",
    );
    expect(record?.noteId).toBe(newRow.noteId);
    expect(record?.doc.ink.strokes.length).toBe(DOC_B.ink.strokes.length);
  });

  it("正文拉取失败不抛错（本地稿不受影响，head 对齐保留）", async () => {
    docMock.mockRejectedValue(new Error("网络断开"));
    const head = headWithCorrection(correctionRow());
    await expect(
      seedOpenCorrection(SESSION_A, SCOPE.attemptId, SCOPE.questionId, head),
    ).resolves.toBeUndefined();
    const record = await getNoteRecord(SESSION_A, CORRECTION_SCOPE);
    expect(record?.baseRevision).toBe(2); // head 段已落地
    expect(record?.doc.ink.strokes).toEqual([]); // 正文段未播种
  });
});

describe("recoverScratchAsSupplement（D8：找回草稿为补充稿）", () => {
  async function scratchWithPending(): Promise<void> {
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await waitForLocalSaved(SESSION_A, SCOPE);
  }

  it("本地 scratch 未同步内容 → 复制到 supplement 记录（pending 生成），scratch 保留不动", async () => {
    await scratchWithPending();
    const outcome = await recoverScratchAsSupplement(
      SESSION_A,
      SCOPE.attemptId,
      SCOPE.questionId,
    );
    expect(outcome).toBe<RecoverOutcome>("copied");
    const supplement = await getNoteRecord(SESSION_A, SUPPLEMENT_SCOPE);
    expect(supplement?.doc.ink.strokes.length).toBe(DOC_A.ink.strokes.length);
    expect(supplement?.pending).not.toBeNull(); // 触发同步（phase=supplement）
    // scratch 记录原样保留
    const scratch = await getNoteRecord(SESSION_A, SCOPE);
    expect(scratch?.doc.ink.strokes.length).toBe(DOC_A.ink.strokes.length);
    expect(scratch?.pending).not.toBeNull();
    expect(scratch?.baseRevision).toBe(0);
  });

  it("无本地 scratch 记录 → nothing（不建 supplement 壳）", async () => {
    const outcome = await recoverScratchAsSupplement(
      SESSION_A,
      SCOPE.attemptId,
      SCOPE.questionId,
    );
    expect(outcome).toBe<RecoverOutcome>("nothing");
    expect(await getNoteRecord(SESSION_A, SUPPLEMENT_SCOPE)).toBeNull();
  });

  it("scratch 已全同步 → nothing（服务端工作稿已持有同样内容）", async () => {
    await scratchWithPending();
    // 模拟回执全同步：pending 清空 + baseRevision 推进
    const record = peekNoteRecord(SESSION_A, SCOPE);
    if (record === null) throw new Error("测试前置失败");
    record.pending = null;
    record.baseRevision = 1;
    record.noteId = "22222222-2222-4222-8222-222222222222";
    const outcome = await recoverScratchAsSupplement(
      SESSION_A,
      SCOPE.attemptId,
      SCOPE.questionId,
    );
    expect(outcome).toBe<RecoverOutcome>("nothing");
    expect(await getNoteRecord(SESSION_A, SUPPLEMENT_SCOPE)).toBeNull();
  });
});

describe("correctionHeadKey：查询键（含学生 id，切账号不回放）", () => {
  it("键含学生/attempt/题与 correction-head 域", () => {
    expect(correctionHeadKey("s1", "att-1", "p1-q1")).toEqual([
      "student",
      "s1",
      "correction-head",
      "att-1",
      "p1-q1",
    ]);
    expect(correctionHeadKey("s2", "att-1", "p1-q1")).not.toEqual(
      correctionHeadKey("s1", "att-1", "p1-q1"),
    );
  });
});
