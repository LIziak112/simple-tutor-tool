import type { Memo } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { memoryKVBackend } from "@/lib/kv-backend";
import {
  createTextMemoApi,
  MemoNetworkError,
  uploadMemoMediaApi,
} from "@/lib/memo-api";
import {
  bindMemoOutboxAccount,
  discardMemoOutboxItem,
  enqueueMemo,
  flushMemoOutbox,
  installMemoOutboxBackendForTest,
  onMemoSynced,
} from "./memo-outbox";

/**
 * 随笔待补传队列：先落本机再上传；网络失败保留、联网后按序补传；业务拒绝标
 * failedMessage 不自动重试、可丢弃；按账号隔离；补传成功回调。
 */

vi.mock("@/lib/memo-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/memo-api")>();
  return {
    ...actual,
    createTextMemoApi: vi.fn(),
    uploadMemoMediaApi: vi.fn(),
  };
});

const mockedText = vi.mocked(createTextMemoApi);
const mockedMedia = vi.mocked(uploadMemoMediaApi);

function memoOf(text: string): Memo {
  return {
    id: crypto.randomUUID(),
    kind: "text",
    text,
    media: null,
    anchor: { kind: "none" },
    tags: [],
    source: "self",
    device: "desktop",
    createdAt: "2026-01-01T00:00:00.000Z",
    recordedAt: "2026-01-01T00:00:00.000Z",
  };
}

const TEXT_INPUT = {
  kind: "text" as const,
  text: "第一条",
  anchor: { kind: "none" as const },
  tags: ["易错"],
  device: "desktop" as const,
  durationSec: undefined,
  blob: undefined,
};

let backend = memoryKVBackend();

beforeEach(() => {
  backend = memoryKVBackend();
  installMemoOutboxBackendForTest(backend);
  mockedText.mockReset();
  mockedMedia.mockReset();
});

afterEach(() => {
  installMemoOutboxBackendForTest(null);
});

describe("memo-outbox", () => {
  it("在线：入队即上传成功，本机条目清掉，onMemoSynced 收到服务端那条", async () => {
    await bindMemoOutboxAccount("stu-a");
    const synced: Memo[] = [];
    const off = onMemoSynced((memo) => synced.push(memo));
    mockedText.mockResolvedValueOnce(memoOf("第一条"));
    await enqueueMemo(TEXT_INPUT);
    await flushMemoOutbox();
    expect(mockedText).toHaveBeenCalledTimes(1);
    const sent = mockedText.mock.calls[0]?.[0];
    expect(sent?.text).toBe("第一条");
    expect(sent?.tags).toEqual(["易错"]);
    expect(typeof sent?.clientId).toBe("string");
    expect(synced).toHaveLength(1);
    expect(await backend.getAll('["memo-outbox","stu-a"')).toEqual([]);
    off();
  });

  it("离线：网络失败保留在本机；重新 bind 后按入队顺序补传且 clientId 不变", async () => {
    await bindMemoOutboxAccount("stu-a");
    mockedText.mockRejectedValue(new MemoNetworkError());
    const first = await enqueueMemo(TEXT_INPUT);
    const second = await enqueueMemo({ ...TEXT_INPUT, text: "第二条" });
    await flushMemoOutbox();
    expect(await backend.getAll('["memo-outbox","stu-a"')).toHaveLength(2);

    // 模拟刷新页面：状态清空、从本机载入
    installMemoOutboxBackendForTest(backend);
    mockedText.mockReset();
    mockedText.mockImplementation(async (input) => memoOf(input.text));
    await bindMemoOutboxAccount("stu-a");
    await flushMemoOutbox();
    expect(mockedText.mock.calls.map((call) => call[0].clientId)).toEqual([
      first,
      second,
    ]);
    expect(await backend.getAll('["memo-outbox","stu-a"')).toEqual([]);
  });

  it("业务拒绝（4xx）标 failedMessage、不再自动重试、可丢弃；后面的条目继续传", async () => {
    await bindMemoOutboxAccount("stu-a");
    mockedMedia.mockRejectedValueOnce(
      new ApiError("MEMO_UNSUPPORTED_TYPE", "录音格式不受支持", 415),
    );
    mockedText.mockResolvedValueOnce(memoOf("随后那条"));
    const bad = await enqueueMemo({
      ...TEXT_INPUT,
      kind: "voice",
      text: undefined,
      blob: new Blob([new Uint8Array([1, 2, 3])]),
      durationSec: 3,
    });
    await enqueueMemo({ ...TEXT_INPUT, text: "随后那条" });
    await flushMemoOutbox();
    const stored = await backend.getAll('["memo-outbox","stu-a"');
    expect(stored).toHaveLength(1);
    const storedItem = stored[0]?.[1] as { failedMessage?: string } | undefined;
    expect(storedItem?.failedMessage).toBe("录音格式不受支持");

    await flushMemoOutbox();
    expect(mockedMedia).toHaveBeenCalledTimes(1);

    await discardMemoOutboxItem(bad);
    expect(await backend.getAll('["memo-outbox","stu-a"')).toEqual([]);
  });

  it("按账号隔离：甲的待传条目不会在乙登录后被上传", async () => {
    await bindMemoOutboxAccount("stu-a");
    mockedText.mockRejectedValue(new MemoNetworkError());
    await enqueueMemo(TEXT_INPUT);
    await flushMemoOutbox();
    mockedText.mockReset();
    mockedText.mockImplementation(async (input) => memoOf(input.text));
    await bindMemoOutboxAccount("stu-b");
    await flushMemoOutbox();
    expect(mockedText).not.toHaveBeenCalled();
    expect(await backend.getAll('["memo-outbox","stu-a"')).toHaveLength(1);
  });
});
