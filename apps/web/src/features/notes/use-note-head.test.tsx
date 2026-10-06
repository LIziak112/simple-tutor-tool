import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { NoteHeadData, StudentMeData } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docOf, stroke } from "@/features/notes/note-fixtures";
import {
  applyServerHead,
  installNoteBackend,
  memoryNoteBackend,
  peekNoteRecord,
  writeNoteDoc,
} from "@/features/notes/note-store";
import {
  bindNoteSession,
  currentNoteSession,
  resetNoteSession,
} from "@/features/notes/note-sync";
import { headOf, SCOPE, SESSION_A } from "@/features/notes/note-test-utils";
import { useNoteHead } from "@/features/notes/use-note-head";

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
    fetchStudentNoteHeadApi: vi.fn(),
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
  fetchStudentNoteHeadApi,
} from "@/lib/api";

const headMock = vi.mocked(fetchStudentNoteHeadApi);
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

beforeEach(() => {
  installNoteBackend(memoryNoteBackend());
  resetNoteSession();
  headMock.mockReset();
  docMock.mockReset();
  recoverMock.mockClear();
});

afterEach(() => {
  resetNoteSession();
});

describe("useNoteHead（T6R.9 接线）", () => {
  it("会话未绑定不拉取；绑定后拉 head 并应用（notCreated 空态不拉正文）", async () => {
    headMock.mockResolvedValue({ note: null, images: [], evidence: null });
    renderHeadHook();
    // 初始（bind 前的渲染帧）不应发请求——bind 后由 enabled 触发
    await act(async () => {
      bindNoteSession(SESSION_A);
    });
    await vi.waitFor(() => expect(headMock).toHaveBeenCalled());
    await vi.waitFor(() => {
      const record = peekNoteRecord(SESSION_A, SCOPE);
      expect(record?.lastHead?.note).toBeNull();
    });
    expect(docMock).not.toHaveBeenCalled();
    expect(recoverMock).not.toHaveBeenCalled();
  });

  it("本地无记录而服务端有版本：拉正文播种（工作稿=服务端稿）", async () => {
    headMock.mockResolvedValue(revHead());
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
    headMock.mockResolvedValue(head1);
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
    headMock.mockResolvedValue(
      revHead({
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
    headMock.mockRejectedValue(new ApiError("UNAUTHORIZED", "未登录", 401));
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
      expect(headMock.mock.calls.length).toBeGreaterThanOrEqual(1),
    );
    // ApiError 不重试（retry:false 分支）：等待一个宏任务后仍只有一次调用
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(headMock.mock.calls.length).toBe(1);
    expect(peekNoteRecord(SESSION_A, SCOPE)?.pending).not.toBeNull();
  });
});

describe("useBindNoteSession（T6R.9 答题页接线）", () => {
  it("me 到达即绑定 {origin, studentId}；me 未到不绑定", async () => {
    const { useBindNoteSession } = await import(
      "@/features/notes/use-note-head"
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const me: StudentMeData = {
      id: "11111111-1111-4111-8111-111111111111",
      displayName: "小明",
      loginName: "e2e-stu",
      linkEnabled: true,
      passwordEnabled: false,
    };
    function Probe({ me: m }: { me: StudentMeData | undefined }) {
      useBindNoteSession(m);
      return null;
    }
    const view = render(
      <QueryClientProvider client={client}>
        <Probe me={undefined} />
      </QueryClientProvider>,
    );
    expect(currentNoteSession()).toBeNull(); // 未到不绑
    view.rerender(
      <QueryClientProvider client={client}>
        <Probe me={me} />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => {
      expect(currentNoteSession()).toEqual({
        origin: window.location.origin,
        studentId: me.id,
      });
    });
    resetNoteSession();
  });
});
