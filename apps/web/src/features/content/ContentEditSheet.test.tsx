import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  LectureDetail,
  QuestionDetail,
  QuestionUpdateData,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchLectureDetail,
  fetchQuestionDetail,
  updateLecture,
  updateQuestion,
} from "@/lib/api";
import { LectureEditSheet, QuestionEditSheet } from "./ContentEditSheet";

/**
 * 题目/讲义编辑抽屉组件测试（T1.12）：
 * - 打开：按 id 取原文填入编辑器（抽屉打开）；
 * - 本地 lint：error 级问题（type=essay）→ 保存禁用 + 错误面板标注；
 * - 保存成功回调：携带 sourceMd 调接口，成功后显示新版本提示并刷新内容树；
 * - 服务端 422（LINT_ERROR 附 _issues / ID_IMMUTABLE）回显抽屉内错误面板。
 * 2026-10 讲练一体：LectureEditSheet 按存储 kind 选 lint 语境与占位卡预览。
 * CodeMirror mock 为 textarea（与 ImportPage.test 同策略，真实集成走浏览器自验）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchQuestionDetail: vi.fn(),
    updateQuestion: vi.fn(),
    fetchLectureDetail: vi.fn(),
    updateLecture: vi.fn(),
  };
});

vi.mock("@/pages/teacher/MarkdownEditor", () => ({
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

const mockedFetchDetail = vi.mocked(fetchQuestionDetail);
const mockedUpdate = vi.mocked(updateQuestion);
const mockedFetchLecture = vi.mocked(fetchLectureDetail);
const mockedUpdateLecture = vi.mocked(updateLecture);

const QUESTION_MD = `::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$0$ 既不是正数，也不是负数。[[正确]]
::::`;

const DETAIL: QuestionDetail = {
  id: "练习四-1",
  unitId: "练习四",
  order: 0,
  type: "judge",
  difficulty: 1,
  knowledge: ["有理数的概念"],
  sourceMd: QUESTION_MD,
  version: 1,
};

function renderSheet(questionId = "练习四-1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  const rendered = render(
    <QueryClientProvider client={client}>
      <QuestionEditSheet questionId={questionId} onClose={() => {}} />
    </QueryClientProvider>,
  );
  return { invalidateSpy, ...rendered };
}

/** 编辑器 textarea（多行 value 不能用 getByDisplayValue：默认归一化空白） */
async function findEditor(): Promise<HTMLTextAreaElement> {
  return (await screen.findByLabelText(
    "Markdown 原文编辑器（带 lint 标注）",
  )) as HTMLTextAreaElement;
}

async function openSheet(detail: QuestionDetail = DETAIL) {
  mockedFetchDetail.mockResolvedValue(detail);
  renderSheet();
  await screen.findByText("编辑题目");
  const editor = await findEditor();
  await waitFor(() => expect(editor).toHaveValue(QUESTION_MD));
}

describe("QuestionEditSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("打开抽屉：按 id 取原文填入编辑器", async () => {
    await openSheet();
    expect(mockedFetchDetail).toHaveBeenCalledWith("练习四-1");
    expect(screen.getByText("练习四-1")).toBeInTheDocument();
    // 初始化 effect（text + debouncedText 同批设置）在高并发 worker 下可能
    // 晚一拍完成渲染：等待而非立即断言（语义不变：就绪后即可保存）
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /保存/ })).toBeEnabled(),
    );
  });

  it("本地 lint 命中 error（type=essay）：保存禁用，错误面板标注题目容器行", async () => {
    await openSheet();
    const broken = QUESTION_MD.replace("type=judge", "type=essay");
    fireEvent.change(
      screen.getByLabelText("Markdown 原文编辑器（带 lint 标注）"),
      { target: { value: broken } },
    );
    // 400ms debounce 后本地 lint 生效
    expect(
      await screen.findByText(/存在错误或题数\/id 不符/, undefined, {
        timeout: 2000,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /保存/ })).toBeDisabled();
    // 错误面板列出 lint issue（未知题型 code 出现在问题列表）
    expect(
      await screen.findAllByText("UNKNOWN_QUESTION_TYPE", undefined, {
        timeout: 2000,
      }),
    ).not.toHaveLength(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("清空题目容器（0 题）：报 PRACTICE_NO_QUESTIONS error 且不叠加同义 warning（2026-10-05 空练习守卫）", async () => {
    await openSheet();
    fireEvent.change(
      screen.getByLabelText("Markdown 原文编辑器（带 lint 标注）"),
      { target: { value: "只剩普通文本，题目容器被删了。" } },
    );
    expect(
      await screen.findAllByText("PRACTICE_NO_QUESTIONS", undefined, {
        timeout: 2000,
      }),
    ).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: /保存/ })).toBeDisabled();
    // 空练习守卫已报 error，不再叠加「未解析出任何题目」同义 warning
    expect(screen.queryByText(/未解析出任何题目/)).not.toBeInTheDocument();
  });

  it("改动题目 id：本地提示 id 不可变并禁用保存", async () => {
    await openSheet();
    const renamed = QUESTION_MD.replace(
      "{type=judge",
      "{id=my-new-q type=judge",
    );
    fireEvent.change(
      screen.getByLabelText("Markdown 原文编辑器（带 lint 标注）"),
      { target: { value: renamed } },
    );
    expect(
      await screen.findByText(/题目 id 不可变/, undefined, { timeout: 2000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /保存/ })).toBeDisabled();
  });

  it("保存成功回调：携带 sourceMd 调 updateQuestion，显示新版本提示并刷新内容树", async () => {
    const updated: QuestionUpdateData = {
      id: "练习四-1",
      version: 2,
      type: "judge",
      difficulty: 1,
      knowledge: ["有理数的概念"],
      issues: [],
    };
    mockedUpdate.mockResolvedValue(updated);
    const { invalidateSpy } = renderSheet();
    mockedFetchDetail.mockResolvedValue(DETAIL);
    const editor = await findEditor();
    await waitFor(() => expect(editor).toHaveValue(QUESTION_MD));

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalled());
    expect(mockedUpdate.mock.calls[0]?.[0]).toBe("练习四-1");
    expect(mockedUpdate.mock.calls[0]?.[1]).toEqual({ sourceMd: QUESTION_MD });
    expect(
      await screen.findByText("已保存为 v2（题目 id 不变）"),
    ).toBeInTheDocument();
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("服务端 422 LINT_ERROR：_issues 回显抽屉内错误面板", async () => {
    mockedUpdate.mockRejectedValue(
      new ApiError(
        "LINT_ERROR",
        "题目存在 1 个 error 级问题，请先修复后重试",
        422,
        {
          _issues: [
            {
              level: "error",
              line: 1,
              column: 1,
              code: "UNKNOWN_QUESTION_TYPE",
              message: "未知题型：essay",
            },
          ],
        },
      ),
    );
    await openSheet();
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    expect(
      await screen.findByText("题目存在 1 个 error 级问题，请先修复后重试"),
    ).toBeInTheDocument();
    expect(screen.getByText("未知题型：essay")).toBeInTheDocument();
  });

  it("服务端 422 ID_IMMUTABLE：显示中文提示，不出现 issue 面板", async () => {
    mockedUpdate.mockRejectedValue(
      new ApiError(
        "ID_IMMUTABLE",
        "题目 id 不可变（原 id「练习四-1」，解析出「练习四-9」）；如需新增题目请走导入",
        422,
      ),
    );
    await openSheet();
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    expect(
      await screen.findByText(/题目 id 不可变（原 id「练习四-1」/),
    ).toBeInTheDocument();
  });

  it("原文加载失败：错误态 + 重试", async () => {
    mockedFetchDetail.mockRejectedValueOnce(
      new Error("题目不存在（可能已被删除）"),
    );
    renderSheet();
    expect(await screen.findByText("原文加载失败")).toBeInTheDocument();
    expect(screen.getByText("题目不存在（可能已被删除）")).toBeInTheDocument();
    mockedFetchDetail.mockResolvedValue(DETAIL);
    screen.getByRole("button", { name: "重试" }).click();
    const editor = await findEditor();
    await waitFor(() => expect(editor).toHaveValue(QUESTION_MD));
  });
});

// ---------- LectureEditSheet：讲练一体（2026-10）kind 语境 ----------

/** 讲练页讲义（kind=lesson）：题块保留在正文原位（含注入 id） */
const LESSON_LECTURE_MD = [
  "# 第1讲 有理数讲练",
  "",
  "正文一段。",
  "",
  '::::question{type=judge difficulty=1 id="随堂讲练-1"}',
  "$0$ 是最小的正整数。[[错误]]",
  "::::",
  "",
  "题后一段正文。",
].join("\n");

const LESSON_DETAIL: LectureDetail = {
  id: "99999999-9999-4999-8999-999999999999",
  title: "第1讲 有理数讲练",
  kind: "lesson",
  markdown: LESSON_LECTURE_MD,
  updatedAt: "2026-10-12T00:00:00.000Z",
};

const LECTURE_DETAIL: LectureDetail = {
  ...LESSON_DETAIL,
  kind: "lecture",
  title: "第1讲 有理数",
  markdown: "# 第1讲 有理数\n\n正文一段。",
};

function renderLectureSheet() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LectureEditSheet lectureId={LESSON_DETAIL.id} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

async function openLectureSheet(detail: LectureDetail) {
  mockedFetchLecture.mockResolvedValue(detail);
  renderLectureSheet();
  await screen.findByText("编辑讲义");
  const editor = (await screen.findByLabelText(
    "Markdown 原文编辑器（带 lint 标注）",
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(editor).toHaveValue(detail.markdown));
  return editor;
}

describe("LectureEditSheet（讲练一体 kind 语境）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("kind=lesson：含题块的正文本地 lint 不报 QUESTION_IN_LECTURE（可保存），预览题块渲染占位卡", async () => {
    await openLectureSheet(LESSON_DETAIL);

    // lesson 语境 lint：题块合法 → 无错误提示、保存可用
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /保存/ })).toBeEnabled(),
    );
    expect(screen.queryByText(/存在错误/)).toBeNull();

    // 渲染预览：讲义正文照常渲染，题块显示占位卡（内容请在题库编辑）
    expect(await screen.findByText("正文一段。")).toBeInTheDocument();
    expect(screen.getByText("题后一段正文。")).toBeInTheDocument();
    expect(screen.getByText("内容请在题库编辑")).toBeInTheDocument();
    // 题干内容不在预览中渲染（占位卡取代题面）
    expect(screen.queryByText("$0$ 是最小的正整数。")).toBeNull();
  });

  it("对照 kind=lecture：塞入题块本地 lint 报 QUESTION_IN_LECTURE、保存禁用（与服务端同口径）", async () => {
    await openLectureSheet(LECTURE_DETAIL);
    fireEvent.change(
      screen.getByLabelText("Markdown 原文编辑器（带 lint 标注）"),
      {
        target: {
          value: `${LECTURE_DETAIL.markdown}\n\n::::question{type=judge id="q-x"}\n$1>0$。[[正确]]\n::::\n`,
        },
      },
    );
    // 400ms debounce 后本地 lint 生效：QUESTION_IN_LECTURE error → 保存禁用
    expect(
      await screen.findByText(/存在错误或 H1 数量不符/, undefined, {
        timeout: 2000,
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findAllByText("QUESTION_IN_LECTURE", undefined, {
        timeout: 2000,
      }),
    ).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: /保存/ })).toBeDisabled();
    expect(mockedUpdateLecture).not.toHaveBeenCalled();
  });

  it("kind=lecture：纯讲义无占位卡（题块占位仅 lesson 语境）", async () => {
    await openLectureSheet(LECTURE_DETAIL);
    expect(await screen.findByText("正文一段。")).toBeInTheDocument();
    expect(screen.queryByText("内容请在题库编辑")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /保存/ })).toBeEnabled(),
    );
  });
});
