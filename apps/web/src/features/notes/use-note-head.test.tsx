import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { NoteHeadData } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docOf, stroke } from "@/features/notes/note-fixtures";
import {
  applyServerHead,
  installNoteBackend,
  memoryNoteBackend,
  peekNoteRecord,
  writeNoteDoc,
} from "@/features/notes/note-store";
import { bindNoteSession, resetNoteSession } from "@/features/notes/note-sync";
import {
  headOf,
  noteHeadsMockResponse,
  SCOPE,
  SESSION_A,
} from "@/features/notes/note-test-utils";
import {
  resetNoteHeadBatchForTest,
  useNoteHead,
} from "@/features/notes/use-note-head";

/**
 * useNoteHead（T6R.9）：答题页每题的笔记头拉取接线——head 应用进 store
 * （baseRevision/noteId 对齐 + 代际回退检测）、条件拉正文（服务端领先/
 * 首见才拉，本地未同步稿不被覆盖——applyServerLoad 语义）、补图恢复触发
 * （正文 synced 图片 failed/missing）。API 出网与补图链路全 mock。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentNoteHeadsApi: vi.fn(),
    fetchStudentNoteDocumentApi: vi.fn(),
  };
});

vi.mock("@/features/notes/image-sync", () => ({
  recoverNoteImages: vi.fn(async () => []),
}));

import { recoverNoteImages } from "@/features/notes/image-sync";
import {
  ApiError,
  fetchStudentNoteDocumentApi,
  fetchStudentNoteHeadsApi,
} from "@/lib/api";

const headsMock = vi.mocked(fetchStudentNoteHeadsApi);
const docMock = vi.mocked(fetchStudentNoteDocumentApi);
const recoverMock = vi.mocked(recoverNoteImages);

const SERVER_DOC = docOf([
  stroke([
    [5, 5],
    [30, 30],
  ]),
]);

/** rev1 head（共享 headOf 工厂；noteId 与 receipt 工厂一致） */
const revHead = (overrides: Partial<NoteHeadData> = {}): NoteHeadData =>
  headOf(overrides);

function renderHeadHook(
  attemptId = SCOPE.attemptId,
  questionId = SCOPE.questionId,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Probe() {
    useNoteHead(attemptId, questionId);
    return null;
  }
  return render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
}

/** 同 attempt 多题同时挂载（批量合批用例） */
function renderHeadHooks(
  questions: ReadonlyArray<[attemptId: string, questionId: string]>,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Probe() {
    for (const [attemptId, questionId] of questions) {
      // 测试探针：questions 每次渲染恒定 ⇒ 钩子次序恒定（React 规则成立），
      // lint 的静态判定不识别循环不变量
      // biome-ignore lint/correctness/useHookAtTopLevel: 测试探针的恒定循环
      useNoteHead(attemptId, questionId);
    }
    return null;
  }
  return render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  installNoteBackend(memoryNoteBackend());
  resetNoteSession();
  resetNoteHeadBatchForTest();
  headsMock.mockReset();
  docMock.mockReset();
  recoverMock.mockClear();
});

afterEach(() => {
  resetNoteSession();
});

describe("useNoteHead（T6R.9 接线；T6R.14 起经批量端点拉取）", () => {
  it("会话未绑定不拉取；绑定后拉 head 并应用（notCreated 空态不拉正文）", async () => {
    headsMock.mockImplementation(noteHeadsMockResponse());
    renderHeadHook();
    // 初始（bind 前的渲染帧）不应发请求——bind 后由 enabled 触发
    await act(async () => {
      bindNoteSession(SESSION_A);
    });
    await vi.waitFor(() => expect(headsMock).toHaveBeenCalled());
    await vi.waitFor(() => {
      const record = peekNoteRecord(SESSION_A, SCOPE);
      expect(record?.lastHead?.note).toBeNull();
    });
    expect(docMock).not.toHaveBeenCalled();
    expect(recoverMock).not.toHaveBeenCalled();
  });

  it("本地无记录而服务端有版本：拉正文播种（工作稿=服务端稿）", async () => {
    headsMock.mockImplementation(
      noteHeadsMockResponse({ [SCOPE.questionId]: revHead() }),
    );
    docMock.mockResolvedValue(SERVER_DOC);
    bindNoteSession(SESSION_A);
    renderHeadHook();
    await vi.waitFor(() => {
      expect(peekNoteRecord(SESSION_A, SCOPE)?.doc.ink.strokes.length).toBe(1);
    });
    const record = peekNoteRecord(SESSION_A, SCOPE);
    expect(record?.baseRevision).toBe(1);
    expect(record?.pending).toBeNull(); // 播种不算编辑，不回传
  });

  it("本地未同步稿领先（同 base 有 pending）：不拉正文、不覆盖本地", async () => {
    const head1 = revHead();
    headsMock.mockImplementation(
      noteHeadsMockResponse({ [SCOPE.questionId]: head1 }),
    );
    bindNoteSession(SESSION_A);
    // 先把本地记录对齐到 rev1（模拟上一轮已同步），再写新 pending：
    // 服务端仍停 rev1 —— 本地领先，无需拉正文
    await applyServerHead(SESSION_A, SCOPE, head1);
    writeNoteDoc(
      SESSION_A,
      SCOPE,
      docOf([
        stroke([
          [1, 1],
          [2, 2],
        ]),
      ]),
    );
    renderHeadHook();
    await vi.waitFor(() => {
      expect(peekNoteRecord(SESSION_A, SCOPE)?.lastHead).not.toBeNull();
    });
    expect(docMock).not.toHaveBeenCalled();
    expect(peekNoteRecord(SESSION_A, SCOPE)?.pending).not.toBeNull();
  });

  it("head 显示图片 failed/missing：触发补图恢复（学生重新进入）", async () => {
    headsMock.mockImplementation(
      noteHeadsMockResponse({
        [SCOPE.questionId]: revHead({
          images: [
            {
              imageId: "img-1",
              noteVersionId: "33333333-3333-4333-8333-333333333301",
              spec: "thumbnail",
              pageIndex: 0,
              crop: { x: 0, y: 0, width: 1000, height: 800 },
              pixelWidth: 500,
              pixelHeight: 400,
              state: "failed",
              hash: null,
            },
          ],
        }),
      }),
    );
    docMock.mockResolvedValue(SERVER_DOC);
    bindNoteSession(SESSION_A);
    renderHeadHook();
    await vi.waitFor(() =>
      expect(recoverMock).toHaveBeenCalledWith({
        role: "student",
        versionId: "33333333-3333-4333-8333-333333333301",
      }),
    );
  });

  it("head 网络失败不抛穿（退避由 react-query 接住；本地稿不受影响）", async () => {
    headsMock.mockRejectedValue(new ApiError("UNAUTHORIZED", "未登录", 401));
    bindNoteSession(SESSION_A);
    writeNoteDoc(
      SESSION_A,
      SCOPE,
      docOf([
        stroke([
          [1, 1],
          [2, 2],
        ]),
      ]),
    );
    renderHeadHook();
    await vi.waitFor(() =>
      expect(headsMock.mock.calls.length).toBeGreaterThanOrEqual(1),
    );
    // ApiError 不重试（retry:false 分支）：等待一个宏任务后仍只有一次调用
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(headsMock.mock.calls.length).toBe(1);
    expect(peekNoteRecord(SESSION_A, SCOPE)?.pending).not.toBeNull();
  });

  it("同 attempt 多题同 tick 挂载：合为一次批量请求（T6R.14 收敛）", async () => {
    const head1 = revHead();
    headsMock.mockImplementation(
      noteHeadsMockResponse({ [SCOPE.questionId]: head1 }),
    ); // p1-q2 的 head 即共享工厂的空态缺省
    docMock.mockResolvedValue(SERVER_DOC);
    bindNoteSession(SESSION_A);
    renderHeadHooks([
      [SCOPE.attemptId, SCOPE.questionId],
      [SCOPE.attemptId, "p1-q2"],
    ]);
    await vi.waitFor(() => {
      // toBeDefined（而非 not.toBeNull）：无记录时 undefined 不算已应用
      expect(
        peekNoteRecord(SESSION_A, { ...SCOPE, questionId: "p1-q2" })?.lastHead,
      ).toBeDefined();
    });
    // N 题 → 1 次批量请求；两题 id 都在该批里
    expect(headsMock).toHaveBeenCalledTimes(1);
    expect(headsMock.mock.calls[0]?.[0]).toBe(SCOPE.attemptId);
    expect(headsMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([SCOPE.questionId, "p1-q2"]),
    );
    // 各题 head 分别应用（head1 有版本 → 本地播种拉正文；head2 空态不拉）
    await vi.waitFor(() => {
      expect(peekNoteRecord(SESSION_A, SCOPE)?.doc.ink.strokes.length).toBe(1);
    });
    expect(docMock).toHaveBeenCalledTimes(1);
  });

  it("批量失败传播到全部题目的 query（ApiError 不重试，各题独立可重试）", async () => {
    headsMock.mockRejectedValue(new ApiError("FORBIDDEN", "无权访问", 403));
    bindNoteSession(SESSION_A);
    renderHeadHooks([
      [SCOPE.attemptId, SCOPE.questionId],
      [SCOPE.attemptId, "p1-q2"],
    ]);
    await vi.waitFor(() => expect(headsMock).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // 单次批量失败只发一次请求；两题记录均未应用 head（?? null 归一：
    // 无记录 undefined 与「有记录但 lastHead 空」都按未应用判）
    expect(headsMock.mock.calls.length).toBe(1);
    expect(peekNoteRecord(SESSION_A, SCOPE)?.lastHead ?? null).toBeNull();
    expect(
      peekNoteRecord(SESSION_A, { ...SCOPE, questionId: "p1-q2" })?.lastHead ??
        null,
    ).toBeNull();
  });
});
