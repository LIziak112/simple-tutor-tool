/**
 * 单题完整导出面板的测试桩（T6R.13，对齐 note-original-test-stub 模式）：
 * 页面/视图测试用 vi.mock("@/features/export/review-pack-panel") 换成本桩，
 * 只断言接线（角色/attempt/题目/题号），面板自身行为见 review-pack-panel.test。
 *
 * 约束同源：只依赖 react + DOM，不依赖任何测试框架。
 */
import { createElement } from "react";

/** 桩组件：把关键接线 props 落到 data-* 供断言读取（props 名即 data 名） */
export function ReviewPackTestStub(props: Record<string, unknown>) {
  return createElement("div", {
    "data-testid": "review-pack-stub",
    "data-role": String(props.viewer),
    "data-attempt": String(props.attemptId),
    "data-question": String(props.questionId),
    "data-no": String(props.questionNo ?? ""),
  });
}

/** 读取当前文档内全部桩的 dataset（顺序即渲染顺序） */
export function reviewPackStubDatasets(): DOMStringMap[] {
  return [...document.querySelectorAll('[data-testid="review-pack-stub"]')].map(
    (el) => (el as HTMLElement).dataset,
  );
}
