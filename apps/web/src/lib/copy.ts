/**
 * 复制文本到剪贴板，带 HTTP 环境降级。
 * navigator.clipboard 仅在安全上下文（https / localhost）可用；本工具常部署在
 * 公网 IP + HTTP（§5.10 备案前临时方案），必须降级到隐藏 textarea + execCommand。
 * 返回是否复制成功，调用方据此提示「已复制」或「复制失败，请手动复制」。
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒等：继续走降级路径
    }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    // 移出视口且透明，避免页面闪烁/滚动跳动
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 把 PNG Blob 写入剪贴板（合成图「复制图片」辅助出口，T6R.19）：
 * navigator.clipboard.write + ClipboardItem 仅安全上下文（HTTPS/localhost）
 * 且浏览器支持时可用——任一不可用或写入被拒都返回 false（调用方提示改用
 * 下载文件，绝不显示「已复制」）。与 copyText 的降级纪律同口径。
 *
 * ClipboardItem 构造值传 Promise<Blob> 形态：Chromium 两种都接受，WebKit
 * 仅接受 Promise（传同步 Blob 在 Safari 抛 TypeError）。注意 clipboard.write
 * 还要求 transient activation（用户手势激活窗口）——导出耗时数秒后窗口可能
 * 已过期，该约束无法代码解决，只能诚实降级（返回 false）。
 */
export async function copyPngBlobToClipboard(blob: Blob): Promise<boolean> {
  const clipboard = (
    navigator as {
      clipboard?: { write?: (items: unknown[]) => Promise<void> };
    }
  ).clipboard;
  const ClipboardItemCtor = (
    globalThis as {
      ClipboardItem?: new (
        items: Record<string, Blob | Promise<Blob>>,
      ) => unknown;
    }
  ).ClipboardItem;
  if (clipboard?.write === undefined || ClipboardItemCtor === undefined) {
    return false;
  }
  try {
    await clipboard.write([
      new ClipboardItemCtor({ "image/png": Promise.resolve(blob) }),
    ]);
    return true;
  } catch {
    return false;
  }
}
