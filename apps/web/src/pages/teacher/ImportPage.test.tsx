import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ImportBatchFilePreview,
  ImportPreviewData,
  LintIssue,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  commitImport,
  createLibraryFolderApi,
  fetchLibraryFolders,
  fetchSpecFile,
  previewImport,
  previewImportBatch,
} from "@/lib/api";
import ImportPage from "./ImportPage";

/**
 * 导入页组件测试（T1.11 建立；T2A.3 重构后更新）：
 * - 输入区：粘贴 textarea / 文件选择按钮 / 目标文件夹下拉（可就地新建）；
 * - 粘贴 → 单文件预览（统计条、错误面板、debounce、commit payload 与成功跳转）；
 * - commit 422 LINT_ERROR 的 _issues 并入同一面板；
 * - 多文件 → 批量预览表格（mock previewImportBatch）：行摘要、有 error 文件标红、
 *   「复制全部错误」按钮；提交时有 error 文件自动跳过、其余逐个 commit、汇总报告。
 * CodeMirror 编辑器 mock 为普通 textarea（jsdom 不跑真实 CM；真实集成走 Playwright 自验），
 * lint 标注的纯映射逻辑在 lint-diagnostics.test.ts 单独覆盖。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    previewImport: vi.fn(),
    previewImportBatch: vi.fn(),
    commitImport: vi.fn(),
    createLibraryFolderApi: vi.fn(),
    fetchSpecFile: vi.fn(),
    fetchContentTree: vi.fn().mockResolvedValue({
      courses: [{ id: "c-1", title: "初一上", lectures: [], units: [] }],
    }),
    fetchLibraryFolders: vi
      .fn()
      .mockResolvedValue({ folders: [{ id: "f-1", name: "第一章" }] }),
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
const mockedPreviewBatch = vi.mocked(previewImportBatch);
const mockedCommit = vi.mocked(commitImport);
const mockedCreateFolder = vi.mocked(createLibraryFolderApi);

/** /t/library 的替身：显示成功提示 state，便于断言跳转参数（T2A.2 起导入跳资源库） */
function LibraryStub() {
  const location = useLocation();
  const state = location.state as { importSuccess?: string } | null;
  return (
    <div data-testid="content-stub">{state?.importSuccess ?? "资源库页"}</div>
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
          <Route path="/t/library" element={<LibraryStub />} />
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
    actions: [
      {
        kind: "createUnit",
        title: "练习四",
        unitId: "练习四",
        folderName: null,
        restore: false,
      },
    ],
    warnings: [],
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

/** 批量预览的单文件条目夹具 */
function batchFile(
  path: string,
  overrides: Partial<ImportBatchFilePreview> = {},
): ImportBatchFilePreview {
  return {
    path,
    folderId: null,
    folderName: null,
    folderToCreate: false,
    preview: previewData({}),
    conflicts: [],
    hasError: false,
    ...overrides,
  };
}

/** 构造上传用的 File（jsdom 不支持 webkitRelativePath，path 退化为文件名） */
function mdFile(name: string, markdown: string): File {
  return new File([markdown], name, { type: "text/markdown" });
}

describe("ImportPage 输入区（T2A.3 三入口 + 导入选项）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("渲染粘贴框、文件选择按钮与目标文件夹下拉（含未归类）；空内容时预览按钮禁用", async () => {
    renderImportPage();
    expect(screen.getByLabelText("文档内容")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "选择 .md 文件" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /预览/ })).toBeDisabled();

    // 文件夹下拉：未归类 + 拉到的文件夹（TanStack Query 异步）
    const folderSelect = await screen.findByLabelText("目标文件夹");
    expect(folderSelect).toHaveValue("none");
    expect(
      await screen.findByRole("option", { name: "第一章" }),
    ).toBeInTheDocument();
  });

  it("输入区顶部带「AI 出题助手」入口，默认收起且不发请求（T1.13）", () => {
    renderImportPage();
    const toggle = screen.getByRole("button", { name: /AI 出题助手/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByLabelText("主题 / 考点（可选）"),
    ).not.toBeInTheDocument();
    expect(fetchSpecFile).not.toHaveBeenCalled();
  });

  it("就地新建文件夹：弹层输入名称创建成功后选为新目标", async () => {
    mockedCreateFolder.mockResolvedValue({
      id: "f-new",
      name: "新章节",
      order: 1,
      lectureCount: 0,
      unitCount: 0,
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    // invalidate 后重取的文件夹列表包含新文件夹（select 需要有对应 option 才能选中）
    vi.mocked(fetchLibraryFolders).mockResolvedValue({
      folders: [
        {
          id: "f-1",
          name: "第一章",
          order: 0,
          lectureCount: 0,
          unitCount: 0,
          createdAt: "2026-09-27T00:00:00.000Z",
        },
        {
          id: "f-new",
          name: "新章节",
          order: 1,
          lectureCount: 0,
          unitCount: 0,
          createdAt: "2026-09-27T00:00:00.000Z",
        },
      ],
    });
    renderImportPage();
    fireEvent.click(screen.getByRole("button", { name: /就地新建文件夹/ }));

    const input = await screen.findByLabelText("文件夹名");
    fireEvent.change(input, { target: { value: "新章节" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(screen.getByLabelText("目标文件夹")).toHaveValue("f-new"),
    );
    expect(mockedCreateFolder).toHaveBeenCalledWith({ name: "新章节" });
  });

  it("粘贴内容后点击预览：带正确 payload 调 previewImport，进入单文件预览态显示统计条", async () => {
    mockedPreview.mockResolvedValue(previewData({}));
    renderImportPage();
    fireEvent.change(screen.getByLabelText("文档内容"), {
      target: { value: PRACTICE_MD },
    });
    fireEvent.change(screen.getByLabelText(/文件名/), {
      target: { value: "练习四.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));

    await waitFor(() =>
      expect(mockedPreview).toHaveBeenCalledWith({
        markdown: PRACTICE_MD,
        filename: "练习四.md",
      }),
    );
    // 统计条：版本徽章 + 单元/讲义/题数（1/0/1）+ 题型分布 + 动作清单（D19）
    expect(await screen.findByText("DSL v2")).toBeInTheDocument();
    expect(screen.getAllByText("1", { selector: "strong" })).toHaveLength(2);
    expect(screen.getByText("0", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("判断 1")).toBeInTheDocument();
    expect(screen.getByText("将执行的动作")).toBeInTheDocument();
    expect(
      screen.getByText(/新增单元「练习四」（未归类）/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认导入" })).toBeEnabled();
  });
});

describe("ImportPage 单文件预览态", () => {
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

  it("无 error 确认导入：调 commitImport，成功跳 /t/library 并携带成功提示", async () => {
    mockedPreview.mockResolvedValue(previewData({}));
    mockedCommit.mockResolvedValue({
      importId: "5b0b7ba4-6c07-4a5e-9df7-3b1e0d0b5c66",
      courseId: null,
      folderId: null,
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

    await waitFor(() => expect(mockedCommit).toHaveBeenCalled());
    expect(mockedCommit.mock.calls[0]?.[0]).toEqual({
      markdown: PRACTICE_MD,
      filename: "未命名.md",
    });
    const stub = await screen.findByTestId("content-stub");
    expect(stub.textContent).toContain("导入完成：单元 1 个");
    expect(stub.textContent).toContain("题目新增 1 / 更新 0");
  });

  it("选择目标文件夹后：preview 与 commit payload 携带 folderId", async () => {
    mockedPreview.mockResolvedValue(previewData({}));
    mockedCommit.mockResolvedValue({
      importId: "5b0b7ba4-6c07-4a5e-9df7-3b1e0d0b5c66",
      courseId: null,
      folderId: "f-1",
      units: [],
      lectures: [],
      questions: { inserted: 0, updated: 0 },
    });
    renderImportPage();
    // 等文件夹列表加载完成（option 出现后再切换，否则 select 值会被置空）
    await screen.findByRole("option", { name: "第一章" });
    fireEvent.change(screen.getByLabelText("目标文件夹"), {
      target: { value: "f-1" },
    });
    fireEvent.change(screen.getByLabelText("文档内容"), {
      target: { value: PRACTICE_MD },
    });
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await screen.findByText("DSL v2");

    await waitFor(() =>
      expect(mockedPreview).toHaveBeenCalledWith(
        expect.objectContaining({ folderId: "f-1" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
    // TanStack Query 的 mutationFn 第二参为上下文对象，只断言业务入参
    await waitFor(() => expect(mockedCommit).toHaveBeenCalled());
    expect(mockedCommit.mock.calls[0]?.[0]).toMatchObject({
      folderId: "f-1",
    });
  });

  it("commit 返回 422 LINT_ERROR：_issues 并入错误面板，展示服务端消息", async () => {
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

describe("ImportPage 批量导入（T2A.3，D20）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** 选 3 个文件（1 个有 error）进入批量预览 */
  async function setupBatch(): Promise<void> {
    mockedPreviewBatch.mockResolvedValue({
      files: [
        batchFile("a.md"),
        batchFile("b.md"),
        batchFile("bad.md", {
          preview: previewData({ issues: ERRORS }),
          hasError: true,
        }),
      ],
    });
    const utils = renderImportPage();
    const fileInput = utils.container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput, {
      target: {
        files: [
          mdFile("a.md", PRACTICE_MD),
          mdFile("b.md", PRACTICE_MD),
          mdFile("bad.md", PRACTICE_MD),
        ],
      },
    });
    // 文件读取是异步的（file.text()）：等「已选择」计数出现再点预览
    expect(
      await screen.findByText(/已选择 3 个 \.md 文件/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
  }

  it("3 个文件走批量预览：表格渲染行摘要，有 error 的文件标红并显示复制全部错误按钮", async () => {
    await setupBatch();
    expect(mockedPreviewBatch).toHaveBeenCalledWith({
      autoFolderBySubdir: false,
      files: [
        { path: "a.md", markdown: PRACTICE_MD },
        { path: "b.md", markdown: PRACTICE_MD },
        { path: "bad.md", markdown: PRACTICE_MD },
      ],
    });
    // 表格行：3 个文件路径
    expect(await screen.findByText("a.md")).toBeInTheDocument();
    expect(screen.getByText("b.md")).toBeInTheDocument();
    expect(screen.getByText("bad.md")).toBeInTheDocument();
    // 复制全部错误（仅含有 error 的文件 → 1 个）
    expect(
      screen.getByRole("button", { name: /复制全部错误给 AI（1 个文件）/ }),
    ).toBeInTheDocument();
    // 导入全部按钮提示跳过数
    expect(
      screen.getByRole("button", { name: /导入全部（跳过 1 个有错误的）/ }),
    ).toBeInTheDocument();
  });

  it("提交：有 error 的文件自动跳过、其余逐个 commit 成功，显示汇总报告", async () => {
    await setupBatch();
    await screen.findByText("a.md");
    mockedCommit.mockResolvedValue({
      importId: "5b0b7ba4-6c07-4a5e-9df7-3b1e0d0b5c66",
      courseId: null,
      folderId: null,
      units: [
        { id: "练习四", title: "练习四", inserted: true, updated: false },
      ],
      lectures: [],
      questions: { inserted: 1, updated: 0 },
    });
    fireEvent.click(screen.getByRole("button", { name: /导入全部/ }));

    await waitFor(() => expect(mockedCommit).toHaveBeenCalledTimes(2));
    // commit payload：markdown + filename（basename）+ sourcePath + batchId
    const firstCall = mockedCommit.mock.calls[0]?.[0];
    expect(firstCall).toMatchObject({
      filename: "a.md",
      sourcePath: "a.md",
      markdown: PRACTICE_MD,
    });
    expect(typeof firstCall?.batchId).toBe("string");
    expect(mockedCommit.mock.calls[1]?.[0]).toMatchObject({
      sourcePath: "b.md",
      batchId: firstCall?.batchId,
    });
    // bad.md 未提交（跳过）
    expect(
      mockedCommit.mock.calls.some((call) => call[0]?.sourcePath === "bad.md"),
    ).toBe(false);

    // 汇总报告：成功 2 / 跳过 1 / 失败 0
    expect(
      await screen.findByText(/成功 2 \/ 跳过 1 \/ 失败 0/),
    ).toBeInTheDocument();
  });

  it("点击行展开单文件预览（CodeMirror 标红 + 渲染 + 动作清单）", async () => {
    await setupBatch();
    await screen.findByText("a.md");
    fireEvent.click(screen.getByRole("button", { name: "展开 a.md" }));

    expect(
      await screen.findByLabelText("Markdown 原文编辑器（带 lint 标注）"),
    ).toBeInTheDocument();
    expect(screen.getByText("将执行的动作")).toBeInTheDocument();
  });
});
