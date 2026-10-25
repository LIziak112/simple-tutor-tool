import { fireEvent, render, screen } from "@testing-library/react";
import type { AnnotationDoc } from "@tutor/contract";
import { expect, it, vi } from "vitest";
import { AnnotationOriginal } from "./AnnotationOriginal";

const draw = vi.hoisted(() => ({ destroy: vi.fn() }));
vi.mock("@/features/ink/engine/atrament-adapter", () => ({
  createProgrammaticAtrament: () => draw,
}));

const doc: AnnotationDoc = {
  version: 1,
  baseWidth: 600,
  baseHeight: 400,
  strokes: [],
};
const props = {
  src: "/original.png",
  pixelWidth: 600,
  pixelHeight: 400,
  doc,
  label: "原圈画",
};

it("底图加载失败可重试，校验原始像素尺寸成功后才显示原稿", () => {
  render(<AnnotationOriginal {...props} />);
  const image = screen.getByRole("img", { hidden: true });
  fireEvent.error(image);
  expect(screen.getByRole("alert")).toHaveTextContent("原稿已保留");
  fireEvent.click(screen.getByRole("button", { name: "重新加载原圈画" }));
  const retried = screen.getByRole("img", { hidden: true });
  expect(retried).not.toBe(image);
  Object.defineProperties(retried, {
    naturalWidth: { value: 600 },
    naturalHeight: { value: 400 },
  });
  fireEvent.load(retried);
  expect(retried).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("笔迹坐标域或实际图片尺寸不符时拒绝显示错位原稿", () => {
  const { rerender } = render(
    <AnnotationOriginal {...props} pixelWidth={601} />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("尺寸不匹配");
  expect(screen.queryByRole("img", { hidden: true })).toBeNull();
  rerender(<AnnotationOriginal {...props} />);
  const image = screen.getByRole("img", { hidden: true });
  Object.defineProperties(image, {
    naturalWidth: { value: 601 },
    naturalHeight: { value: 400 },
  });
  fireEvent.load(image);
  expect(screen.getByRole("alert")).toHaveTextContent("尺寸不匹配");
  expect(image).not.toBeVisible();
});

it("更换底图后不沿用旧图就绪状态", () => {
  const { rerender } = render(<AnnotationOriginal {...props} />);
  const image = screen.getByRole("img", { hidden: true });
  Object.defineProperties(image, {
    naturalWidth: { value: 600 },
    naturalHeight: { value: 400 },
  });
  fireEvent.load(image);
  expect(image).toBeVisible();
  rerender(<AnnotationOriginal {...props} src="/other.png" />);
  expect(screen.getByRole("img", { hidden: true })).not.toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("正在加载");
});
