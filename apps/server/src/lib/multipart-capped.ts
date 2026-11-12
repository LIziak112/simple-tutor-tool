import type { Context } from "hono";
import { HttpError } from "./http-error";
import { capBodyStream } from "./request-body-limit.ts";

/**
 * 带流式计数上限的 multipart/form-data 解析（审查 #103-01）。
 *
 * 此解析器可独立使用，挂载层与解析器共用请求流限额实现。c.req.raw.body
 * 经计数 TransformStream 后交给 Response.formData() 解析：累计字节一过
 * limitBytes 就 controller.error() 停止读取上游，映射为
 * 413 {code, message}；已读入的至多 limitBytes + 一个 chunk。
 *
 * 非 multipart content-type / 没有请求体 / 坏 multipart → 400 VALIDATION_ERROR
 * （与各路由此前「缺 file 字段 400」同口径，文案由调用方的缺 file 分支复用）。
 */

export interface MultipartCap {
  /** 整个请求体（文件 + 文本字段 + 边界）的字节上限 */
  readonly limitBytes: number;
  /** 超限时的错误码（与 app.ts 同路由 content-length 预检一致） */
  readonly code: string;
  readonly message: string;
}

/** 超限哨兵：只在本模块内流转，出口统一换成 HttpError */
class MultipartBodyTooLarge extends Error {
  constructor() {
    super("multipart body too large");
    this.name = "MultipartBodyTooLarge";
  }
}

export const MULTIPART_REQUIRED_MESSAGE =
  "请求需为 multipart/form-data，且包含名为 file 的文件字段";

export async function parseMultipartCapped(
  c: Context,
  cap: MultipartCap,
): Promise<FormData> {
  const contentType = c.req.header("content-type") ?? "";
  const source = c.req.raw.body;
  if (
    !contentType.toLowerCase().startsWith("multipart/form-data") ||
    source === null
  ) {
    throw new HttpError(400, "VALIDATION_ERROR", MULTIPART_REQUIRED_MESSAGE);
  }
  const capped = capBodyStream(
    source,
    cap.limitBytes,
    () => new MultipartBodyTooLarge(),
  );
  try {
    return await new Response(capped, {
      headers: { "content-type": contentType },
    }).formData();
  } catch (err) {
    if (err instanceof MultipartBodyTooLarge) {
      throw new HttpError(413, cap.code, cap.message);
    }
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "请求体不是合法的 multipart/form-data",
    );
  }
}

/**
 * FormData → 普通对象（同名字段后者覆盖前者，与 Hono parseBody 缺省口径一致），
 * 让既有「按字段名取字符串」的路由代码不必改写。
 */
export function formDataToRecord(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  form.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
