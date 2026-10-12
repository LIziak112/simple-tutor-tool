import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { SharedFileSummary } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { previewSharedFile } from "@/lib/api";
import { SharedPreviewSheet } from "./SharedPreviewSheet";

/**
 * 共享文件预览抽屉（2026-10 讲练一体覆盖）：lesson 文档（frontmatter
 * kind: lesson）的题块渲染占位卡；lecture/mixed/practice 文档题块照常渲染
 * （预览的是文件内容本身，练习类文件教师需要看到题面）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    previewSharedFile: vi.fn(),
  };
});

const mockedPreview = vi.mocked(previewSharedFile);

const FILE: SharedFileSummary = {
  filename: "随堂讲练.md",
  kind: "lecture",
  title: "随堂讲练",
  questionCount: 1,
  publisher: "同行老师",
  publishedAt: "2026-10-12T00:00:00.000Z",
  source: "published",
  canDelete: false,
};

function renderSheet() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SharedPreviewSheet file={FILE} onClose={() => {}} onImport={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedPreview.mockReset();
});

describe("SharedPreviewSheet：讲练页题块占位（2026-10 讲练一体）", () => {
  it("frontmatter kind: lesson 的共享文件：题块渲染占位卡，讲义正文照常渲染", async () => {
    mockedPreview.mockResolvedValue({
      summary: {
        unitCount: 1,
        lectureCount: 1,
        questionCount: 1,
        typeDistribution: { judge: 1 },
      },
      issues: [],
      actions: [],
      warnings: [],
      markdown: [
        "---",
        "kind: lesson",
        "---",
        "",
        "# 随堂讲练",
        "",
        "正文一段。",
        "",
        '::::question{type=judge id="sh-1"}',
        "$0$ 是最小的正整数。[[错误]]",
        "::::",
      ].join("\n"),
    });
    renderSheet();

    expect(await screen.findByText("正文一段。")).toBeInTheDocument();
    expect(screen.getByText("内容请在题库编辑")).toBeInTheDocument();
    expect(screen.queryByText("$0$ 是最小的正整数。")).toBeNull();
  });

  it("kind: mixed / practice 文档：题块照常渲染题面（占位卡仅 lesson）", async () => {
    mockedPreview.mockResolvedValue({
      summary: {
        unitCount: 1,
        lectureCount: 1,
        questionCount: 1,
        typeDistribution: { judge: 1 },
      },
      issues: [],
      actions: [],
      warnings: [],
      markdown: [
        "---",
        "kind: mixed",
        "---",
        "",
        "# 随堂讲练",
        "",
        '::::question{type=judge id="sh-1"}',
        "$0$ 是最小的正整数。[[错误]]",
        "::::",
      ].join("\n"),
    });
    renderSheet();

    expect(
      await screen.findByText(/是最小的正整数。/, undefined, {
        timeout: 3000,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("内容请在题库编辑")).toBeNull();
  });
});
