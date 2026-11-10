import { MEMO_VOICE_MAX_SECONDS } from "@tutor/contract";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 语音随笔录音（模块 5 第一步；问题清单 Q16：原格式存、不转码）：
 * - MediaRecorder 用浏览器自己选的容器——Safari / iOS 是 audio/mp4（AAC），
 *   Chrome / Firefox 是 audio/webm 或 audio/ogg（Opus）；服务端按内容识别；
 * - 计时到 MEMO_VOICE_MAX_SECONDS（10 分钟）自动停止；界面建议单条 ≤ 5 分钟；
 * - 没有麦克风权限 / 不支持 MediaRecorder 给中文说明，不抛裸异常；
 * - 每次 start 领一个请求序号，取消 / 卸载让序号作废：授权晚于取消才返回时不再
 *   启动 recorder 与计时器，拿到的 stream 直接停掉，也不会把结果交给入队回调。
 */
export interface VoiceRecording {
  readonly blob: Blob;
  readonly durationSec: number;
}

export type VoiceRecorderState =
  | { readonly status: "idle" }
  | { readonly status: "requesting" }
  | { readonly status: "recording"; readonly elapsedSec: number }
  | { readonly status: "error"; readonly message: string };

const PREFERRED_TYPES = [
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

export function isVoiceRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    navigator.mediaDevices !== undefined &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function permissionMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "没有麦克风权限：请在浏览器地址栏允许使用麦克风后重试";
  }
  if (name === "NotFoundError") return "没有找到麦克风设备";
  return "录音启动失败，请稍后重试";
}

export function useVoiceRecorder(
  onComplete: (recording: VoiceRecording) => void,
) {
  const [state, setState] = useState<VoiceRecorderState>({ status: "idle" });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  /** 当前有效的录音请求序号；cleanup 递增使仍在等授权的 start 作废 */
  const requestSeqRef = useRef(0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const cleanup = useCallback(() => {
    requestSeqRef.current += 1;
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder === null || recorder.state === "inactive") return;
    recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (!isVoiceRecordingSupported()) {
      setState({
        status: "error",
        message: "这个浏览器不支持录音，请改用文字或换 Safari / Chrome",
      });
      return;
    }
    const seq = ++requestSeqRef.current;
    setState({ status: "requesting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // 等授权期间已取消 / 卸载：不再改状态
      if (seq !== requestSeqRef.current) return;
      setState({ status: "error", message: permissionMessage(err) });
      return;
    }
    if (seq !== requestSeqRef.current) {
      // 授权晚于取消 / 卸载才回来：不启动，只把拿到的麦克风放掉
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder =
        mimeType === undefined
          ? new MediaRecorder(stream)
          : new MediaRecorder(stream, { mimeType });
    } catch {
      for (const track of stream.getTracks()) track.stop();
      setState({ status: "error", message: "录音启动失败，请稍后重试" });
      return;
    }
    chunksRef.current = [];
    streamRef.current = stream;
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      // 已被取消的请求（cancel 会先摘掉 onstop，这里再兜一层）：不入队
      if (seq !== requestSeqRef.current) return;
      const durationSec = Math.min(
        MEMO_VOICE_MAX_SECONDS,
        Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000)),
      );
      const type = recorder.mimeType || mimeType || "application/octet-stream";
      const blob = new Blob(chunksRef.current, { type });
      cleanup();
      setState({ status: "idle" });
      if (blob.size > 0) onCompleteRef.current({ blob, durationSec });
    };
    recorder.onerror = () => {
      cleanup();
      setState({ status: "error", message: "录音中断，请重试" });
    };
    startedAtRef.current = Date.now();
    recorder.start(1000);
    setState({ status: "recording", elapsedSec: 0 });
    timerRef.current = window.setInterval(() => {
      const elapsedSec = Math.round((Date.now() - startedAtRef.current) / 1000);
      setState({ status: "recording", elapsedSec });
      if (elapsedSec >= MEMO_VOICE_MAX_SECONDS) stop();
    }, 500);
  }, [cleanup, stop]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder !== null && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    cleanup();
    setState({ status: "idle" });
  }, [cleanup]);

  useEffect(() => cancel, [cancel]);

  return { state, start, stop, cancel };
}
