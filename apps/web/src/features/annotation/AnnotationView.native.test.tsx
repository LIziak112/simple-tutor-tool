import type {
  AnnotationSurfaceLayout,
  AnnotationViewData,
  AttemptQuestionPublic,
} from "@tutor/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchAnnotationViewApi } from "@/lib/api";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test/render-with-portal";
import { AnnotationView } from "./AnnotationView";
import { questionSurfaceMatchesLayout } from "./question-base-image";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchAnnotationViewApi: vi.fn(),
  fetchTeacherAnnotationViewApi: vi.fn(),
}));
vi.mock("./question-base-image", async (original) => ({
  ...(await original<typeof import("./question-base-image")>()),
  awaitQuestionSurfaceReady: vi.fn(async () => ({})),
  questionSurfaceMatchesLayout: vi.fn(async () => true),
}));
vi.mock("./AnnotationStaticCanvas", () => ({
  AnnotationStaticCanvas: () => <canvas data-slot="annotation-static-canvas" />,
}));
const question: AttemptQuestionPublic = {
  id: "q1",
  questionRevisionId: "r1",
  type: "fill",
  difficulty: 1,
  knowledge: [],
  stemMd: "公开 [[]]",
  hintCount: 0,
};
const layout: AnnotationSurfaceLayout = {
  renderVersion: 4,
  renderProfile: "whole-question-v1",
  questionRevisionId: "r1",
  cssWidth: 600,
  cssHeight: 300,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
  compatibility: {
    version: 1,
    contentSignature: "d".repeat(64),
    blocks: [{ tag: "DIV", node: "root", x: 0, y: 0, width: 600, height: 300 }],
    fonts: [["sans-serif", "16px", "400", "28px", "normal"]],
    textRects: [],
  },
};
const view: AnnotationViewData = {
  base: {
    baseId: "11111111-1111-4111-8111-111111111111",
    state: "ready",
    stale: false,
    pixelWidth: 1200,
    pixelHeight: 600,
    layout,
  },
  doc: {
    version: 1,
    baseWidth: 1200,
    baseHeight: 600,
    strokes: [
      {
        tool: "pen",
        color: "#dc2626",
        weight: 4,
        points: [{ x: 10, y: 10, p: 0.5, t: 0 }],
      },
    ],
  },
  annotation: null,
  maxWidthPx: 1440,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(fetchAnnotationViewApi).mockResolvedValue(view);
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());
it("只读原生填空常驻，元数据读取后保留同一输入与答案，不下载/解码图片", async () => {
  const { container } = render(
    <AnnotationView
      inline
      viewer="student"
      attemptId="a1"
      questionId="q1"
      question={question}
      answer={{ kind: "fill", values: ["本人答案"] }}
    />,
  );
  const input = screen.getByRole("textbox");
  expect(input).toHaveValue("本人答案");
  expect(input).toBeDisabled();
  await waitFor(() =>
    expect(
      container.querySelector('[data-slot="annotation-static-canvas"]'),
    ).not.toBeNull(),
  );
  expect(screen.getByRole("textbox")).toBe(input);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".sr-only")).toBeNull();
  expect(
    screen.queryByRole("button", { name: /进入作答|返回原稿/ }),
  ).toBeNull();
});
it("只读仍拒绝错误 revision，保留真实题面和原稿，不伪装墨层恢复成功", async () => {
  vi.mocked(fetchAnnotationViewApi).mockResolvedValue({
    ...view,
    base: {
      ...view.base,
      baseId: "11111111-1111-4111-8111-111111111111",
      state: "ready",
      stale: false,
      pixelWidth: 1200,
      pixelHeight: 600,
      layout: { ...layout, questionRevisionId: "other" },
    },
  });
  const { container } = render(
    <AnnotationView
      inline
      viewer="student"
      attemptId="a1"
      questionId="q1"
      question={question}
    />,
  );
  await screen.findByText(/题目版本不符/);
  expect(
    container.querySelector('[data-slot="annotation-static-canvas"]'),
  ).toBeNull();
  expect(screen.getByRole("textbox")).toBeDisabled();
  expect(container.querySelector("img")).toBeNull();
});
it("真实几何失败不显示墨层，保稿错误可重试；PNG URL 缺失不影响正常原生显示", async () => {
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(false);
  const { container } = render(
    <AnnotationView
      inline
      viewer="student"
      attemptId="a1"
      questionId="q1"
      question={question}
    />,
  );
  await screen.findByText(/超过 10px/);
  expect(
    container.querySelector('[data-slot="annotation-static-canvas"]'),
  ).toBeNull();
  vi.mocked(questionSurfaceMatchesLayout).mockResolvedValue(true);
  fireEvent.click(screen.getByRole("button", { name: /重新加载标画/ }));
  await waitFor(() =>
    expect(
      container.querySelector('[data-slot="annotation-static-canvas"]'),
    ).not.toBeNull(),
  );
  expect(container.querySelector("img")).toBeNull();
});
it("compact 关闭零请求，打开后为真实只读题面", async () => {
  const { container } = render(
    <AnnotationView
      compact
      viewer="student"
      attemptId="a1"
      questionId="q1"
      question={question}
    />,
  );
  expect(fetchAnnotationViewApi).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /查看本题题干标注/ }));
  await screen.findByRole("textbox");
  await waitFor(() =>
    expect(
      container.querySelector('[data-slot="annotation-static-canvas"]'),
    ).not.toBeNull(),
  );
  expect(container.querySelector("img")).toBeNull();
});
it("阶段切换后迟到旧响应不能挂回新阶段墨层", async () => {
  let complete!: (value: AnnotationViewData) => void;
  vi.mocked(fetchAnnotationViewApi)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValueOnce({ ...view, base: null, doc: null });
  const { container, rerender } = render(
    <AnnotationView
      inline
      viewer="student"
      attemptId="a1"
      questionId="q1"
      question={question}
    />,
  );
  await waitFor(() => expect(fetchAnnotationViewApi).toHaveBeenCalledTimes(1));
  rerender(
    <AnnotationView
      inline
      phase="correction"
      viewer="student"
      attemptId="a1"
      questionId="q1"
      question={question}
    />,
  );
  await waitFor(() => expect(fetchAnnotationViewApi).toHaveBeenCalledTimes(2));
  await act(async () => complete(view));
  expect(
    container.querySelector('[data-slot="annotation-static-canvas"]'),
  ).toBeNull();
  expect(container.querySelector("img")).toBeNull();
});
