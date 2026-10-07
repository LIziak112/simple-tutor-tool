/**
 * 草稿模块测试工具（T6R.8 复审⑪收敛）：note-store/note-sync/
 * use-note-record 三个测试文件共用的会话/定位/夹具/回执工厂与落盘等待。
 * 纯运行时依赖（contract + note-store），不依赖任何测试框架——vi.mock
 * 工厂留在各测试文件（提升语义属用例本身）；waitForLocalSaved 为本地
 * 轮询（note-store 测试不用假时钟，真定时器 10ms 步进）。
 */
import type {
  NoteHeadData,
  NoteImageMeta,
  NoteSubmissionEvidenceMeta,
  NoteVersionReceipt,
} from "@tutor/contract";
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

/**
 * 批量头响应工厂（T6R.14，四个测试文件共享——W5 收敛四份手写变体）：
 * 返回按请求序对齐的 head 数组（对齐 fetchStudentNoteHeadsApi 的返回契约
 * ——W1 起客户端已把服务端逐条回显收口为按请求序数组），覆盖表定制、
 * 缺省空态（notCreated）。
 */
export function noteHeadsMockResponse(
  overrides: Record<string, NoteHeadData> = {},
): (
  attemptId: string,
  questionIds: readonly string[],
) => Promise<NoteHeadData[]> {
  return async (_attemptId, questionIds) =>
    questionIds.map(
      (questionId) =>
        overrides[questionId] ?? {
          note: null,
          images: [],
          evidence: null,
          corrections: [],
          supplements: [],
        },
    );
}

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
    // T6R.15 契约先行：head 投影恒带两数组（服务端空为 []；夹具同形态）
    corrections: [],
    supplements: [],
    ...overrides,
  };
}

/**
 * 证据行工厂（T6R.11 原稿查看测试）：frozen 须带 versionId（契约
 * superRefine 口径），其余状态 versionId 恒 null——工厂如实镜像，不替调用方
 * 拼非法组合。
 */
export function evidenceOf(
  state: "none" | "frozen" | "missing" | "legacy_unverified",
  versionId: string | null = null,
): NoteSubmissionEvidenceMeta {
  return {
    attemptId: SCOPE.attemptId,
    questionId: SCOPE.questionId,
    state,
    versionId,
    recordedAt: "2026-10-06T01:00:00.000Z",
  };
}

/** 派生图元信息工厂（T6R.11 图片状态用；缺省 analysis 第 0 页 ready） */
export function imageMetaOf(
  overrides: Partial<NoteImageMeta> = {},
): NoteImageMeta {
  return {
    imageId: "44444444-4444-4444-8444-444444444441",
    noteVersionId: receiptOf(1).versionId,
    spec: "analysis",
    pageIndex: 0,
    crop: { x: 0, y: 0, width: 1000, height: 800 },
    pixelWidth: 1000,
    pixelHeight: 800,
    state: "ready",
    hash: `${"b".repeat(64)}`,
    ...overrides,
  };
}

// ---------- 等待助手 ----------

/** 等某键落盘完成（local=saved；本地轮询 10ms×100，不依赖测试框架） */
export async function waitForLocalSaved(
  session: NoteSessionRef,
  scope: NoteScope,
): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const record = await getNoteRecord(session, scope);
    if (record?.local === "saved") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("not saved yet（100×10ms 轮询超时，测试前置失败）");
}

// ---------- 宽度观察桩与空稿夹具（组件测试共享，T6R.9 复审⑪） ----------

/**
 * ResizeObserver 桩（框架无关）：调用方 vi.stubGlobal("ResizeObserver",
 * stub.cls)，随后 stub.push(width) 模拟容器宽度变化（需包在 act 里）。
 * 多个观察者（多题卡/多草稿层）同推同一宽度。
 */
export interface ResizeObserverStub {
  cls: new (
    cb: (entries: { contentRect: { width: number } }[]) => void,
  ) => unknown;
  /** 向全部**连接中**的实例推一次宽度（disconnect 后不再收到——真实语义） */
  push: (width: number) => void;
}

export function makeResizeObserverStub(): ResizeObserverStub {
  const observers: { cb: (w: number) => void; connected: boolean }[] = [];
  const cls = class {
    constructor(cb: (entries: { contentRect: { width: number } }[]) => void) {
      observers.push({
        cb: (width: number) => cb([{ contentRect: { width } }]),
        connected: true,
      });
    }
    observe() {}
    unobserve() {}
    disconnect() {
      // 断开的实例不再收事件（useObservedCssValue 的 enabled=false 依赖此语义）
      for (const entry of observers) entry.connected = false;
    }
  };
  return {
    cls,
    push: (width: number) => {
      for (const entry of [...observers]) {
        if (entry.connected) entry.cb(width);
      }
    },
  };
}

export { emptyAtramentDoc } from "@/features/ink/engine/index.ts";
