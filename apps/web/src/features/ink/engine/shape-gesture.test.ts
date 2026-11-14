import { describe, expect, it, vi } from "vitest";
import { createShapeGesture } from "./shape-gesture.ts";
import { SHAPE_MIN_SPAN } from "./shape-points.ts";

function setup() {
  const layer = { showOutline: vi.fn(), clear: vi.fn() };
  const gesture = createShapeGesture({ layer: () => layer });
  return { layer, gesture };
}

const brush = { color: "#1f2328", weight: 4 };

describe("图形手势：落笔定起点、拖动出预览、抬笔给出一笔的点列", () => {
  it("没开始时不活动，end 什么也不给，也不碰临时层（上面可能是在途的别的笔）", () => {
    const layerOf = vi.fn(() => ({ showOutline: vi.fn(), clear: vi.fn() }));
    const gesture = createShapeGesture({ layer: layerOf });
    expect(gesture.active).toBe(false);
    expect(gesture.end()).toBeNull();
    gesture.through({ x: 10, y: 10 }, 16);
    expect(layerOf).not.toHaveBeenCalled();
  });

  it("拖动：预览画骨架，颜色线宽取这一笔的；接近水平的直线吸附", () => {
    const { gesture, layer } = setup();
    gesture.begin({ shape: "line", from: { x: 100, y: 100 }, brush });
    expect(gesture.active).toBe(true);
    gesture.through({ x: 300, y: 108 }, 120);
    expect(layer.showOutline).toHaveBeenLastCalledWith(
      [
        { x: 100, y: 100 },
        { x: 300, y: 100 },
      ],
      brush,
    );
    gesture.through({ x: 300, y: 200 }, 240);
    expect(layer.showOutline).toHaveBeenLastCalledWith(
      [
        { x: 100, y: 100 },
        { x: 300, y: 200 },
      ],
      brush,
    );
  });

  it("抬笔：给出加密后的点列，时间到最后一次拖动为止；预览收起，手势结束", () => {
    const { gesture, layer } = setup();
    gesture.begin({ shape: "line", from: { x: 100, y: 100 }, brush });
    gesture.through({ x: 300, y: 100 }, 480);
    layer.clear.mockClear();
    const points = gesture.end();
    expect(points?.[0]).toEqual({ x: 100, y: 100, p: 0.51, t: 0 });
    expect(points?.at(-1)).toEqual({ x: 300, y: 100, p: 0.51, t: 480 });
    expect(points?.length).toBeGreaterThan(50);
    expect(layer.clear).toHaveBeenCalledTimes(1);
    expect(gesture.active).toBe(false);
    expect(gesture.end()).toBeNull();
  });

  it("只点了一下或拖得太短：不出预览，抬笔不落笔", () => {
    const { gesture, layer } = setup();
    gesture.begin({ shape: "rect", from: { x: 100, y: 100 }, brush });
    expect(gesture.end()).toBeNull();

    gesture.begin({ shape: "rect", from: { x: 100, y: 100 }, brush });
    gesture.through({ x: 100 + SHAPE_MIN_SPAN - 2, y: 100 }, 30);
    expect(layer.showOutline).not.toHaveBeenCalled();
    expect(gesture.end()).toBeNull();
    expect(gesture.active).toBe(false);
  });

  it("拖出去又拖回起点附近：预览收起", () => {
    const { gesture, layer } = setup();
    gesture.begin({ shape: "ellipse", from: { x: 100, y: 100 }, brush });
    gesture.through({ x: 200, y: 180 }, 100);
    expect(layer.showOutline).toHaveBeenCalledTimes(1);
    layer.clear.mockClear();
    gesture.through({ x: 101, y: 101 }, 200);
    expect(layer.clear).toHaveBeenCalledTimes(1);
    expect(gesture.end()).toBeNull();
  });

  it("画布范围：拖出界只画到边上，箭翼也不出界", () => {
    const { gesture, layer } = setup();
    const bounds = { width: 1000, height: 600 };
    gesture.begin({ shape: "arrow", from: { x: 500, y: 300 }, brush, bounds });
    gesture.through({ x: 1200, y: -80 }, 300);
    const preview = layer.showOutline.mock.lastCall?.[0] as Array<{
      x: number;
      y: number;
    }>;
    expect(preview[1]).toEqual({ x: 1000, y: 0 });
    expect(gesture.end()?.length).toBeGreaterThan(0);

    // 贴着上边画的箭头：朝外的那一翼收在边上
    gesture.begin({ shape: "arrow", from: { x: 500, y: 2 }, brush, bounds });
    gesture.through({ x: 800, y: 2 }, 300);
    const points = gesture.end() ?? [];
    expect(points.length).toBeGreaterThan(0);
    expect(Math.min(...points.map((p) => p.y))).toBe(0);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1000);
      expect(p.y).toBeLessThanOrEqual(600);
    }
  });

  it("只留起止两点（直线荧光笔）：两个点，同样吸附，时间为 0 和拖动时长", () => {
    const { gesture } = setup();
    gesture.begin({
      shape: "line",
      from: { x: 100.004, y: 100 },
      brush: { color: "rgba(250, 204, 21, 0.45)", weight: 16 },
      sparse: true,
    });
    gesture.through({ x: 400, y: 110 }, 350.4);
    expect(gesture.end()).toEqual([
      { x: 100, y: 100, p: 0.51, t: 0 },
      { x: 400, y: 100, p: 0.51, t: 350 },
    ]);
  });

  it("坐标单位不是逻辑单位（圈画）：最小尺寸与间距按 unit 换算", () => {
    const { gesture } = setup();
    const unit = 1.44;
    gesture.begin({ shape: "line", from: { x: 0, y: 0 }, brush, unit });
    // 7 个底图像素不到 6 个逻辑单位（8.64）
    gesture.through({ x: 7, y: 0 }, 50);
    expect(gesture.end()).toBeNull();
    gesture.begin({ shape: "line", from: { x: 0, y: 0 }, brush, unit });
    gesture.through({ x: 576, y: 0 }, 50);
    // 576 个底图像素 = 400 个逻辑单位：100 步，连起点和终点补的一个共 102 点
    expect(gesture.end()).toHaveLength(102);
  });

  it("预览线宽可以单独给（自然笔感的线宽另有缩放）", () => {
    const { gesture, layer } = setup();
    gesture.begin({
      shape: "line",
      from: { x: 0, y: 0 },
      brush,
      previewWeight: 6,
    });
    gesture.through({ x: 100, y: 50 }, 10);
    expect(layer.showOutline.mock.lastCall?.[1]).toEqual({
      color: brush.color,
      weight: 6,
    });
  });

  it("重新开始会丢掉上一次没抬笔的图形；没有预览层也照常给点列", () => {
    const { gesture, layer } = setup();
    gesture.begin({ shape: "line", from: { x: 0, y: 0 }, brush });
    gesture.through({ x: 100, y: 0 }, 10);
    layer.clear.mockClear();
    gesture.begin({ shape: "line", from: { x: 50, y: 50 }, brush });
    expect(layer.clear).toHaveBeenCalledTimes(1);
    gesture.through({ x: 50, y: 150 }, 10);
    expect(gesture.end()?.[0]).toMatchObject({ x: 50, y: 50 });

    const bare = createShapeGesture({ layer: () => null });
    bare.begin({ shape: "line", from: { x: 0, y: 0 }, brush });
    bare.through({ x: 100, y: 0 }, 10);
    expect(bare.end()?.at(-1)).toMatchObject({ x: 100, y: 0 });
  });
});
