import { describe, expect, it } from "vitest";
import {
  NOTE_PAPER_BG_COLOR,
  NOTE_PAPER_GRID_SPACING_LOGICAL,
  NOTE_PAPER_LINE_COLOR,
  NOTE_PAPER_LINE_WIDTH_PX,
  paperBackgroundCss,
} from "./paper-style.ts";

/**
 * 纸张背景常量集与屏幕端 CSS（T6R.7，方案 §4.3「屏幕、PNG、历史回看使用
 * 同一坐标和背景间距」）：常量自 render-note 上移至 engine 层（值不变 ⇒
 * PNG 像素输出不变，不递增 NOTE_RENDER_VERSION），屏幕端与 PNG 从同一组
 * 常量生成——数值改动只发生在此处。
 */
describe("paper-style：常量集（与 PNG 渲染同源）", () => {
  it("间距 40 逻辑单位、线宽 1px、线色与底色为固定值（上移不改值）", () => {
    expect(NOTE_PAPER_GRID_SPACING_LOGICAL).toBe(40);
    expect(NOTE_PAPER_LINE_WIDTH_PX).toBe(1);
    expect(NOTE_PAPER_LINE_COLOR).toBe("#cbd5e1");
    expect(NOTE_PAPER_BG_COLOR).toBe("#ffffff");
  });
});

describe("paper-style：paperBackgroundCss（屏幕端背景）", () => {
  it("white 返回 none（旧作答组件零变化：不动 canvas 背景样式）", () => {
    expect(paperBackgroundCss("white", 500)).toBe("none");
  });

  it("line（横线）：间距随容器宽换算（S = 40 × cssWidth/1000），线色同 PNG", () => {
    const css = paperBackgroundCss("line", 500);
    // 500 宽 → S = 20px；线带宽 1px，落在 [S-1, S)
    expect(css).toContain("repeating-linear-gradient(to bottom");
    expect(css).toContain("transparent 19px");
    expect(css).toContain(`${NOTE_PAPER_LINE_COLOR} 20px`);
    expect(css).not.toContain("to right");
  });

  it("grid（格线）：横线 + 竖线两条渐变叠加", () => {
    const css = paperBackgroundCss("grid", 1000);
    expect(css).toContain("repeating-linear-gradient(to bottom");
    expect(css).toContain("repeating-linear-gradient(to right");
    // 1000 宽 → S 恰 40px（1:1）
    expect(css).toContain("transparent 39px");
  });

  it("间距小于线宽（极窄容器/零宽）时退化为 none，不生成非法渐变", () => {
    expect(paperBackgroundCss("grid", 0)).toBe("none");
    expect(paperBackgroundCss("line", 20)).toBe("none"); // S=0.8px < 1px
  });
});
