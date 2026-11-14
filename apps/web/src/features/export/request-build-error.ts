import { z } from "zod";
export function requestBuildErrorTextOf(err: unknown): string {
  if (err instanceof z.ZodError) {
    return `请求组装失败：${err.issues[0]?.message ?? "参数不合法"}`;
  }
  return err instanceof Error ? err.message : "请求组装失败，请稍后重试";
}
