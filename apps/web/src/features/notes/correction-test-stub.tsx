/**
 * 订正区（CorrectionSection）的共享测试桩（T6R.15，对齐 note-original-test-stub
 * 先例）：AttemptResultView 等页面/视图测试文件的 vi.mock 工厂 import 本文件
 * 取桩组件，断言侧直接调 correctionStubDatasets()（document 直查）。
 *
 * 约束（对齐 note-test-utils 的决策）：只依赖 react + DOM，不依赖任何测试
 * 框架。
 */
import { createElement } from "react";

/** 桩组件：把关键接线 props 落到 data-* 供断言读取（props 名即 data 名） */
export function CorrectionTestStub(props: Record<string, unknown>) {
  return createElement("div", {
    "data-testid": "correction-stub",
    "data-attempt": String(props.attemptId),
    "data-question": String(props.questionId),
    "data-prefix": String(props.ariaPrefix ?? ""),
  });
}

/** 读取当前文档内全部桩的 dataset（顺序即渲染顺序） */
export function correctionStubDatasets(): DOMStringMap[] {
  return [...document.querySelectorAll('[data-testid="correction-stub"]')].map(
    (el) => (el as HTMLElement).dataset,
  );
}
