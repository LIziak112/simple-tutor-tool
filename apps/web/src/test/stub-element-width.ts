import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";

/**
 * 元素宽度桩（SAI-19 伴学栏布局测试共用）：可控的当前宽度值，
 * offsetWidth 与 getBoundingClientRect 同步返回（缩放还原 = 1 的前提）。
 * 每次 stubElementWidth() 独立持有自己的宽度值，restore 精确还原两个 spy。
 */
export function stubElementWidth(initialWidth = 1400) {
  let widthValue = initialWidth;
  const offset = vi
    .spyOn(HTMLElement.prototype, "offsetWidth", "get")
    .mockImplementation(() => widthValue);
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(() => ({ width: widthValue, height: 100 }) as DOMRect);
  return {
    /** 模拟设备宽度变化（旋转/分屏/缩放）；渲染前调用亦安全（暂无监听者） */
    setWidth(next: number) {
      widthValue = next;
      fireEvent(window, new Event("resize"));
    },
    restore() {
      offset.mockRestore();
      rect.mockRestore();
    },
  };
}
