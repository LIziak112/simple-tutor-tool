/**
 * 回放的 atrament canvas 绘制薄层（T3.3）。
 *
 * 只负责「把 frameAt 的结果画上 canvas」：清屏 → 按可见点数截断每笔 → 复用
 * 引擎层导出的 replayAtramentStroke（与实时书写/全量重绘同一绘制原语）。
 * 全量重绘口径与 atrament-adapter.redraw 一致——荧光笔带 alpha，增量补画会
 * 叠深颜色，因此每帧整幅重来（题级笔迹量小，60fps 可承受）。
 *
 * jsdom 无 canvas 2d context，本模块刻意保持薄且不写单测；时间轴与截断逻辑
 * 在 model.ts 纯函数层已测。组件测试以 vi.mock 替换本模块。
 */
import Atrament from "atrament";
import { replayAtramentStroke } from "../engine/atrament-adapter.ts";
import type { InkStroke } from "../engine/index.ts";

/** devicePixelRatio 上限 2（与 atrament-adapter 同口径，控制内存） */
const MAX_DPR = 2;

/** 回放画布句柄（组件持有；drawFrame 传入 frameAt 的截断结果） */
export interface AtramentReplayCanvas {
  /** 把「每笔可见点数」画上画布（全量重绘；strokes 与 visiblePoints 一一对应） */
  drawFrame(
    strokes: readonly InkStroke[],
    visiblePoints: readonly number[],
  ): void;
  destroy(): void;
}

/** 在容器内创建回放画布（canvas 撑满容器；容器负责纵横比/尺寸） */
export function createAtramentReplayCanvas(
  container: HTMLElement,
): AtramentReplayCanvas {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("data-slot", "ink-replay-canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  container.appendChild(canvas);

  let cssWidth = 0;
  /** 最近一次 drawFrame 的入参（resize 后原样重画） */
  let lastFrame: {
    strokes: readonly InkStroke[];
    visiblePoints: readonly number[];
  } | null = null;

  function sizeCanvas(): void {
    cssWidth = container.clientWidth || 300;
    const cssHeight = container.clientHeight || 200;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  }

  sizeCanvas();
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    throw new Error("无法创建 canvas 2d 上下文（当前环境不支持回放）");
  }
  // 与 atrament-adapter 同款手法：构造即配置好 2d 画笔状态，随即解绑其内部
  // 指针监听（回放只读不写，输入层不接管）
  const atrament = new Atrament(canvas);
  atrament.destroy();
  // 收窄后的 context 引用（const + 早退后声明箭头函数，类型收窄才能进闭包）
  const ctx2d = ctx;

  const drawFrame = (
    strokes: readonly InkStroke[],
    visiblePoints: readonly number[],
  ): void => {
    lastFrame = { strokes, visiblePoints };
    // 清屏（transform 安全口径，同 adapter.redraw；随后恢复画笔状态）
    ctx2d.save();
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.restore();
    ctx2d.globalCompositeOperation = "source-over";
    ctx2d.globalAlpha = 1;
    ctx2d.lineCap = "round";
    ctx2d.lineJoin = "round";
    for (let i = 0; i < strokes.length; i++) {
      const stroke = strokes[i];
      const visible = visiblePoints[i];
      if (!stroke || !visible || visible <= 0) continue;
      // 截断到当前时刻已走过的点（slice 产生短数组，原笔画不可变）
      replayAtramentStroke(atrament, cssWidth, {
        ...stroke,
        points: stroke.points.slice(0, visible),
      });
    }
  };

  // 尺寸变化（iPad 旋转、窗口缩放）：重设位图并重画当前帧（归一化坐标保证比例正确）
  const observer = new ResizeObserver(() => {
    sizeCanvas();
    if (lastFrame) drawFrame(lastFrame.strokes, lastFrame.visiblePoints);
  });
  observer.observe(container);

  return {
    drawFrame,
    destroy(): void {
      observer.disconnect();
      atrament.destroy();
      canvas.remove();
    },
  };
}
