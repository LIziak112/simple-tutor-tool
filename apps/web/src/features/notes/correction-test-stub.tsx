/**
 * 订正区（CorrectionSection，2026-10 订正重构为直达入口）的共享测试桩
 * （对齐 note-original-test-stub 先例）：AttemptResultView 等页面/视图测试
 * 文件的 vi.mock 工厂 import 本文件取桩组件，断言侧直接调
 * correctionStubDatasets()（document 直查）。
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
    "data-no": String(props.questionNo ?? ""),
    "data-round": String(props.roundLabel ?? ""),
    "data-prefix": String(props.ariaPrefix ?? ""),
  });
}

/** 读取当前文档内全部桩的 dataset（顺序即渲染顺序） */
export function correctionStubDatasets(): DOMStringMap[] {
  return [...document.querySelectorAll('[data-testid="correction-stub"]')].map(
    (el) => (el as HTMLElement).dataset,
  );
}
