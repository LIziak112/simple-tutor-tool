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
