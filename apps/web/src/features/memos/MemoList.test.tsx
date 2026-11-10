import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Memo, MemoListData } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { memoryKVBackend } from "@/lib/kv-backend";
import {
  createTextMemoApi,
  listMemosApi,
  MemoNetworkError,
} from "@/lib/memo-api";
import { MemoList } from "./MemoList";
import {
  bindMemoOutboxAccount,
  enqueueMemo,
  flushMemoOutbox,
  installMemoOutboxBackendForTest,
} from "./memo-outbox";

/**
 * 随笔列表（审查修复，PR #104 报告）：
 * - #104-05 上传失败的本机条目可原地「重试」（与「丢弃」并列，≥ 44px 触控面）；
 * - #104-07 本机待传条目不依赖云端查询状态：云端加载中 / 失败时也能看到。
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

const TEXT_INPUT = {
  kind: "text" as const,
  text: "地铁上想到的",
  anchor: { kind: "none" as const },
  tags: [] as string[],
  device: "phone" as const,
  durationSec: undefined,
  blob: undefined,
};

function memoOf(text: string): Memo {
  return {
    id: crypto.randomUUID(),
    kind: "text",
    text,
    media: null,
    anchor: { kind: "none" },
    tags: [],
    source: "self",
    device: "phone",
    createdAt: "2026-06-01T00:00:00.000Z",
    recordedAt: "2026-06-01T00:00:00.000Z",
  };
}

const CLOUD: MemoListData = {
  memos: [memoOf("云端那条")],
  nextCursor: null,
};

function renderList() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MemoList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  mockedList.mockReset();
  mockedCreate.mockReset();
  installMemoOutboxBackendForTest(memoryKVBackend());
  await bindMemoOutboxAccount("stu-test");
});

afterEach(() => {
  cleanup();
  installMemoOutboxBackendForTest(null);
});

describe("MemoList：失败条目重试（#104-05）", () => {
  it("上传失败卡片有「重试」与「丢弃」；点重试后重新上传、成功即从本机区消失", async () => {
    mockedList.mockResolvedValue(CLOUD);
    mockedCreate.mockRejectedValueOnce(
      new ApiError("VALIDATION_ERROR", "标签太多", 400),
    );
    await enqueueMemo(TEXT_INPUT);
    await flushMemoOutbox();
    renderList();
    const card = await screen.findByRole("article", { name: "上传失败的随笔" });
    expect(card).toHaveTextContent("标签太多");
    const retry = screen.getByRole("button", { name: "重试" });
    expect(retry.className).toContain("min-h-11");
    expect(screen.getByRole("button", { name: "丢弃" }).className).toContain(
      "min-h-11",
    );

    mockedCreate.mockImplementation(async (input) => memoOf(input.text));
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByRole("article", { name: "上传失败的随笔" }),
      ).toBeNull(),
    );
  });
});
