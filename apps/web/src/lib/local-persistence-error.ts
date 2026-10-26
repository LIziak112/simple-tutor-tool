/** 存储错误只展示原因，不带原稿、账号或存储键；兼容跨窗口 DOMException。 */
export function persistenceErrorName(error: unknown): string {
  if (typeof error === "string") return "Error";
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
    ? error.name
    : "UnknownError";
}

export function localPersistenceErrorMessage(error: unknown): string {
  switch (persistenceErrorName(error)) {
    case "QuotaExceededError":
      return "本机存储空间不足，请释放设备空间后重试；不要清除此网站的数据";
    case "InvalidStateError":
    case "UnknownError":
    case "AbortError":
      return "本机存储连接异常或写入中断，请保持页面打开并重试";
    case "SecurityError":
    case "NotAllowedError":
      return "浏览器未允许本机存储，请检查网站存储权限后重试";
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message.trim() && !["null", "undefined"].includes(message.trim())
    ? message
    : "本机存储操作失败，请保持页面打开并重试";
}
