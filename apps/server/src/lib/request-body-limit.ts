import type { ApiErr } from "@tutor/contract";
import type { Context, Next } from "hono";
import { HttpError } from "./http-error.ts";

/** 保留背压，累计字节过限后停止读取，上游连接由 HTTP 适配器收尾。 */
export function capBodyStream(
  source: ReadableStream<Uint8Array>,
  limit: number,
  onLimit: () => Error,
): ReadableStream<Uint8Array> {
  let bytes = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > limit) controller.error(onLimit());
        else controller.enqueue(chunk);
      },
    }),
    // 防止取消与 Node 进程内 FormData 的异步分段编码发生竞态。
    { preventCancel: true },
  );
}

export function guardBodyLimit(config: {
  method: "PUT" | "POST";
  limit: number;
  code: string;
  message: string;
}) {
  return async (c: Context, next: Next) => {
    if (c.req.method !== config.method) return next();
    const error: ApiErr = {
      ok: false,
      error: config.code,
      message: config.message,
    };
    const length = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(length) && length > config.limit)
      return c.json(error, 413);
    const source = c.req.raw.body;
    if (source === null) return next();
    let exceeded = false;
    const body = capBodyStream(source, config.limit, () => {
      exceeded = true;
      return new HttpError(413, config.code, config.message);
    });
    const init = { body, duplex: "half" as const };
    c.req.raw = new Request(c.req.raw, init);
    await next();
    // multipart 等解析器可能包装流错误，仍按入口的超限口径返回。
    if (exceeded && c.res.status !== 413) c.res = c.json(error, 413);
    return;
  };
}
