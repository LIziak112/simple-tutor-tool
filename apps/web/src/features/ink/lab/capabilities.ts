/**
 * 运行时能力探测（T6R.1 从面板下沉的纯检测层）。
 *
 * 全部基于对象/原型/真实 context 属性的存在性，**不读 navigator.userAgent**
 * （方案 §4.1：不以 UA 推断能力）。检测与展示分离：本模块只产出结构化结果，
 * 中文文案由 UI 层映射——产品侧（T6R.6 渲染器、T6R.8 输入管线）将来做能力
 * 决策时从这里取判断，不必再抄表达式。
 */

export type SupportStatus = "yes" | "no" | "unknown";

export interface CapabilitySnapshot {
  /** 页面协议（信息项，如 "http:" / "https:"；不可得为 null） */
  protocol: string | null;
  /** 合并采样：PointerEvent 原型上是否有 getCoalescedEvents */
  coalescedEvents: boolean;
  /** pointerrawupdate（Chromium 系；Safari/Firefox 无） */
  pointerrawupdate: boolean;
  /** Ink API：navigator.ink（Chromium 旗标级） */
  inkApi: boolean;
  /** canvas desynchronized：真实取一次 2d context 读回属性（不猜） */
  canvasDesynchronized: SupportStatus;
  /** 剪贴板对象存在性（实际可用还取决于安全上下文与用户手势） */
  clipboard: boolean;
}

export function probeCapabilities(): CapabilitySnapshot {
  const coalescedEvents =
    typeof PointerEvent !== "undefined" &&
    "getCoalescedEvents" in PointerEvent.prototype;
  const pointerrawupdate =
    typeof window !== "undefined" && "onpointerrawupdate" in window;
  const inkApi = typeof navigator !== "undefined" && "ink" in navigator;

  let canvasDesynchronized: SupportStatus = "unknown";
  try {
    const probe = document.createElement("canvas");
    const ctx = probe.getContext("2d", {
      desynchronized: true,
    }) as
      | (CanvasRenderingContext2D & {
          getContextAttributes?: () => { desynchronized?: boolean };
        })
      | null;
    if (ctx) {
      if (typeof ctx.getContextAttributes === "function") {
        const attrs = ctx.getContextAttributes();
        canvasDesynchronized =
          typeof attrs.desynchronized === "boolean"
            ? attrs.desynchronized
              ? "yes"
              : "no"
            : "unknown"; // 返回对象缺键：探测不到 ≠ 明确不支持
      }
    }
  } catch {
    // 探测本身失败：保持"未知"，不抛错
  }

  return {
    protocol:
      typeof location !== "undefined" && location.protocol
        ? location.protocol
        : null,
    coalescedEvents,
    pointerrawupdate,
    inkApi,
    canvasDesynchronized,
    clipboard:
      typeof navigator !== "undefined" && navigator.clipboard !== undefined,
  };
}
