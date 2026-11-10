import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceRecorder, type VoiceRecording } from "./use-voice-recorder";

/**
 * 语音录音 hook（审查修复 #104-03）：麦克风授权晚于取消 / 卸载返回时，不得再启动
 * recorder 与计时器，拿到的 stream 要全部停掉；正常开始 → 停止仍把 blob 交给回调。
 * jsdom 没有 MediaRecorder / getUserMedia，这里用可控的假实现。
 */

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>;
}

function fakeStream(): { stream: MediaStream; tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  return { stream, tracks };
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(): boolean {
    return true;
  }
  state: "inactive" | "recording" = "inactive";
  readonly mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly start = vi.fn(() => {
    this.state = "recording";
  });
  readonly stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
    this.onstop?.();
  });
  constructor() {
    FakeMediaRecorder.instances.push(this);
  }
}

/** 每次 getUserMedia 调用的挂起请求，测试决定何时、以什么结果返回 */
const userMediaRequests: Array<{
  resolve: (stream: MediaStream) => void;
  reject: (err: unknown) => void;
}> = [];
const getUserMedia = vi.fn(
  () =>
    new Promise<MediaStream>((resolve, reject) => {
      userMediaRequests.push({ resolve, reject });
    }),
);
function settleUserMedia(index: number): {
  resolve: (stream: MediaStream) => void;
  reject: (err: unknown) => void;
} {
  const request = userMediaRequests[index];
  if (request === undefined) throw new Error(`没有第 ${index} 次授权请求`);
  return request;
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  userMediaRequests.length = 0;
  getUserMedia.mockClear();
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useVoiceRecorder", () => {
  it("正常：开始 → 停止，回调收到 blob 与时长，stream 停掉", async () => {
    const onComplete = vi.fn<(recording: VoiceRecording) => void>();
    const { result } = renderHook(() => useVoiceRecorder(onComplete));
    const { stream, tracks } = fakeStream();
    await act(async () => {
      void result.current.start();
    });
    expect(result.current.state.status).toBe("requesting");
    await act(async () => {
      settleUserMedia(0).resolve(stream);
    });
    expect(result.current.state.status).toBe("recording");
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeMediaRecorder.instances[0]?.start).toHaveBeenCalledWith(1000);

    await act(async () => {
      result.current.stop();
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]?.[0].blob.size).toBe(3);
    expect(onComplete.mock.calls[0]?.[0].durationSec).toBeGreaterThanOrEqual(1);
    expect(result.current.state.status).toBe("idle");
    for (const track of tracks) expect(track.stop).toHaveBeenCalled();
  });

  it("授权晚于取消：不构造 recorder、不计时，拿到的 stream 全部停掉，状态仍 idle", async () => {
    const onComplete = vi.fn<(recording: VoiceRecording) => void>();
    const { result } = renderHook(() => useVoiceRecorder(onComplete));
    const { stream, tracks } = fakeStream();
    await act(async () => {
      void result.current.start();
    });
    await act(async () => {
      result.current.cancel();
    });
    expect(result.current.state.status).toBe("idle");
    await act(async () => {
      settleUserMedia(0).resolve(stream);
    });
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe("idle");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("授权晚于卸载（弹窗关闭 / 离开页面）：同样不启动，stream 停掉", async () => {
    const onComplete = vi.fn<(recording: VoiceRecording) => void>();
    const { result, unmount } = renderHook(() => useVoiceRecorder(onComplete));
    const { stream, tracks } = fakeStream();
    await act(async () => {
      void result.current.start();
    });
    unmount();
    await act(async () => {
      settleUserMedia(0).resolve(stream);
    });
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("授权被拒晚于取消：不再把错误写进状态", async () => {
    const { result } = renderHook(() => useVoiceRecorder(vi.fn()));
    await act(async () => {
      void result.current.start();
    });
    await act(async () => {
      result.current.cancel();
    });
    await act(async () => {
      settleUserMedia(0).reject(
        Object.assign(new Error("denied"), { name: "NotAllowedError" }),
      );
    });
    expect(result.current.state.status).toBe("idle");
  });

  it("取消后再授权、再开始：新一次请求正常录音", async () => {
    const onComplete = vi.fn<(recording: VoiceRecording) => void>();
    const { result } = renderHook(() => useVoiceRecorder(onComplete));
    const stale = fakeStream();
    await act(async () => {
      void result.current.start();
    });
    await act(async () => {
      result.current.cancel();
    });
    const fresh = fakeStream();
    await act(async () => {
      void result.current.start();
    });
    await act(async () => {
      settleUserMedia(1).resolve(fresh.stream);
    });
    expect(result.current.state.status).toBe("recording");
    // 旧请求的授权此时才回来：已作废，只停掉它的 stream，不打断正在进行的录音
    await act(async () => {
      settleUserMedia(0).resolve(stale.stream);
    });
    expect(result.current.state.status).toBe("recording");
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    for (const track of stale.tracks)
      expect(track.stop).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.current.stop();
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    for (const track of fresh.tracks) expect(track.stop).toHaveBeenCalled();
  });

  it("录音中 recorder 报错：状态转「录音中断」、stream 停掉；取消后补发的 error 不再改状态", async () => {
    const onComplete = vi.fn<(recording: VoiceRecording) => void>();
    const { result } = renderHook(() => useVoiceRecorder(onComplete));
    const first = fakeStream();
    await act(async () => {
      void result.current.start();
    });
    await act(async () => {
      settleUserMedia(0).resolve(first.stream);
    });
    const recorder = FakeMediaRecorder.instances[0];
    await act(async () => {
      recorder?.onerror?.();
    });
    expect(result.current.state.status).toBe("error");
    for (const track of first.tracks) expect(track.stop).toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();

    // 再开始一次，然后取消：取消把 onerror 摘掉；即使浏览器补发 error 也不覆盖 idle
    const second = fakeStream();
    await act(async () => {
      void result.current.start();
    });
    await act(async () => {
      settleUserMedia(1).resolve(second.stream);
    });
    const recorder2 = FakeMediaRecorder.instances[1];
    const staleOnError = recorder2?.onerror;
    await act(async () => {
      result.current.cancel();
    });
    expect(recorder2?.onerror).toBeNull();
    await act(async () => {
      staleOnError?.();
    });
    expect(result.current.state.status).toBe("idle");
  });
});
