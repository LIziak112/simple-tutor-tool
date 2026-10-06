/**
 * 原稿查看面板的共享测试桩（T6R.11 复审收敛）：三个页面/视图测试文件
 * （AttemptResultView / AttemptDetailPage / PendingMarkQueuePage）的
 * vi.mock("@/features/notes/NoteOriginalView") 工厂逐字拷贝收敛至此。
 *
 * 约束（对齐 note-test-utils 的决策）：只依赖 react + DOM，不依赖任何测试
 * 框架——各测试文件的 vi.mock 工厂 async import 本文件取桩组件；断言侧
 * 直接调 noteOriginalStubDatasets()（document 直查）。
 */
import { createElement } from "react";

/** 桩组件：把关键接线 props 落到 data-* 供断言读取（props 名即 data 名） */
export function NoteOriginalTestStub(props: Record<string, unknown>) {
  return createElement("div", {
    "data-testid": "note-original-stub",
    "data-role": String(props.viewer),
    "data-attempt": String(props.attemptId),
    "data-question": String(props.questionId),
    "data-round": String(props.roundLabel ?? ""),
  });
}

/** 读取当前文档内全部桩的 dataset（顺序即渲染顺序） */
export function noteOriginalStubDatasets(): DOMStringMap[] {
  return [
    ...document.querySelectorAll('[data-testid="note-original-stub"]'),
  ].map((el) => (el as HTMLElement).dataset);
}
