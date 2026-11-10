import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Memo, MemoListData } from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  publishLearningFocus,
  resetLearningFocusForTest,
} from "@/features/memos/learning-focus-store";
import {
  bindMemoOutboxAccount,
  installMemoOutboxBackendForTest,
} from "@/features/memos/memo-outbox";
import { memoryKVBackend } from "@/lib/kv-backend";
import {
  createTextMemoApi,
  deleteMemoApi,
  listMemosApi,
  MemoNetworkError,
} from "@/lib/memo-api";
import StudentMemosPage from "./StudentMemosPage";

/**
 * /s/memos 随笔页组件测试（模块 5 第一步）：列表按形态渲染（文字 / 语音 <audio> /
 * 手写 <img>）、锚回链、Agent 转记标识；记录端文字保存走队列 → 调创建接口并刷新
 * 列表；锚自动带上且可去掉；离线时条目留在「待补传」区；删除；形态筛选改 URL。
 */

vi.mock("@/lib/memo-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/memo-api")>();
  return {
    ...actual,
    listMemosApi: vi.fn(),
    createTextMemoApi: vi.fn(),
    deleteMemoApi: vi.fn(),
    uploadMemoMediaApi: vi.fn(),
  };
});

const mockedList = vi.mocked(listMemosApi);
const mockedCreate = vi.mocked(createTextMemoApi);
const mockedDelete = vi.mocked(deleteMemoApi);

const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const LECTURE = "22222222-2222-4222-8222-222222222222";

function memo(
  partial: Partial<Memo> & { id: string; kind: Memo["kind"] },
): Memo {
  return {
    text: null,
    media: null,
    anchor: { kind: "none" },
    tags: [],
    source: "self",
    device: "phone",
    createdAt: "2026-06-01T00:00:00.000Z",
    recordedAt: "2026-06-01T00:00:00.000Z",
    ...partial,
  };
}

const LIST: MemoListData = {
  memos: [
    memo({
      id: "m-text",
      kind: "text",
      text: "基期现期别搞反",
      tags: ["易错", "资料分析"],
      anchor: {
        kind: "question",
        attemptId: ATTEMPT,
        questionId: "q-7",
        label: "第 7 题 · 资料分析",
      },
    }),
    memo({
      id: "m-voice",
      kind: "voice",
      media: { format: "m4a", bytes: 2048, durationSec: 75 },
      device: "phone",
    }),
    memo({
      id: "m-ink",
      kind: "ink",
      media: { format: "png", bytes: 4096, durationSec: null },
      device: "tablet",
      anchor: {
        kind: "lecture",
        lectureId: LECTURE,
        sectionId: null,
        label: "第二讲 比例",
      },
    }),
    memo({
      id: "m-agent",
      kind: "text",
      text: "转写：这题先算总量",
      source: "agent",
      device: "agent",
    }),
  ],
  nextCursor: null,
};

function renderPage(path = "/s/memos") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/s/memos" element={<StudentMemosPage />} />
          <Route path="/s/attempts/:attemptId" element={<p>作答页</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  mockedList.mockReset();
  mockedCreate.mockReset();
  mockedDelete.mockReset();
  mockedList.mockResolvedValue(LIST);
  installMemoOutboxBackendForTest(memoryKVBackend());
  await bindMemoOutboxAccount("stu-test");
  resetLearningFocusForTest();
});

afterEach(() => {
  cleanup();
  installMemoOutboxBackendForTest(null);
});

describe("StudentMemosPage", () => {
  it("列表：文字 / 语音 <audio> / 手写 <img> 各按形态渲染，锚回链到作答页，Agent 转记有标识", async () => {
    renderPage();
    expect(await screen.findByText("基期现期别搞反")).toBeInTheDocument();
    expect(screen.getByText("#易错")).toBeInTheDocument();
    const anchorLink = screen.getByRole("link", { name: /第 7 题 · 资料分析/ });
    expect(anchorLink).toHaveAttribute("href", `/s/attempts/${ATTEMPT}?q=q-7`);
    const audio = document.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute("src")).toBe("/api/student/memos/m-voice/media");
    expect(screen.getByText("· 1:15")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "手写随笔" })).toHaveAttribute(
      "src",
      "/api/student/memos/m-ink/media",
    );
    expect(screen.getByText("Agent 转记")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /第二讲 比例/ })).toHaveAttribute(
      "href",
      `/s/lectures/${LECTURE}`,
    );
  });

  it("记录端：带当前题锚保存文字 → 调创建接口（含锚与标签）并刷新列表；锚可去掉", async () => {
    publishLearningFocus({
      kind: "question",
      attemptId: ATTEMPT,
      questionId: "q-1",
      label: "第 1 题 · 模考",
    });
    mockedCreate.mockImplementation(async (input) =>
      memo({ id: "created", kind: "text", text: input.text }),
    );
    renderPage();
    await screen.findByText("基期现期别搞反");
    expect(screen.getByText("锚到：第 1 题 · 模考")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("随笔内容"), {
      target: { value: "  单位换算再看一眼  " },
    });
    fireEvent.change(screen.getByLabelText("标签"), {
      target: { value: "易错, 单位" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    const sent = mockedCreate.mock.calls[0]?.[0];
    expect(sent?.text).toBe("单位换算再看一眼");
    expect(sent?.tags).toEqual(["易错", "单位"]);
    expect(sent?.anchor).toEqual({
      kind: "question",
      attemptId: ATTEMPT,
      questionId: "q-1",
      label: "第 1 题 · 模考",
    });
    expect(sent?.device).toBeDefined();
    await waitFor(() =>
      expect(mockedList.mock.calls.length).toBeGreaterThan(1),
    );
    expect(screen.getByLabelText("随笔内容")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "去掉上下文锚" }));
    expect(
      screen.getByText("没有上下文锚（只记时间与设备）"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("随笔内容"), {
      target: { value: "无锚的一条" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(2));
    expect(mockedCreate.mock.calls[1]?.[0].anchor).toEqual({ kind: "none" });
  });

  it("离线：创建失败在网络层 → 条目留在「待补传」区置顶，不丢", async () => {
    mockedCreate.mockRejectedValue(new MemoNetworkError());
    renderPage();
    await screen.findByText("基期现期别搞反");
    fireEvent.change(screen.getByLabelText("随笔内容"), {
      target: { value: "地铁上想到的" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(
      await screen.findByRole("article", { name: "待补传的随笔" }),
    ).toHaveTextContent("地铁上想到的");
    expect(screen.getByText("待补传（联网后自动）")).toBeInTheDocument();
  });

  it("空文本保存给提示；删除调接口；形态筛选写入 URL 并带进列表查询", async () => {
    mockedDelete.mockResolvedValue({ id: "m-text" });
    renderPage();
    await screen.findByText("基期现期别搞反");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("status")).toHaveTextContent("先写点什么");
    expect(mockedCreate).not.toHaveBeenCalled();

    const [firstDelete] = screen.getAllByRole("button", {
      name: "删除这条随笔",
    });
    expect(firstDelete).toBeDefined();
    if (firstDelete !== undefined) fireEvent.click(firstDelete);
    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith("m-text"));

    fireEvent.click(screen.getByRole("tab", { name: "语音" }));
    await waitFor(() =>
      expect(mockedList).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "voice" }),
      ),
    );
    expect(screen.getByRole("tab", { name: "语音" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("空列表给空态", async () => {
    mockedList.mockResolvedValue({ memos: [], nextCursor: null });
    renderPage();
    expect(await screen.findByText("还没有随笔")).toBeInTheDocument();
  });
});
