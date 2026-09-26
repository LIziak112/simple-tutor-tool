import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ImportPreviewData, LintIssue } from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, commitImport, previewImport } from "@/lib/api";
import ImportPage from "./ImportPage";

/**
 * 导入页组件测试（T1.11）：
 * - 输入区（textarea/文件名/预览按钮禁用逻辑）与预览payload；
 * - 预览态统计条（版本徽章/题数）与错误面板渲染（error 时确认导入禁用）；
 * - 编辑后 debounce 重新调 preview；
 * - commit 422 LINT_ERROR 的 _issues 并入同一面板；
 * - 无 error 确认导入成功后跳 /t/content（带成功提示 state）。
 * CodeMirror 编辑器 mock 为普通 textarea（jsdom 不跑真实 CM；真实集成走 Playwright 自验），
 * lint 标注的纯映射逻辑在 lint-diagnostics.test.ts 单独覆盖。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    previewImport: vi.fn(),
    commitImport: vi.fn(),
  };
});

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="Markdown 原文编辑器（带 lint 标注）"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

const mockedPreview = vi.mocked(previewImport);
const mockedCommit = vi.mocked(commitImport);

/** /t/content 的替身：显示成功提示 state，便于断言跳转参数 */
function ContentStub() {
  const location = useLocation();
  const state = location.state as { importSuccess?: string } | null;
  return (
    <div data-testid="content-stub">{state?.importSuccess ?? "内容页"}</div>
  );
}

function renderImportPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/t/import"]}>
        <Routes>
          <Route path="/t/import" element={<ImportPage />} />
          <Route path="/t/content" element={<ContentStub />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const PRACTICE_MD = `---
kind: practice
unit: 练习四
---

::::question{type=judge difficulty=1}
判断题。[[正确]]
::::
`;

function previewData(overrides: Partial<ImportPreviewData>): ImportPreviewData {
  return {
    version: 2,
    summary: {
      unitCount: 1,
      lectureCount: 0,
      questionCount: 1,
      typeDistribution: { judge: 1 },
    },
    issues: [],
    ...overrides,
  };
}

const ERRORS: LintIssue[] = [
  {
    level: "error",
    line: 5,
    column: 1,
    code: "FILL_NO_BLANK",
    message: "填空题题干没有任何 [[…]] 空",
    fix: "在题干中用 [[答案]] 标记空位",
  },
];

describe("ImportPage 输入区", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("渲染 textarea、文件名输入与文件选择按钮；空内容时预览按钮禁用", () => {
    renderImportPage();
    expect(screen.getByLabelText("文档内容")).toBeInTheDocument();
    expect(screen.getByLabelText("文件名")).toHaveValue("未命名.md");
    expect(
      screen.getByRole("button", { name: "选择 .md 文件" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /预览/ })).toBeDisabled();
  });

  it("输入内容后点击预览：带正确 payload 调 previewImport，进入预览态显示统计条", async () => {
    mockedPreview.mockResolvedValue(previewData({}));
    renderImportPage();
    fireEvent.change(screen.getByLabelText("文档内容"), {
      target: { value: PRACTICE_MD },
    });
    fireEvent.change(screen.getByLabelText("文件名"), {
      target: { value: "练习四.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));

    await waitFor(() =>
      expect(mockedPreview).toHaveBeenCalledWith({
        markdown: PRACTICE_MD,
        filename: "练习四.md",
      }),
    );
    // 统计条：版本徽章 + 单元/讲义/题数（1/0/1）+ 题型分布
    expect(await screen.findByText("DSL v2")).toBeInTheDocument();
    expect(screen.getAllByText("1", { selector: "strong" })).toHaveLength(2);
    expect(screen.getByText("0", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("判断 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认导入" })).toBeEnabled();
  });
});

describe("ImportPage 预览态", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("有 error 时：错误面板渲染（行号/code/消息/建议），确认导入禁用", async () => {
    mockedPreview.mockResolvedValue(previewData({ issues: ERRORS }));
    renderImportPage();
    fireEvent.change(screen.getByLabelText("文档内容"), {
      target: { value: PRACTICE_MD },
    });
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));

    expect(await screen.findByText("DSL v2")).toBeInTheDocument();
    const panel = screen.getByRole("region", { name: /发现 1 个问题/ });
    expect(panel).toBeInTheDocument();
    expect(screen.getByText("第 5 行")).toBeInTheDocument();
    expect(screen.getByText("FILL_NO_BLANK")).toBeInTheDocument();
    expect(screen.getByText("填空题题干没有任何 [[…]] 空")).toBeInTheDocument();
    expect(
      screen.getByText("建议：在题干中用 [[答案]] 标记空位"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
  });

  it("编辑器内容变化后 400ms debounce 重新调 preview", async () => {
    mockedPreview.mockResolvedValue(previewData({}));
    renderImportPage();
    fireEvent.change(screen.getByLabelText("文档内容"), {
      target: { value: PRACTICE_MD },
    });
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await screen.findByText("DSL v2");

    fireEvent.change(
      screen.getByLabelText("Markdown 原文编辑器（带 lint 标注）"),
      {
        target: { value: `${PRACTICE_MD}\n<!-- 追加一行 -->` },
      },
    );
    await waitFor(() => expect(mockedPreview).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
  });

  it("无 error 确认导入：调 commitImport，成功跳 /t/content 并携带成功提示", async () => {
    mockedPreview.mockResolvedValue(previewData({}));
    mockedCommit.mockResolvedValue({
      importId: "5b0b7ba4-6c07-4a5e-9df7-3b1e0d0b5c66",
      courseId: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
      units: [
        { id: "练习四", title: "练习四", inserted: true, updated: false },
      ],
      lectures: [],
      questions: { inserted: 1, updated: 0 },
    });
    renderImportPage();
    fireEvent.change(screen.getByLabelText("文档内容"), {
      target: { value: PRACTICE_MD },
    });
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await screen.findByText("DSL v2");
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));

    // TanStack Query 的 mutationFn 第二参为上下文对象，只断言业务入参
    await waitFor(() => expect(mockedCommit).toHaveBeenCalled());
    expect(mockedCommit.mock.calls[0]?.[0]).toEqual({
      markdown: PRACTICE_MD,
      filename: "未命名.md",
    });
    const stub = await screen.findByTestId("content-stub");
    expect(stub.textContent).toContain("导入完成：单元 1 个");
    expect(stub.textContent).toContain("题目新增 1 / 更新 0");
  });

  it("commit 返回 422 LINT_ERROR：_issues 并入错误面板，确认导入保持可用态展示服务端消息", async () => {
    mockedPreview.mockResolvedValue(previewData({}));
    mockedCommit.mockRejectedValue(
      new ApiError(
        "LINT_ERROR",
        "文档存在 1 个 error 级问题，请先修复后重试",
        422,
        { _issues: ERRORS },
      ),
    );
    renderImportPage();
    fireEvent.change(screen.getByLabelText("文档内容"), {
      target: { value: PRACTICE_MD },
    });
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await screen.findByText("DSL v2");
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));

    expect(
      await screen.findByText("文档存在 1 个 error 级问题，请先修复后重试"),
    ).toBeInTheDocument();
    expect(screen.getByText("第 5 行")).toBeInTheDocument();
    expect(screen.getByText("FILL_NO_BLANK")).toBeInTheDocument();
  });
});
