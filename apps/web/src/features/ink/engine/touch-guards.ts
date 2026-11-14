/**
 * 书写面的触摸与误触防护：touchstart / touchmove / contextmenu / selectstart
 * 四个监听。草稿纸（atrament-adapter）与圈画（annotation-surface）共用。
 *
 * "笔写字、手指滚动"的触摸侧（§5.4.1 输入层第 3 条，T6R.7 改为遍历）：
 * **遍历触点核对 touchType**，不默认 touches[0] 是笔。拦截条件＝新旧并集
 * （复审②）：changedTouches 含 stylus（笔这一触点新落下——手掌先落、笔
 * 第二个落下的场景里 changedTouches 才含笔）**或** e.touches 含 stylus
 * （笔已在屏书写、手掌后落——该触摸事件同样可能引发原生滚动/缩放破坏
 * 笔迹，须拦截）。纯 direct 触摸不拦截，配合 touch-action: pan-y 由
 * 浏览器原生滚动页面。
 * 🧑 真机复核：stylus 拦截在 HTTP/HTTPS 下行为一致（清单第 1 项）；笔先
 * 落手掌后落（清单第 14 项）。
 */

/** 触点表里有没有笔 */
export function anyStylusTouch(
  touches: TouchList | Array<{ touchType?: string }> | undefined,
): boolean {
  // 防御：合成/不完整事件可能缺某一触点列表（真实 TouchEvent 恒两者皆有）
  if (touches === undefined) return false;
  for (let i = 0; i < touches.length; i++) {
    const t = touches[i] as { touchType?: string } | undefined;
    if (t?.touchType === "stylus") return true;
  }
  return false;
}

export interface TouchGuards {
  onTouchStart(e: TouchEvent): void;
  onTouchMove(e: TouchEvent): void;
  onContextMenu(e: Event): void;
  onSelectStart(e: Event): void;
}

/**
 * @param onStylus 触摸事件里见到笔时调用（书写面据此记下「见过笔」并刷新
 * touch-action），在 preventDefault 之前
 */
export function createTouchGuards(onStylus: () => void): TouchGuards {
  return {
    onTouchStart(e): void {
      if (!anyStylusTouch(e.changedTouches) && !anyStylusTouch(e.touches)) {
        return;
      }
      onStylus();
      e.preventDefault();
    },
    onTouchMove(e): void {
      if (anyStylusTouch(e.changedTouches) || anyStylusTouch(e.touches)) {
        e.preventDefault();
      }
    },
    onContextMenu(e): void {
      e.preventDefault(); // 防长按弹出系统菜单/放大镜
    },
    onSelectStart(e): void {
      e.preventDefault(); // 防长按选择文字
    },
  };
}
