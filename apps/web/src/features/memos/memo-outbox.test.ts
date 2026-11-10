import { act, cleanup, renderHook } from "@testing-library/react";
import type { Memo } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { type KVStoreBackend, memoryKVBackend } from "@/lib/kv-backend";
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
  useMemoOutbox,
} from "./memo-outbox";

/**
 * 随笔待补传队列：先落本机再上传；网络失败保留、联网后按序补传；业务拒绝标
 * failedMessage 不自动重试、可丢弃；按账号隔离；补传成功回调。
 * 审查修复（PR #104 报告）：账号切换与本机写入 / 补传交错时旧账号数据不进新队列
 * （#104-01）；本机写入失败时「返回即有副本」——立即上传，传不上去就拒绝（#104-02）。
 */

/** set 必败的后端（IndexedDB 不可用 / 配额满） */
function brokenSetBackend(base: KVStoreBackend): KVStoreBackend {
  return {
    ...base,
    set: async () => {
      throw new Error("QuotaExceededError");
    },
  };
}

/** 可挂起的 set：测试在写入途中切账号 */
function gatedSetBackend(base: KVStoreBackend): {
  backend: KVStoreBackend;
  release: () => void;
} {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    backend: {
      ...base,
      set: async (key, value) => {
        await gate;
        await base.set(key, value);
      },
    },
    release: () => release(),
  };
}

/** 当前队列快照（经 useMemoOutbox 订阅，与界面看到的一致） */
function queueProbe() {
  return renderHook(() => useMemoOutbox()).result;
}

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
  // 先卸载订阅探针，再清空队列状态（否则清空会在 act 之外触发探针重渲染）
  cleanup();
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

describe("memo-outbox：本机写入失败（#104-02）", () => {
  it("本机写不进、上传也失败：拒绝并说明，不留内存条目（避免恢复输入后重发成两条）", async () => {
    installMemoOutboxBackendForTest(brokenSetBackend(backend));
    await bindMemoOutboxAccount("stu-a");
    mockedText.mockRejectedValue(new MemoNetworkError());
    const probe = queueProbe();
    await act(async () => {
      await expect(enqueueMemo(TEXT_INPUT)).rejects.toThrow(/本机保存失败/);
    });
    expect(mockedText).toHaveBeenCalledTimes(1);
    expect(probe.current).toEqual([]);
    expect(await backend.getAll('["memo-outbox"')).toEqual([]);
  });

  it("本机写不进、上传被业务拒绝：拒绝信息带服务端说明", async () => {
    installMemoOutboxBackendForTest(brokenSetBackend(backend));
    await bindMemoOutboxAccount("stu-a");
    mockedText.mockRejectedValue(
      new ApiError("VALIDATION_ERROR", "正文超过 5000 字", 400),
    );
    await expect(enqueueMemo(TEXT_INPUT)).rejects.toThrow(/正文超过 5000 字/);
  });

  it("本机写不进但上传成功：正常返回，onMemoSynced 收到那条", async () => {
    installMemoOutboxBackendForTest(brokenSetBackend(backend));
    await bindMemoOutboxAccount("stu-a");
    mockedText.mockImplementation(async (input) => memoOf(input.text));
    const synced: Memo[] = [];
    const off = onMemoSynced((memo) => synced.push(memo));
    const probe = queueProbe();
    await act(async () => {
      await expect(enqueueMemo(TEXT_INPUT)).resolves.toEqual(
        expect.any(String),
      );
    });
    expect(synced.map((memo) => memo.text)).toEqual(["第一条"]);
    expect(probe.current).toEqual([]);
    off();
  });
});

describe("memo-outbox：账号切换交错（#104-01）", () => {
  it("未绑定账号时拒绝入队（不落到 null 账号键下）", async () => {
    await expect(enqueueMemo(TEXT_INPUT)).rejects.toThrow(/登录/);
    expect(await backend.getAll('["memo-outbox"')).toEqual([]);
  });

  it("本机写入挂起期间换账号：条目留在旧账号键下，不进新账号队列、不以新账号上传", async () => {
    const gated = gatedSetBackend(backend);
    installMemoOutboxBackendForTest(gated.backend);
    await bindMemoOutboxAccount("stu-a");
    mockedText.mockImplementation(async (input) => memoOf(input.text));
    const probe = queueProbe();

    let pending: Promise<string> | undefined;
    await act(async () => {
      pending = enqueueMemo(TEXT_INPUT);
      await bindMemoOutboxAccount("stu-b");
      gated.release();
      await pending;
      await flushMemoOutbox();
    });
    expect(probe.current).toEqual([]);
    expect(mockedText).not.toHaveBeenCalled();
    expect(await backend.getAll('["memo-outbox","stu-b"')).toEqual([]);
    expect(await backend.getAll('["memo-outbox","stu-a"')).toHaveLength(1);

    // 甲再登录：那条出现并补传
    await act(async () => {
      await bindMemoOutboxAccount("stu-a");
      await flushMemoOutbox();
    });
    expect(mockedText).toHaveBeenCalledTimes(1);
    expect(mockedText.mock.calls[0]?.[0].text).toBe("第一条");
  });

  it("补传在途时换账号：成功结果不通知、不动新队列，只清旧账号的本机键", async () => {
    await bindMemoOutboxAccount("stu-a");
    let finishUpload: (memo: Memo) => void = () => {};
    mockedText.mockImplementationOnce(
      () =>
        new Promise<Memo>((resolve) => {
          finishUpload = resolve;
        }),
    );
    const synced: Memo[] = [];
    const off = onMemoSynced((memo) => synced.push(memo));
    const probe = queueProbe();
    await act(async () => {
      await enqueueMemo(TEXT_INPUT); // 入队即触发补传，上传挂起
      await bindMemoOutboxAccount("stu-b");
      finishUpload(memoOf("第一条"));
      await flushMemoOutbox();
    });
    expect(synced).toEqual([]);
    expect(probe.current).toEqual([]);
    expect(await backend.getAll('["memo-outbox","stu-a"')).toEqual([]);
    off();
  });

  it("补传在途时换账号：业务拒绝只标到旧账号的本机键，新账号队列不受影响", async () => {
    await bindMemoOutboxAccount("stu-a");
    let failUpload: (err: unknown) => void = () => {};
    mockedText.mockImplementationOnce(
      () =>
        new Promise<Memo>((_resolve, reject) => {
          failUpload = reject;
        }),
    );
    const probe = queueProbe();
    await act(async () => {
      await enqueueMemo(TEXT_INPUT);
      await bindMemoOutboxAccount("stu-b");
      failUpload(new ApiError("VALIDATION_ERROR", "正文太长", 400));
      await flushMemoOutbox();
    });
    expect(probe.current).toEqual([]);
    expect(await backend.getAll('["memo-outbox","stu-b"')).toEqual([]);
    const stored = await backend.getAll('["memo-outbox","stu-a"');
    expect(stored).toHaveLength(1);
    const storedItem = stored[0]?.[1] as { failedMessage?: string } | undefined;
    expect(storedItem?.failedMessage).toBe("正文太长");
  });

  it("旧账号补传在途时新账号 bind：新账号的本机条目在旧一轮结束后自动补传", async () => {
    // 乙先前离线留了一条
    await bindMemoOutboxAccount("stu-b");
    mockedText.mockRejectedValue(new MemoNetworkError());
    await enqueueMemo({ ...TEXT_INPUT, text: "乙的离线条目" });
    await flushMemoOutbox();
    expect(await backend.getAll('["memo-outbox","stu-b"')).toHaveLength(1);
    mockedText.mockReset();
    // 甲登录并有一条上传挂起；此时切回乙
    await bindMemoOutboxAccount("stu-a");
    let finishUpload: (memo: Memo) => void = () => {};
    mockedText.mockImplementationOnce(
      () =>
        new Promise<Memo>((resolve) => {
          finishUpload = resolve;
        }),
    );
    await enqueueMemo({ ...TEXT_INPUT, text: "甲的在途条目" });
    mockedText.mockImplementation(async (input) => memoOf(input.text));
    const rebind = bindMemoOutboxAccount("stu-b");
    finishUpload(memoOf("甲的在途条目"));
    await rebind;
    await flushMemoOutbox();
    expect(mockedText.mock.calls.map((call) => call[0].text)).toEqual([
      "甲的在途条目",
      "乙的离线条目",
    ]);
    expect(await backend.getAll('["memo-outbox","stu-b"')).toEqual([]);
  });
});
