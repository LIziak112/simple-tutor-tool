import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ImportBatchFilePreview,
  ImportPreviewData,
  LintIssue,
  MediaUploadResult,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  commitImport,
  createLibraryFolderApi,
  fetchLibraryFolders,
  fetchSpecFile,
  postTeacherMediaApi,
  previewImport,
  previewImportBatch,
} from "@/lib/api";
import ImportPage, { renamedPath } from "./ImportPage";

/**
 * 导入页组件测试（T1.11 建立；T2A.3 重构；内容模型方案 §5 统一待导入清单；
 * 媒体管线第四单：随行图片——选 md + 图片，只上传被引用到的、src 自动改写）：
 * - 选择页 = 一张清单：选择 md / 图片文件 / 选择文件夹（jsdom 无 webkitdirectory，
 *   目录入口不渲染）/「粘贴内容」展开小输入区加入条目；同 path 替换、移除、
 *   就地改名、规模预检实时红字；
 * - 随行图片：仅被引用图片调上传接口（多 md 同图去重、未引用不传不列）、
 *   上传成功后预览 payload 是改写后 md、上传中预览禁用、单图失败不阻断且
 *   src 不改写、同名冲突不配对；
 * - 粘贴条目 → 单文件预览（统计条、错误面板、debounce、commit payload 与成功跳转）；
 * - commit 422 LINT_ERROR 的 _issues 并入同一面板；
 * - 多条（文件/粘贴混合）→ 批量预览表格（mock previewImportBatch）：行摘要、
 *   有 error 文件标红、「复制全部错误」按钮；提交时有 error 文件自动跳过、
 *   其余逐个 commit、汇总报告。
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
    postTeacherMediaApi: vi.fn(),
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
const mockedUpload = vi.mocked(postTeacherMediaApi);

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

/** 服务端上传返回形态的 src 夹具（64 位 hex + png） */
const SERVER_SRC =
  "blobs/media/1111111111111111111111111111111111111111111111111111111111111111.png";

/** 构造图片 File（内容任意：前端不做魔数校验，真实格式校验在服务端） */
function imageFile(name: string): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, {
    type: "image/png",
  });
}

/** 给 File 挂相对路径（模拟文件夹选择/拖拽展开；jsdom File 构造不支持该属性） */
function withPath(file: File, path: string): File {
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

/** 打开粘贴区、输入内容并「加入清单」（filename 省略 = 用当前默认名） */
function addPasteEntry(markdown: string, filename?: string): void {
  // 粘贴区可能已展开（连续加多条时不再点开关）
  if (screen.queryByLabelText("文档内容") === null) {
    fireEvent.click(screen.getByRole("button", { name: "粘贴内容" }));
  }
  fireEvent.change(screen.getByLabelText("文档内容"), {
    target: { value: markdown },
  });
  if (filename !== undefined) {
    fireEvent.change(screen.getByLabelText("文件名（粘贴内容用）"), {
      target: { value: filename },
    });
  }
  fireEvent.click(screen.getByRole("button", { name: "加入清单" }));
}

/** 触发隐藏的文件选择 input（多选一次性传入）。
 * 按 accept 含 markdown 锁定 .md/图片多选 input（文件夹入口的
 * webkitdirectory 属性只在点击该按钮时才 setAttribute，静态选择器区分不了）。 */
function pickFiles(
  utils: ReturnType<typeof renderImportPage>,
  files: File[],
): void {
  const fileInput = utils.container.querySelector(
    'input[type="file"][accept*="markdown"]',
  ) as HTMLInputElement;
  expect(fileInput).not.toBeNull();
  fireEvent.change(fileInput, { target: { files } });
}

describe("ImportPage 选择页（方案 §5 统一待导入清单）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("渲染文件与粘贴入口、清单空态与目标文件夹下拉；粘贴区默认收起，清单空时预览禁用", async () => {
    renderImportPage();
    expect(
      screen.getByRole("button", { name: "选择 md / 图片文件" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "粘贴内容" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // 粘贴输入区默认收起；清单空态有明确提示
    expect(screen.queryByLabelText("文档内容")).not.toBeInTheDocument();
    expect(screen.getByText(/清单为空/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /预览/ })).toBeDisabled();

    // 文件夹下拉：未归类 + 拉到的文件夹（TanStack Query 异步）
    const folderSelect = await screen.findByLabelText("目标文件夹");
    expect(folderSelect).toHaveValue("none");
    expect(
      await screen.findByRole("option", { name: "第一章" }),
    ).toBeInTheDocument();
  });

  it("选择页顶部带「AI 出题助手」入口，默认收起且不发请求（T1.13）", () => {
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

  it("粘贴生成条目（默认未命名.md）并可就地改名；预览携带改名后的文件名", async () => {
    mockedPreview.mockResolvedValue(previewData({}));
    renderImportPage();
    addPasteEntry(PRACTICE_MD);
    // 条目以可编辑文件名进入清单（粘贴条目 Input 就地改名）
    expect(screen.getByLabelText("重命名 未命名.md")).toHaveValue("未命名.md");
    fireEvent.change(screen.getByLabelText("重命名 未命名.md"), {
      target: { value: "练习四.md" },
    });
    // 改名同步 path：旧标签消失，新标签可定位
    expect(screen.queryByLabelText("重命名 未命名.md")).not.toBeInTheDocument();
    expect(screen.getByLabelText("重命名 练习四.md")).toHaveValue("练习四.md");
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));

    await waitFor(() =>
      expect(mockedPreview).toHaveBeenCalledWith({
        markdown: PRACTICE_MD,
        filename: "练习四.md",
      }),
    );
  });

  it("连续两次粘贴：默认名自动避让（未命名.md、未命名-2.md），两条都保留", () => {
    renderImportPage();
    addPasteEntry(PRACTICE_MD);
    addPasteEntry(`${PRACTICE_MD}\n<!-- 第二段 -->`);
    expect(screen.getByLabelText("重命名 未命名.md")).toBeInTheDocument();
    expect(screen.getByLabelText("重命名 未命名-2.md")).toBeInTheDocument();
  });

  it("文件选择 = 追加进清单；同 path 重复选择 → 原位替换（保持最新内容）", async () => {
    mockedPreviewBatch.mockResolvedValue({
      files: [batchFile("a.md"), batchFile("b.md")],
    });
    const utils = renderImportPage();
    const aV1 = `# a\n\n${"x".repeat(600)}`;
    const bContent = `# b\n\n${"y".repeat(300)}`;
    const aV2 = `# a\n\n${"x".repeat(1200)}`;
    pickFiles(utils, [mdFile("a.md", aV1), mdFile("b.md", bContent)]);
    expect(await screen.findByLabelText("移除 a.md")).toBeInTheDocument();
    expect(screen.getByLabelText("移除 b.md")).toBeInTheDocument();

    // 再次选择 a.md（内容更新）→ 替换而非追加（大小从 0.6 KB 变 1.2 KB）
    pickFiles(utils, [mdFile("a.md", aV2)]);
    expect(await screen.findByText("1.2 KB")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/^移除 /)).toHaveLength(2);

    // 提交批量预览的 payload 里 a.md 是最新内容，且顺序保持（a.md 在前）
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await waitFor(() => expect(mockedPreviewBatch).toHaveBeenCalled());
    expect(mockedPreviewBatch.mock.calls[0]?.[0]).toMatchObject({
      files: [
        { path: "a.md", markdown: aV2 },
        { path: "b.md", markdown: bContent },
      ],
    });
  });

  it("同 path 重复选择给「更新同名」反馈行（用户改完本地文件重选时能确认拿到新内容）", async () => {
    const utils = renderImportPage();
    pickFiles(utils, [mdFile("a.md", "# a v1")]);
    expect(await screen.findByLabelText("移除 a.md")).toBeInTheDocument();
    pickFiles(utils, [mdFile("a.md", "# a v2")]);
    expect(
      await screen.findByText(/更新同名 1 条（已用所选文件的内容）/),
    ).toBeInTheDocument();
    expect(screen.getByRole("status").textContent).toContain("加入 0 条");
  });

  it("非 md / 图片文件被忽略并在反馈行说明（不再静默吞掉，选 4 进 3 时能看到差谁）", async () => {
    const utils = renderImportPage();
    const txt = new File(["说明"], "说明.txt", { type: "text/plain" });
    pickFiles(utils, [mdFile("a.md", "# a"), txt]);
    expect(await screen.findByLabelText("移除 a.md")).toBeInTheDocument();
    expect(screen.queryByLabelText(/移除 说明/)).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "已加入 1 条",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "忽略 1 个：说明.txt（非 .md 或图片文件）",
    );
  });

  it("文件条目可就地改名（与粘贴条目一致）；改名同步 path", async () => {
    const utils = renderImportPage();
    pickFiles(utils, [mdFile("旧名.md", "# a")]);
    const renameInput = await screen.findByLabelText("重命名 旧名.md");
    fireEvent.change(renameInput, { target: { value: "新名.md" } });
    expect(await screen.findByLabelText("移除 新名.md")).toBeInTheDocument();
    expect(screen.queryByLabelText("移除 旧名.md")).not.toBeInTheDocument();
  });

  it("文件夹条目改名保留子目录前缀（「按子目录自动建文件夹」依据不丢）", async () => {
    const utils = renderImportPage();
    const file = mdFile("a.md", "# a");
    // jsdom 的 File 构造不支持 webkitRelativePath，手工挂上模拟文件夹选择
    Object.defineProperty(file, "webkitRelativePath", {
      value: "第一章/a.md",
    });
    pickFiles(utils, [file]);
    const renameInput = await screen.findByLabelText("重命名 第一章/a.md");
    fireEvent.change(renameInput, { target: { value: "改.md" } });
    expect(
      await screen.findByLabelText("移除 第一章/改.md"),
    ).toBeInTheDocument();
  });

  it("renamedPath 纯函数：根级条目 path 即新名；带目录条目只换 basename", () => {
    expect(renamedPath("a.md", "b.md")).toBe("b.md");
    expect(renamedPath("第一章/a.md", "b.md")).toBe("第一章/b.md");
    expect(renamedPath("第一章/子目录/a.md", "b.md")).toBe(
      "第一章/子目录/b.md",
    );
  });

  it("移除条目：清单只剩 1 条文件时走单文件预览（1 条 → 单文件路由）", async () => {
    mockedPreview.mockResolvedValue(previewData({}));
    const utils = renderImportPage();
    pickFiles(utils, [
      mdFile("a.md", PRACTICE_MD),
      mdFile("b.md", PRACTICE_MD),
    ]);
    await screen.findByLabelText("移除 a.md");
    fireEvent.click(screen.getByLabelText("移除 a.md"));
    expect(screen.queryByLabelText("移除 a.md")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /预览/ })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    // 单文件预览统计条出现；preview 以剩余文件的 basename 为 filename
    expect(await screen.findByText("将执行的动作")).toBeInTheDocument();
    await waitFor(() =>
      expect(mockedPreview).toHaveBeenCalledWith(
        expect.objectContaining({ filename: "b.md", sourcePath: "b.md" }),
      ),
    );
  });

  it("规模预检实时化：粘贴超过 1 MB 的内容立即红字提示，点预览也不发请求", () => {
    renderImportPage();
    addPasteEntry(`${PRACTICE_MD}\n${"x".repeat(1024 * 1024)}`);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("超过单文件 1 MB 上限");
    // 预览按钮可点但被预检拦下：不发请求、停留在选择页
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    expect(mockedPreview).not.toHaveBeenCalled();
    expect(mockedPreviewBatch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "粘贴内容" }),
    ).toBeInTheDocument();
  });

  it("粘贴与文件混合清单：≥2 条走批量预览，粘贴条目以文件名为 path", async () => {
    mockedPreviewBatch.mockResolvedValue({
      files: [batchFile("未命名.md"), batchFile("a.md")],
    });
    const utils = renderImportPage();
    addPasteEntry(PRACTICE_MD);
    pickFiles(utils, [mdFile("a.md", PRACTICE_MD)]);
    await screen.findByLabelText("移除 a.md");
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));

    await waitFor(() =>
      expect(mockedPreviewBatch).toHaveBeenCalledWith({
        autoFolderBySubdir: false,
        files: [
          { path: "未命名.md", markdown: PRACTICE_MD },
          { path: "a.md", markdown: PRACTICE_MD },
        ],
      }),
    );
    // 批量表格渲染两条文件路径
    expect(await screen.findByText("未命名.md")).toBeInTheDocument();
    expect(screen.getByText("a.md")).toBeInTheDocument();
  });

  it("粘贴内容后点击预览：带正确 payload 调 previewImport，进入单文件预览态显示统计条", async () => {
    mockedPreview.mockResolvedValue(previewData({}));
    renderImportPage();
    addPasteEntry(PRACTICE_MD, "练习四.md");
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));

    await waitFor(() =>
      expect(mockedPreview).toHaveBeenCalledWith({
        markdown: PRACTICE_MD,
        filename: "练习四.md",
      }),
    );
    // 统计条：单元/讲义/题数（1/0/1）+ 实际存储名 + 题型分布 + 动作清单（D19/方案 §5）
    expect(await screen.findByText("将执行的动作")).toBeInTheDocument();
    expect(screen.getAllByText("1", { selector: "strong" })).toHaveLength(2);
    expect(screen.getByText("0", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("单元「练习四」")).toBeInTheDocument();
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
    addPasteEntry(PRACTICE_MD);
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));

    expect(await screen.findByText("将执行的动作")).toBeInTheDocument();
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

  it("统计条显示「文件 → 存储名」实际名称：单元名与讲义名并列（方案 §5）", async () => {
    mockedPreview.mockResolvedValue(
      previewData({
        summary: {
          unitCount: 1,
          lectureCount: 2,
          questionCount: 3,
          typeDistribution: { judge: 3 },
        },
        actions: [
          {
            kind: "createLecture",
            title: "第4讲 有理数",
            unitId: null,
            folderName: null,
            restore: false,
          },
          {
            kind: "createLecture",
            title: "第5讲 有理数加减",
            unitId: null,
            folderName: null,
            restore: false,
          },
          {
            kind: "createUnit",
            title: "练习四",
            unitId: "练习四",
            folderName: null,
            restore: false,
          },
        ],
      }),
    );
    renderImportPage();
    addPasteEntry(PRACTICE_MD, "混合.md");
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));

    expect(await screen.findByText("将执行的动作")).toBeInTheDocument();
    // 计数旁亮出实际名称：单元名在前；多篇讲义取首篇 +「等 N 篇」
    expect(
      screen.getByText("单元「练习四」 · 讲义「第4讲 有理数」等 2 篇"),
    ).toBeInTheDocument();
  });

  it("编辑器内容变化后 400ms debounce 重新调 preview", async () => {
    mockedPreview.mockResolvedValue(previewData({}));
    renderImportPage();
    addPasteEntry(PRACTICE_MD);
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await screen.findByText("将执行的动作");

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
    addPasteEntry(PRACTICE_MD);
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await screen.findByText("将执行的动作");
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

  it("预览态可就地改文件名（2026-10 审核修复）：改名后 commit 携带新文件名", async () => {
    mockedPreview.mockResolvedValue(previewData({}));
    mockedCommit.mockResolvedValue({
      importId: "5b0b7ba4-6c07-4a5e-9df7-3b1e0d0b5c67",
      courseId: null,
      folderId: null,
      units: [],
      lectures: [],
      questions: { inserted: 0, updated: 0 },
    });
    renderImportPage();
    addPasteEntry(PRACTICE_MD, "旧名.md");
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await screen.findByText("将执行的动作");

    // 编辑器头的「导入文件名」输入框改名 → 确认导入按新名提交
    fireEvent.change(screen.getByLabelText("导入文件名"), {
      target: { value: "新名.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
    await waitFor(() => expect(mockedCommit).toHaveBeenCalled());
    expect(mockedCommit.mock.calls[0]?.[0]).toMatchObject({
      filename: "新名.md",
    });
  });

  it("预览态文件名清空时确认导入禁用（契约要求非空）", async () => {
    mockedPreview.mockResolvedValue(previewData({}));
    renderImportPage();
    addPasteEntry(PRACTICE_MD, "旧名.md");
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await screen.findByText("将执行的动作");

    fireEvent.change(screen.getByLabelText("导入文件名"), {
      target: { value: "  " },
    });
    expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
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
    addPasteEntry(PRACTICE_MD);
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await screen.findByText("将执行的动作");

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
    addPasteEntry(PRACTICE_MD);
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await screen.findByText("将执行的动作");
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

  /** 选 3 个文件（1 个有 error 且无内容动作）进入批量预览 */
  async function setupBatch(): Promise<void> {
    mockedPreviewBatch.mockResolvedValue({
      files: [
        batchFile("a.md"),
        batchFile("b.md", {
          preview: previewData({
            summary: {
              unitCount: 0,
              lectureCount: 2,
              questionCount: 0,
              typeDistribution: {},
            },
            actions: [
              {
                kind: "createLecture",
                title: "第1讲 有理数",
                unitId: null,
                folderName: null,
                restore: false,
              },
              {
                kind: "createLecture",
                title: "第2讲 数轴",
                unitId: null,
                folderName: null,
                restore: false,
              },
            ],
          }),
        }),
        batchFile("bad.md", {
          preview: previewData({
            summary: {
              unitCount: 0,
              lectureCount: 0,
              questionCount: 0,
              typeDistribution: {},
            },
            actions: [],
            issues: ERRORS,
          }),
          hasError: true,
        }),
      ],
    });
    const utils = renderImportPage();
    pickFiles(utils, [
      mdFile("a.md", PRACTICE_MD),
      mdFile("b.md", PRACTICE_MD),
      mdFile("bad.md", PRACTICE_MD),
    ]);
    // 文件读取是异步的（file.text()）：等清单行出现再点预览
    expect(await screen.findByLabelText("移除 a.md")).toBeInTheDocument();
    expect(await screen.findByLabelText("移除 bad.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
  }

  it("3 个文件走批量预览：表格渲染行摘要与「文件 → 存储名」内容列，有 error 的文件标红并显示复制全部错误按钮", async () => {
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
    // 内容列 = 实际存储名（方案 §5）：单元带题数；多篇讲义取首篇 +「等 N 篇」；
    // 无动作 = 空文档
    expect(screen.getByText("单元「练习四」· 1 题")).toBeInTheDocument();
    expect(screen.getByText("讲义「第1讲 有理数」等 2 篇")).toBeInTheDocument();
    expect(screen.getByText("（空文档）")).toBeInTheDocument();
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

describe("ImportPage 随行图片（媒体管线第四单：只上传被引用的、src 自动改写）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("选择 md + 图片：仅被引用图片上传一次（多 md 同图去重、未引用不传不列），预览收到改写后 md，常驻提示与汇总卡可见", async () => {
    mockedUpload.mockResolvedValue({
      src: SERVER_SRC,
      bytes: 8,
    } satisfies MediaUploadResult);
    const mdA = '::image{alt="示意图" src="blobs/media/6a48.jpg"}';
    const mdB = '::image{src="6a48.jpg"}';
    const utils = renderImportPage();
    pickFiles(utils, [
      mdFile("a.md", mdA),
      mdFile("b.md", mdB),
      imageFile("6a48.jpg"),
      imageFile("未引用.png"),
    ]);
    expect(await screen.findByLabelText("移除 a.md")).toBeInTheDocument();

    // 只调一次上传、参数是被引用的文件；未引用的没进接口
    await waitFor(() => expect(mockedUpload).toHaveBeenCalledTimes(1));
    expect(mockedUpload.mock.calls[0]?.[0].name).toBe("6a48.jpg");
    expect(
      mockedUpload.mock.calls.some((call) => call[0].name === "未引用.png"),
    ).toBe(false);

    // 逐张列出上传结果（成功 → 服务器路径）；未引用只计数、不列为将上传
    expect(await screen.findByText(/→ blobs\/media\//)).toBeInTheDocument();
    expect(screen.getByText(/未被任何文档引用，不会上传/)).toBeInTheDocument();
    expect(screen.queryByText("未引用.png")).not.toBeInTheDocument();

    // 选择区常驻提示可见（任务口径：可一起选择、只上传被引用的并替换引用）
    expect(
      screen.getByText(/系统只会自动上传文档引用到的图片/),
    ).toBeInTheDocument();

    // 上传结束后预览可点：批量预览 payload 是改写后 md（alt 保留、仅 src 值变）
    mockedPreviewBatch.mockResolvedValue({
      files: [batchFile("a.md"), batchFile("b.md")],
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /预览/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await waitFor(() => expect(mockedPreviewBatch).toHaveBeenCalled());
    expect(mockedPreviewBatch.mock.calls[0]?.[0]).toMatchObject({
      files: [
        { path: "a.md", markdown: `::image{alt="示意图" src="${SERVER_SRC}"}` },
        { path: "b.md", markdown: `::image{src="${SERVER_SRC}"}` },
      ],
    });

    // 预览/确认步骤的汇总卡：md ×N + 自动上传图片 ×N（成功/失败分列）
    expect(
      await screen.findByText(
        /本批将导入 Markdown 2 份，识别并自动上传关联图片 1 张（成功 1 \/ 失败 0）/,
      ),
    ).toBeInTheDocument();
  });

  it("上传中「预览」禁用并显示进度；传完自动恢复可点", async () => {
    let release!: (value: MediaUploadResult) => void;
    mockedUpload.mockImplementation(
      () =>
        new Promise<MediaUploadResult>((resolve) => {
          release = resolve;
        }),
    );
    const utils = renderImportPage();
    pickFiles(utils, [
      mdFile("a.md", '::image{src="配图.jpg"}'),
      imageFile("配图.jpg"),
    ]);
    // 先等 md 条目真正进清单（此前按钮因清单为空而禁用，不能当作上传中证据）
    expect(await screen.findByLabelText("移除 a.md")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /预览/ })).toBeDisabled(),
    );
    expect(screen.getByText(/正在自动上传关联图片/)).toBeInTheDocument();

    release({ src: SERVER_SRC, bytes: 8 });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /预览/ })).toBeEnabled(),
    );
  });

  it("单图失败不阻断：失败原因逐张透出、src 不改写（预览 payload 原样），汇总卡计入失败与未解决引用", async () => {
    mockedUpload.mockRejectedValue(
      new ApiError(
        "MEDIA_TOO_LARGE",
        "图片超过 5MB 上传上限，请压缩后重试",
        413,
      ),
    );
    const md = '::image{src="blobs/media/大图.jpg"}';
    const utils = renderImportPage();
    pickFiles(utils, [mdFile("a.md", md), imageFile("大图.jpg")]);
    expect(
      await screen.findByText(/图片超过 5MB 上传上限，请压缩后重试/),
    ).toBeInTheDocument();
    expect(screen.getByText(/失败 1/)).toBeInTheDocument();

    mockedPreview.mockResolvedValue(previewData({}));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /预览/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await waitFor(() => expect(mockedPreview).toHaveBeenCalled());
    // 失败图对应的 src 不改写：预览拿到的是原文
    expect(mockedPreview.mock.calls[0]?.[0].markdown).toBe(md);
    // 汇总卡：失败明细（名字 + 原因）与保持原样的引用处数
    expect(
      await screen.findByText(/大图.jpg：图片超过 5MB 上传上限/),
    ).toBeInTheDocument();
    expect(screen.getByText(/失败 1）/)).toBeInTheDocument();
    expect(screen.getByText(/未配对或上传失败的引用 1 处/)).toBeInTheDocument();
  });

  it("同名多图冲突：不配对、不上传、不改写，冲突提示可见", async () => {
    const md = '::image{src="blobs/media/img.jpg"}';
    const utils = renderImportPage();
    pickFiles(utils, [
      mdFile("a.md", md),
      withPath(imageFile("img.jpg"), "章节一/img.jpg"),
      withPath(imageFile("img.jpg"), "章节二/img.jpg"),
    ]);
    expect(await screen.findByText(/同名冲突/)).toBeInTheDocument();
    expect(
      screen.getByText(/无法确定「blobs\/media\/img.jpg」对应哪一张/),
    ).toBeInTheDocument();
    expect(mockedUpload).not.toHaveBeenCalled();

    mockedPreview.mockResolvedValue(previewData({}));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /预览/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await waitFor(() => expect(mockedPreview).toHaveBeenCalled());
    expect(mockedPreview.mock.calls[0]?.[0].markdown).toBe(md);
    expect(screen.getByText(/未配对或上传失败的引用 1 处/)).toBeInTheDocument();
  });

  it("配对优先级：src 与相对路径完全一致优先于 basename 命中", async () => {
    mockedUpload.mockResolvedValue({
      src: SERVER_SRC,
      bytes: 8,
    } satisfies MediaUploadResult);
    const utils = renderImportPage();
    const exact = withPath(imageFile("img.jpg"), "blobs/media/img.jpg");
    const other = withPath(imageFile("img.jpg"), "其他目录/img.jpg");
    pickFiles(utils, [
      mdFile("a.md", '::image{src="blobs/media/img.jpg"}'),
      exact,
      other,
    ]);
    await waitFor(() => expect(mockedUpload).toHaveBeenCalledTimes(1));
    // 上传的是精确路径命中的那份（同一 File 实例）
    expect(mockedUpload.mock.calls[0]?.[0]).toBe(exact);
  });

  it("失败图片可整组重试：重试成功后 src 补改写", async () => {
    mockedUpload
      .mockRejectedValueOnce(new Error("网络中断，请稍后重试"))
      .mockResolvedValueOnce({
        src: SERVER_SRC,
        bytes: 8,
      } satisfies MediaUploadResult);
    const md = '::image{src="配图.jpg"}';
    const utils = renderImportPage();
    pickFiles(utils, [mdFile("a.md", md), imageFile("配图.jpg")]);
    expect(await screen.findByText(/网络中断，请稍后重试/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /重试失败图片（1 张）/ }),
    );
    expect(await screen.findByText(/→ blobs\/media\//)).toBeInTheDocument();

    mockedPreview.mockResolvedValue(previewData({}));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /预览/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /预览/ }));
    await waitFor(() => expect(mockedPreview).toHaveBeenCalled());
    // 重试成功后进入预览的是改写后的 md
    expect(mockedPreview.mock.calls[0]?.[0].markdown).toBe(
      `::image{src="${SERVER_SRC}"}`,
    );
  });
});
