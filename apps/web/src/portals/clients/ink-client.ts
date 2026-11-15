import type { InkDoc, InkUploadData } from "@tutor/contract";
import type { GzipJsonMessages } from "@/features/runtime/client-types";
import {
  ApiError,
  callApi,
  isAbortReason,
  throwShellError,
} from "@/lib/api-response";
import { withRequestDeadline } from "@/lib/request-deadline";
import { combineScopeSignal } from "../response-scope";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createInkClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api, fetch } = http;
  async function fetchAttemptInkApi(
    attemptId: string,
    questionId: string,
  ): Promise<InkDoc | null> {
    try {
      return await callApi<InkDoc>(() =>
        api.api.student.attempts[":id"].ink[":questionId"].$get({
          param: { id: attemptId, questionId },
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === "INK_NOT_FOUND") return null;
      throw err;
    }
  }
  function putAttemptInkApi(
    attemptId: string,
    questionId: string,
    strokesGzip: Blob,
    snapshotPng: Blob,
    meta?: import("@tutor/contract").InkWriteMeta,
  ): Promise<InkUploadData> {
    const form = new FormData();
    form.append("strokes", strokesGzip, "strokes.json.gz");
    form.append("snapshot", snapshotPng, "snapshot.png");
    if (meta) form.append("meta", JSON.stringify(meta));
    return withRequestDeadline(
      (signal) =>
        callApi(() =>
          fetch(
            `/api/student/attempts/${encodeURIComponent(attemptId)}/ink/${encodeURIComponent(questionId)}`,
            { method: "PUT", body: form, signal },
          ),
        ),
      "上传正式手写",
    );
  }
  function studentInkPngUrl(attemptId: string, questionId: string): string {
    return `/api/student/attempts/${encodeURIComponent(attemptId)}/ink/${encodeURIComponent(questionId)}.png`;
  }
  async function fetchGzipJson(
    path: string,
    msg: GzipJsonMessages,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const current = combineScopeSignal(http.signal, signal ?? null);
    try {
      current.signal.throwIfAborted();
      let res: Response;
      try {
        res = await fetch(path, { signal: current.signal });
      } catch (error) {
        current.signal.throwIfAborted();
        if (isAbortReason(error)) throw error;
        throw new Error(msg.network);
      }
      if (!res.ok) {
        await throwShellError(res);
      }
      if (typeof DecompressionStream === "undefined") {
        // 上传侧（gzipOrRaw）有原始 JSON 回退；解压消费只在支持的环境提供
        throw new Error(msg.unsupported);
      }
      // 无字节流按传输层异常归因（浏览器保证 2xx 响应有 body——复审轮⑤）
      if (res.body === null) {
        throw new Error(msg.network);
      }
      let text: string;
      try {
        text = await new Response(
          res.body.pipeThrough(new DecompressionStream("gzip"), {
            signal: current.signal,
          }),
        ).text();
      } catch (err) {
        current.signal.throwIfAborted();
        if (isAbortReason(err)) throw err;
        // 读流阶段失败的归因启发式（复审轮⑤）：gzip 坏块与网络中断在这里同为
        // 异常、无可靠类型区分——按错误文案归类：已知网络类字样 → 网络错误
        // 文案；其余（含各实现的解压错误）→ 解压失败文案。
        const detail = err instanceof Error ? err.message : String(err);
        if (/terminated|aborted|network|fetch failed/i.test(detail)) {
          throw new Error(msg.network);
        }
        throw new Error(msg.decompress);
      }
      current.signal.throwIfAborted();
      try {
        const result: unknown = JSON.parse(text);
        current.signal.throwIfAborted();
        return result;
      } catch {
        current.signal.throwIfAborted();
        throw new Error(msg.corrupt);
      }
    } finally {
      current.finish();
    }
  }
  function fetchTeacherInkStrokesApi(inkId: string): Promise<unknown> {
    return fetchGzipJson(
      `/api/teacher/ink/${encodeURIComponent(inkId)}.json.gz`,
      {
        network:
          "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
        unsupported: "当前浏览器不支持笔迹回放（缺少 DecompressionStream）",
        decompress: "笔迹矢量数据解压失败（文件可能损坏），请刷新重试",
        corrupt: "笔迹矢量数据损坏（不是合法的 JSON），请反馈老师处理",
      },
    );
  }
  return {
    fetchAttemptInkApi,
    putAttemptInkApi,
    studentInkPngUrl,
    fetchTeacherInkStrokesApi,
    fetchGzipJson,
  };
}
