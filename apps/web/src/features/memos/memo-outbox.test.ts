import type { LearningContext, Memo } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { type KVStoreBackend, memoryKVBackend } from "@/lib/kv-backend";
import { resolveLearningContext } from "@/lib/learning-source-legacy-api";
import {
  createTextMemoApi,
  MemoNetworkError,
  uploadMemoMediaApi,
} from "@/lib/memo-api";
import { testClientServices } from "@/test/portal-fixture";
import { act, cleanup, renderHook } from "@/test/render-with-portal";
import {
  bindMemoOutboxAccount,
  discardMemoOutboxItem,
  enqueueMemo,
  flushMemoOutbox,
  installMemoOutboxBackendForTest,
  onMemoSynced,
  retryMemoOutboxItem,
  useMemoOutbox,
} from "./memo-outbox";

/**
 * 随笔待补传队列：先落本机再上传；网络失败保留、联网后按序补传；业务拒绝标
 * failedMessage 不自动重试、可丢弃；按账号隔离；补传成功回调。
 * 审查修复（PR #104 报告）：账号切换与本机写入 / 补传交错时旧账号数据不进新队列
 * （#104-01）；本机写入失败时「返回即有副本」——立即上传，传不上去就拒绝（#104-02）；
 * 暂态服务错误（5xx / 408 / 429）不标失败、下次继续补传，失败条目可原地重试（#104-05）。
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

vi.mock("@/lib/learning-source-legacy-api", () => ({
  resolveLearningContext: vi.fn(),
}));
const mockedResolve = vi.mocked(resolveLearningContext);

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
  mockedResolve.mockReset();
});

afterEach(() => {
  // 先卸载订阅探针，再清空队列状态（否则清空会在 act 之外触发探针重渲染）
  cleanup();
  installMemoOutboxBackendForTest(null);
});

describe("memo-outbox", () => {
  it("没有 IndexedDB 且直传失败时，报告随笔尚未保存", async () => {
    vi.stubGlobal("indexedDB", undefined);
    try {
      installMemoOutboxBackendForTest(null);
      await bindMemoOutboxAccount("stu-a", testClientServices);
      mockedText.mockRejectedValueOnce(new MemoNetworkError());
      await expect(enqueueMemo(TEXT_INPUT)).rejects.toThrow("还没有存下来");
      expect(queueProbe().current).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("在线限流后即使停留在同一页面也会继续补传", async () => {
    vi.useFakeTimers();
    try {
      await bindMemoOutboxAccount("stu-a", testClientServices);
      mockedText
        .mockRejectedValueOnce(new ApiError("RATE_LIMITED", "请求太频繁", 429))
        .mockResolvedValueOnce(memoOf("第一条"));
      await enqueueMemo(TEXT_INPUT);
      await flushMemoOutbox();
      expect(mockedText).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockedText).toHaveBeenCalledTimes(2);
      expect(queueProbe().current).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("在线：入队即上传成功，本机条目清掉，onMemoSynced 收到服务端那条", async () => {
    await bindMemoOutboxAccount("stu-a", testClientServices);
    const synced: Memo[] = [];
    const off = onMemoSynced((memo) => synced.push(memo));
    mockedText.mockResolvedValueOnce(memoOf("第一条"));
    await enqueueMemo(TEXT_INPUT);
    await flushMemoOutbox();
    expect(mockedText).toHaveBeenCalledTimes(1);
    const sent = mockedText.mock.calls[0]?.[0];
    expect(mockedText.mock.calls[0]?.[1]).toBe("stu-a");
    expect(sent?.text).toBe("第一条");
    expect(sent?.tags).toEqual(["易错"]);
    expect(typeof sent?.clientId).toBe("string");
    expect(synced).toHaveLength(1);
    expect(await backend.getAll('["memo-outbox","stu-a"')).toEqual([]);
    off();
  });

  it("离线：网络失败保留在本机；重新 bind 后按入队顺序补传且 clientId 不变", async () => {
    await bindMemoOutboxAccount("stu-a", testClientServices);
    mockedText.mockRejectedValue(new MemoNetworkError());
    const first = await enqueueMemo(TEXT_INPUT);
    const second = await enqueueMemo({ ...TEXT_INPUT, text: "第二条" });
    await flushMemoOutbox();
    expect(await backend.getAll('["memo-outbox","stu-a"')).toHaveLength(2);

    // 模拟刷新页面：状态清空、从本机载入
    installMemoOutboxBackendForTest(backend);
    mockedText.mockReset();
    mockedText.mockImplementation(async (input) => memoOf(input.text));
    await bindMemoOutboxAccount("stu-a", testClientServices);
    await flushMemoOutbox();
    expect(mockedText.mock.calls.map((call) => call[0].clientId)).toEqual([
      first,
      second,
    ]);
    expect(await backend.getAll('["memo-outbox","stu-a"')).toEqual([]);
  });

  it("业务拒绝（4xx）标 failedMessage、不再自动重试、可丢弃；后面的条目继续传", async () => {
    await bindMemoOutboxAccount("stu-a", testClientServices);
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
    await bindMemoOutboxAccount("stu-a", testClientServices);
    mockedText.mockRejectedValue(new MemoNetworkError());
    await enqueueMemo(TEXT_INPUT);
    await flushMemoOutbox();
    mockedText.mockReset();
    mockedText.mockImplementation(async (input) => memoOf(input.text));
    await bindMemoOutboxAccount("stu-b", testClientServices);
    await flushMemoOutbox();
    expect(mockedText).not.toHaveBeenCalled();
    expect(await backend.getAll('["memo-outbox","stu-a"')).toHaveLength(1);
  });
});

describe("memo-outbox：暂态失败与重试（#104-05）", () => {
  it.each([
    ["500", new ApiError("INTERNAL_ERROR", "服务器开小差", 500)],
    ["429", new ApiError("RATE_LIMITED", "请求太频繁", 429)],
    ["408", new ApiError("TIMEOUT", "请求超时", 408)],
    [
      "401（会话过期，重新登录后补传）",
      new ApiError("UNAUTHORIZED", "请先登录", 401),
    ],
    ["响应异常（非 ApiError）", new Error("服务器响应异常（HTTP 502）")],
  ])("%s：不标失败、保留原样，下次触发继续补传", async (_label, err) => {
    await bindMemoOutboxAccount("stu-a", testClientServices);
    mockedText.mockRejectedValue(err);
    const probe = queueProbe();
    await act(async () => {
      await enqueueMemo(TEXT_INPUT);
      await flushMemoOutbox();
    });
    expect(mockedText).toHaveBeenCalled();
    expect(probe.current).toHaveLength(1);
    expect(probe.current[0]?.failedMessage).toBeUndefined();
    const stored = await backend.getAll('["memo-outbox","stu-a"');
    expect(
      (stored[0]?.[1] as { failedMessage?: string } | undefined)?.failedMessage,
    ).toBeUndefined();

    const attemptsBefore = mockedText.mock.calls.length;
    mockedText.mockImplementation(async (input) => memoOf(input.text));
    await act(async () => {
      await flushMemoOutbox();
    });
    expect(mockedText).toHaveBeenCalledTimes(attemptsBefore + 1);
    expect(probe.current).toEqual([]);
  });

  it("业务拒绝后 retryMemoOutboxItem：清掉失败标记并重新上传", async () => {
    await bindMemoOutboxAccount("stu-a", testClientServices);
    mockedText.mockRejectedValueOnce(
      new ApiError("VALIDATION_ERROR", "标签太多", 400),
    );
    const probe = queueProbe();
    let clientId = "";
    await act(async () => {
      clientId = await enqueueMemo(TEXT_INPUT);
      await flushMemoOutbox();
    });
    expect(probe.current[0]?.failedMessage).toBe("标签太多");

    // 服务端仍拒绝：重试一次后再次标失败，不会无限重试
    mockedText.mockRejectedValueOnce(
      new ApiError("VALIDATION_ERROR", "标签太多", 400),
    );
    await act(async () => {
      await retryMemoOutboxItem(clientId);
    });
    expect(mockedText).toHaveBeenCalledTimes(2);
    expect(probe.current[0]?.failedMessage).toBe("标签太多");

    // 服务端放行：重试成功，条目清掉、本机键删掉
    mockedText.mockImplementation(async (input) => memoOf(input.text));
    await act(async () => {
      await retryMemoOutboxItem(clientId);
    });
    expect(mockedText).toHaveBeenCalledTimes(3);
    expect(probe.current).toEqual([]);
    expect(await backend.getAll('["memo-outbox","stu-a"')).toEqual([]);
  });

  it("同账号一轮补传在途时点重试：等这一轮结束后再来一轮，被重试那条真的重传", async () => {
    await bindMemoOutboxAccount("stu-a", testClientServices);
    const probe = queueProbe();
    // X 先被业务拒绝；Y 的上传挂起（模拟大语音在传）
    let releaseY: (memo: Memo) => void = () => {};
    mockedText.mockImplementation((input) => {
      if (input.text === "X") {
        return Promise.reject(
          new ApiError("VALIDATION_ERROR", "标签太多", 400),
        );
      }
      return new Promise<Memo>((resolve) => {
        releaseY = resolve;
      });
    });
    let xId = "";
    await act(async () => {
      xId = await enqueueMemo({ ...TEXT_INPUT, text: "X" });
      await enqueueMemo({ ...TEXT_INPUT, text: "Y" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(probe.current.find((it) => it.text === "X")?.failedMessage).toBe(
      "标签太多",
    );
    expect(mockedText).toHaveBeenCalledTimes(2);

    // Y 还在传时点 X 的「重试」：此时不应再发请求（在途一轮已跳过 X）
    mockedText.mockImplementation(async (input) => memoOf(input.text));
    let retryDone = false;
    await act(async () => {
      void retryMemoOutboxItem(xId).then(() => {
        retryDone = true;
      });
      await Promise.resolve();
    });
    expect(
      probe.current.find((it) => it.text === "X")?.failedMessage,
    ).toBeUndefined();
    expect(mockedText).toHaveBeenCalledTimes(2);
    expect(retryDone).toBe(false);

    // Y 传完：接力的一轮把 X 传上去，队列清空
    await act(async () => {
      releaseY(memoOf("Y"));
    });
    await vi.waitFor(() => expect(retryDone).toBe(true));
    expect(mockedText).toHaveBeenCalledTimes(3);
    expect(mockedText.mock.calls[2]?.[0].text).toBe("X");
    expect(probe.current).toEqual([]);
  });
});

describe("memo-outbox：重新保存复用 clientId", () => {
  it("enqueueMemo 带 clientId：本机键与上传请求都用它（响应丢失后重发命中幂等键）", async () => {
    await bindMemoOutboxAccount("stu-a", testClientServices);
    mockedText.mockImplementation(async (input) => memoOf(input.text));
    const clientId = "11111111-1111-4111-8111-111111111111";
    await act(async () => {
      await expect(enqueueMemo({ ...TEXT_INPUT, clientId })).resolves.toBe(
        clientId,
      );
      await flushMemoOutbox();
    });
    expect(mockedText.mock.calls[0]?.[0].clientId).toBe(clientId);
  });
});

describe("memo-outbox：本机写入失败（#104-02）", () => {
  it("本机写不进、上传也失败：拒绝并说明，不留内存条目（避免恢复输入后重发成两条）", async () => {
    installMemoOutboxBackendForTest(brokenSetBackend(backend));
    await bindMemoOutboxAccount("stu-a", testClientServices);
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
    await bindMemoOutboxAccount("stu-a", testClientServices);
    mockedText.mockRejectedValue(
      new ApiError("VALIDATION_ERROR", "正文超过 5000 字", 400),
    );
    await expect(enqueueMemo(TEXT_INPUT)).rejects.toThrow(/正文超过 5000 字/);
  });

  it("本机写不进但上传成功：正常返回，onMemoSynced 收到那条", async () => {
    installMemoOutboxBackendForTest(brokenSetBackend(backend));
    await bindMemoOutboxAccount("stu-a", testClientServices);
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
    await bindMemoOutboxAccount("stu-a", testClientServices);
    mockedText.mockImplementation(async (input) => memoOf(input.text));
    const probe = queueProbe();

    let pending: Promise<string> | undefined;
    await act(async () => {
      pending = enqueueMemo(TEXT_INPUT);
      await bindMemoOutboxAccount("stu-b", testClientServices);
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
      await bindMemoOutboxAccount("stu-a", testClientServices);
      await flushMemoOutbox();
    });
    expect(mockedText).toHaveBeenCalledTimes(1);
    expect(mockedText.mock.calls[0]?.[0].text).toBe("第一条");
  });

  it("补传在途时换账号：成功结果不通知、不动新队列，只清旧账号的本机键", async () => {
    await bindMemoOutboxAccount("stu-a", testClientServices);
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
      await bindMemoOutboxAccount("stu-b", testClientServices);
      finishUpload(memoOf("第一条"));
      await flushMemoOutbox();
    });
    expect(synced).toEqual([]);
    expect(probe.current).toEqual([]);
    expect(await backend.getAll('["memo-outbox","stu-a"')).toEqual([]);
    off();
  });

  it("补传在途时换账号：业务拒绝只标到旧账号的本机键，新账号队列不受影响", async () => {
    await bindMemoOutboxAccount("stu-a", testClientServices);
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
      await bindMemoOutboxAccount("stu-b", testClientServices);
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
    await bindMemoOutboxAccount("stu-b", testClientServices);
    mockedText.mockRejectedValue(new MemoNetworkError());
    await enqueueMemo({ ...TEXT_INPUT, text: "乙的离线条目" });
    await flushMemoOutbox();
    expect(await backend.getAll('["memo-outbox","stu-b"')).toHaveLength(1);
    mockedText.mockReset();
    // 甲登录并有一条上传挂起；此时切回乙
    await bindMemoOutboxAccount("stu-a", testClientServices);
    let finishUpload: (memo: Memo) => void = () => {};
    mockedText.mockImplementationOnce(
      () =>
        new Promise<Memo>((resolve) => {
          finishUpload = resolve;
        }),
    );
    await enqueueMemo({ ...TEXT_INPUT, text: "甲的在途条目" });
    mockedText.mockImplementation(async (input) => memoOf(input.text));
    const rebind = bindMemoOutboxAccount("stu-b", testClientServices);
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

const sourceAttempt = crypto.randomUUID();
const sourceRevision = crypto.randomUUID();
const sourceReference = {
  kind: "question" as const,
  attemptId: sourceAttempt,
  questionId: "q2",
  surface: "attempt" as const,
  expectedQuestionRevisionId: sourceRevision,
};
const sourceAnchor = {
  kind: "question" as const,
  attemptId: sourceAttempt,
  questionId: "q2",
  label: "第 2 题",
};
const canonicalSource: LearningContext = {
  schemaVersion: 1,
  content: {
    courseId: null,
    unitId: null,
    lectureId: null,
    sectionId: null,
    questionId: "q2",
    titles: { course: null, unit: null, lecture: null },
  },
  session: {
    attemptId: sourceAttempt,
    questionRevisionId: sourceRevision,
    questionNo: 2,
    questionCount: 2,
    settlementSeq: null,
  },
  view: null,
  deviceId: null,
};

it("来源canonical仍在网络等待时已经本机入队，回执使用原题/真实设备/打开view", async () => {
  await bindMemoOutboxAccount("stu-a", testClientServices);
  let resolve!: (context: LearningContext) => void;
  mockedResolve.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const sourceView = {
    surface: "attempt" as const,
    layout: "list",
    viewId: crypto.randomUUID(),
  };
  const deviceId = crypto.randomUUID();
  mockedText.mockResolvedValueOnce(memoOf("第二题"));
  const clientId = await enqueueMemo({
    ...TEXT_INPUT,
    text: "第二题",
    anchor: sourceAnchor,
    reference: sourceReference,
    sourceDisplay: { questionNo: 2, questionCount: 2 },
    sourceView,
    deviceId,
    sourcePrincipal: "stu-a",
  });
  expect(mockedText).not.toHaveBeenCalled();
  expect(await backend.getAll('["memo-outbox","stu-a"')).toHaveLength(1);
  resolve(canonicalSource);
  await flushMemoOutbox();
  expect(mockedText).toHaveBeenCalledWith(
    expect.objectContaining({
      clientId,
      anchor: sourceAnchor,
      context: { ...canonicalSource, view: sourceView, deviceId },
      deviceId,
    }),
    "stu-a",
  );
});

it("expected revision不符保留原稿/原reference并拒绝静默重绑", async () => {
  await bindMemoOutboxAccount("stu-a", testClientServices);
  mockedResolve.mockRejectedValueOnce(
    new ApiError("LEARNING_CONTEXT_STALE", "题目来源已变化", 409),
  );
  const clientId = await enqueueMemo({
    ...TEXT_INPUT,
    anchor: sourceAnchor,
    reference: sourceReference,
  });
  await flushMemoOutbox();
  expect(mockedText).not.toHaveBeenCalled();
  const stored = await backend.getAll('["memo-outbox","stu-a"');
  expect(stored).toHaveLength(1);
  expect(stored[0]?.[1]).toMatchObject({
    clientId,
    reference: sourceReference,
    text: TEXT_INPUT.text,
    failedMessage: "题目来源已变化",
  });
});

it("已显示题序变化同样保留原稿，不能套新目录坐标", async () => {
  await bindMemoOutboxAccount("stu-a", testClientServices);
  mockedResolve.mockResolvedValueOnce(canonicalSource);
  await enqueueMemo({
    ...TEXT_INPUT,
    anchor: sourceAnchor,
    reference: sourceReference,
    sourceDisplay: { questionNo: 1, questionCount: 2 },
  });
  await flushMemoOutbox();
  expect(mockedText).not.toHaveBeenCalled();
  expect(queueProbe().current[0]?.failedMessage).toContain("题目来源已变化");
});

it("旧来源404只回退旧anchor，缺失context必须省略而非null", async () => {
  await bindMemoOutboxAccount("stu-a", testClientServices);
  mockedResolve.mockRejectedValueOnce(
    new ApiError("LEARNING_CONTEXT_NOT_FOUND", "来源不存在或不可见", 404),
  );
  mockedText.mockResolvedValueOnce(memoOf("第一条"));
  await enqueueMemo({
    ...TEXT_INPUT,
    anchor: sourceAnchor,
    reference: sourceReference,
  });
  await flushMemoOutbox();
  const body = mockedText.mock.calls[0]?.[0];
  expect(body?.anchor).toEqual(sourceAnchor);
  expect(Object.hasOwn(body ?? {}, "context")).toBe(false);
});

it("旧账号canonical迟到时不发送新账号请求，不把来源放进新队列", async () => {
  await bindMemoOutboxAccount("stu-a", testClientServices);
  let resolve!: (context: LearningContext) => void;
  mockedResolve.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await enqueueMemo({
    ...TEXT_INPUT,
    anchor: sourceAnchor,
    reference: sourceReference,
    sourcePrincipal: "stu-a",
  });
  await bindMemoOutboxAccount("stu-b", testClientServices);
  resolve(canonicalSource);
  await flushMemoOutbox();
  expect(mockedText).not.toHaveBeenCalled();
  expect(await backend.getAll('["memo-outbox","stu-a"')).toHaveLength(1);
  expect(await backend.getAll('["memo-outbox","stu-b"')).toEqual([]);
  await expect(
    enqueueMemo({ ...TEXT_INPUT, sourcePrincipal: "stu-a" }),
  ).rejects.toThrow("账号已变化");
});

it("媒体补传携带入队时真实context，不借用当前阅读源", async () => {
  await bindMemoOutboxAccount("stu-a", testClientServices);
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  mockedMedia.mockResolvedValueOnce(memoOf("图片"));
  await enqueueMemo({
    ...TEXT_INPUT,
    kind: "image",
    blob,
    anchor: sourceAnchor,
    context: canonicalSource,
  });
  await flushMemoOutbox();
  expect(mockedResolve).not.toHaveBeenCalled();
  expect(mockedMedia).toHaveBeenCalledWith(
    blob,
    expect.objectContaining({ anchor: sourceAnchor, context: canonicalSource }),
    "stu-a",
  );
});
it("A→B→A期间旧入队续体不能进入新A租约的内存队列", async () => {
  const gated = gatedSetBackend(backend);
  installMemoOutboxBackendForTest(gated.backend);
  await bindMemoOutboxAccount("stu-a", testClientServices);
  const probe = queueProbe();
  const saving = enqueueMemo(TEXT_INPUT);
  await act(async () => {
    await bindMemoOutboxAccount("stu-b", { ...testClientServices });
    await bindMemoOutboxAccount("stu-a", { ...testClientServices });
    gated.release();
    await saving;
  });
  expect(probe.current).toHaveLength(0);
  expect(
    await backend.getAll(JSON.stringify(["memo-outbox", "stu-a"]).slice(0, -1)),
  ).toHaveLength(1);
  expect(mockedText).not.toHaveBeenCalled();
});
