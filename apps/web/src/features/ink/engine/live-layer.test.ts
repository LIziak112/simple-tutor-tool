import { afterEach, describe, expect, it } from "vitest";
import { onePathSvg } from "./highlighter-paint.ts";
import { createInkLiveLayer, INK_LIVE_LAYER_SELECTOR } from "./live-layer.ts";
import { INK_HIGHLIGHTER } from "./types.ts";

const hosts: HTMLElement[] = [];
function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const layer = createInkLiveLayer(host);
  const svg = host.querySelector(INK_LIVE_LAYER_SELECTOR);
  if (!(svg instanceof SVGSVGElement)) throw new Error("临时层未挂载");
  const path = svg.querySelector("path");
  if (!path) throw new Error("临时层缺少路径");
  return { host, layer, svg, path };
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

const points = [
  { x: 0, y: 0, p: 0.5, t: 0 },
  { x: 10, y: 0, p: 0.5, t: 8 },
  { x: 10, y: 10, p: 0.5, t: 16 },
  { x: 20, y: 10, p: 0.5, t: 24 },
];
const stroke = { ...INK_HIGHLIGHTER, points };

describe("书写中那一笔的临时层", () => {
  it("铺满宿主、盖在画布上，不接指针事件，读屏不可见", () => {
    const { host, svg } = mount();
    expect(svg.parentElement).toBe(host);
    expect(svg.style.position).toBe("absolute");
    expect(svg.style.inset).toBe("0px");
    expect(svg.style.width).toBe("100%");
    expect(svg.style.height).toBe("100%");
    expect(svg.style.pointerEvents).toBe("none");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    // 坐标域和画布一样随宿主拉伸，不留白边
    expect(svg.getAttribute("preserveAspectRatio")).toBe("none");
  });

  it("坐标域由宿主设定；零或非法尺寸不改已有坐标域", () => {
    const { layer, svg } = mount();
    layer.setViewBox(1000, 666.67);
    expect(svg.getAttribute("viewBox")).toBe("0 0 1000 666.67");
    layer.setViewBox(0, 500);
    layer.setViewBox(1000, Number.NaN);
    expect(svg.getAttribute("viewBox")).toBe("0 0 1000 666.67");
  });

  it("没画的时候不显示任何东西", () => {
    const { path } = mount();
    expect(path.style.display).toBe("none");
    expect(path.hasAttribute("d")).toBe(false);
  });

  it("显示一笔：整笔一条路径，颜色、线宽取自这一笔，圆头圆角、不填充", () => {
    const { layer, path } = mount();
    layer.showStroke(stroke);
    expect(path.style.display).toBe("");
    expect(path.getAttribute("d")).toBe(onePathSvg(points));
    expect(path.getAttribute("stroke")).toBe(INK_HIGHLIGHTER.color);
    expect(path.getAttribute("stroke-width")).toBe(
      String(INK_HIGHLIGHTER.weight),
    );
    expect(path.getAttribute("stroke-linecap")).toBe("round");
    expect(path.getAttribute("stroke-linejoin")).toBe("round");
    expect(path.getAttribute("fill")).toBe("none");
  });

  it("同一笔多次显示只是更新路径（count 截取前若干个点）", () => {
    const { layer, svg, path } = mount();
    layer.showStroke(stroke, 2);
    expect(path.getAttribute("d")).toBe(onePathSvg(points, 2));
    layer.showStroke(stroke);
    expect(path.getAttribute("d")).toBe(onePathSvg(points));
    expect(svg.querySelectorAll("path")).toHaveLength(1);
  });

  it("没有点的一笔等同清空", () => {
    const { layer, path } = mount();
    layer.showStroke(stroke);
    layer.showStroke({ ...stroke, points: [] });
    expect(path.style.display).toBe("none");
    expect(path.hasAttribute("d")).toBe(false);
  });

  it("clear 收起这一笔；destroy 连同节点一起移除", () => {
    const { host, layer, path } = mount();
    layer.showStroke(stroke);
    layer.clear();
    expect(path.style.display).toBe("none");
    expect(path.hasAttribute("d")).toBe(false);
    layer.destroy();
    expect(host.querySelector(INK_LIVE_LAYER_SELECTOR)).toBeNull();
  });
});
