/**
 * 草稿模块测试工具（T6R.8 复审⑪收敛）：note-store/note-sync/
 * use-note-record 三个测试文件共用的会话/定位/夹具/回执工厂与落盘等待。
 * 非测试运行时文件（同 note-fixtures 惯例）：不依赖 describe/it，只借
 * vitest 的 vi.waitFor；vi.mock 工厂仍留各测试文件（提升语义属用例本身）。
 */
import type { NoteHeadData, NoteVersionReceipt } from "@tutor/contract";
import { vi } from "vitest";
import { docOf, stroke } from "@/features/notes/note-fixtures";
import {
  getNoteRecord,
  type NoteScope,
  type NoteSessionRef,
} from "@/features/notes/note-store";

// ---------- 会话与定位 ----------

export const SESSION_A: NoteSessionRef = {
  origin: "https://tutor.example",
  studentId: "student-a",
};
export const SESSION_B: NoteSessionRef = {
  origin: "https://tutor.example",
  studentId: "student-b",
};

export const SCOPE: NoteScope = {
  attemptId: "att-1",
  questionId: "p1-q1",
  phase: "scratch",
};

// ---------- 正文夹具 ----------

export const DOC_A = docOf([
  stroke([
    [10, 10],
    [40, 40],
  ]),
]);
export const DOC_B = docOf([
  stroke([
    [10, 10],
    [40, 40],
  ]),
  stroke([
    [50, 50],
    [80, 80],
  ]),
]);
/** 空稿（清空=空稿版本上传的覆盖语义用） */
export const DOC_EMPTY = docOf([]);

// ---------- 回执与 head 投影工厂 ----------

export function receiptOf(revision: number): NoteVersionReceipt {
  return {
    noteId: "22222222-2222-4222-8222-222222222222",
    revision,
    versionId: `33333333-3333-4333-8333-3333333333${String(revision).padStart(2, "0")}`,
    hash: `${"a".repeat(63)}${revision}`,
    savedAt: "2026-10-06T00:00:00.000Z",
  };
}

/** rev1 head 投影（无图、无证据行；覆盖项按需传入） */
export function headOf(overrides: Partial<NoteHeadData> = {}): NoteHeadData {
  return {
    note: {
      noteId: "22222222-2222-4222-8222-222222222222",
      attemptId: SCOPE.attemptId,
      questionId: SCOPE.questionId,
      questionRevisionId: "qrev-1",
      phase: "scratch",
      revision: 1,
      currentVersionId: receiptOf(1).versionId,
      serverSavedAt: "2026-10-06T00:00:00.000Z",
    },
    images: [],
    evidence: null,
    ...overrides,
  };
}

// ---------- 等待助手 ----------

/** 等某键落盘完成（local=saved；串行队列 4 处样板收敛） */
export async function waitForLocalSaved(
  session: NoteSessionRef,
  scope: NoteScope,
): Promise<void> {
  await vi.waitFor(async () => {
    const record = await getNoteRecord(session, scope);
    if (record?.local !== "saved") throw new Error("not saved yet");
  });
}
