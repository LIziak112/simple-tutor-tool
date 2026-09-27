/**
 * atrament@5.x 本地类型声明（官方未提供 .d.ts）。
 * 只声明本项目实际使用的成员（引擎以"程序化绘制"方式驱动，见 atrament-adapter.ts）：
 * beginStroke / draw / endStroke 官方文档"Programmatic drawing"一节；
 * 构造后立即 destroy() 解绑其内部指针监听（destroy 只做 clear+解绑，保留
 * canvas 2d context 上已设置好的画笔状态），输入层完全由本项目接管。
 */
declare module "atrament" {
  export interface AtramentOptions {
    /** 笔迹颜色（写入 canvas 2d strokeStyle） */
    color?: string;
    /** 基础线宽（CSS 像素） */
    thickness?: number;
    smoothing?: number;
    adaptiveStroke?: boolean;
    secondaryMouseButton?: boolean;
    ignoreModifiers?: boolean;
    weight?: number;
    mode?: "draw" | "erase" | "fill" | "disabled";
  }

  export default class Atrament {
    constructor(canvas: HTMLCanvasElement, options?: AtramentOptions);

    /** 画笔颜色（getter/setter，读写 canvas 2d strokeStyle） */
    color: string;
    /** 基础线宽（CSS 像素，绘制时按 canvas.width/offsetWidth 内部缩放） */
    weight: number;
    smoothing: number;
    adaptiveStroke: boolean;

    /** 落笔：移动画笔到指定位置并开始路径（坐标为相对 canvas 的 CSS 像素） */
    beginStroke(x: number, y: number): void;
    /**
     * 画一段：接受当前真实坐标与上一个"已处理"坐标，返回本次处理后的坐标
     * （平滑过滤后的位置，作为下一次调用的 prev 使用）。
     */
    draw(
      x: number,
      y: number,
      prevX?: number,
      prevY?: number,
      pressure?: number,
    ): { x: number; y: number };
    /** 收笔：结束路径 */
    endStroke(x: number, y: number): void;

    /** 清空画布位图（不动 context 状态） */
    clear(): void;
    /** 清空并解绑内部全局监听（不销毁 canvas 与 context） */
    destroy(): void;
  }
}
