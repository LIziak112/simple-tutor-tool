export function saveBlobAs(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // revoke 延迟到下一轮宏任务（/code-review 角A）：Safari/WebKit 在同轮
    // 事件里 revoke 会导致下载拿到空 blob（iPad 支持面的已知怪癖）
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
