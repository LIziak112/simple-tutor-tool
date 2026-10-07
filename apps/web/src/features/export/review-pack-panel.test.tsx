import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReviewPackPreviewData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewPackPanel } from "./review-pack-panel";

/**
 * T6R.13 单题完整导出面板测试（任务清单失败测试逐项——前端能力面）：
 * - 网络失败：预览/下载请求失败给中文错误与重试入口，不显示成功；
 * - 下载失败：zip 接口错误（服务端错误壳）同样显式报错；
 * - HTTP 无 clipboard / 失去用户手势：copyText 返回 false → 手工选中文本块
 *   （只读 textarea），不显示「已复制」；
 * - 复制语义红线：按钮与提示只能说「复制文字（不含图片）」，绝不出现
 *   「全部复制／文字图片全复制」类误导文案；
 * - 图片权限过期：逐张下载 401/403 → 该图片行内错误（登录可能已过期），
 *   不静默声称成功；
 * - 缺失清单：complete=false 显示「材料不完整」警示与缺失原因（不自动
 *   声称 AI 可诊断）；
 * - 跨账号缓存：每次打开都重新请求（响应 no-store），不同 attempt 的面板
 *   各自请求各自的参数。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    fetchReviewPackPreviewApi: vi.fn(),
    downloadReviewPackApi: vi.fn(),
    downloadAttachmentApi: vi.fn(),
  };
});

vi.mock("@/lib/copy", () => ({
  copyText: vi.fn(),
}));

import {
  downloadAttachmentApi,
  downloadReviewPackApi,
  fetchReviewPackPreviewApi,
} from "@/lib/api";
import { copyText } from "@/lib/copy";

const PREVIEW: ReviewPackPreviewData = {
  role: "student",
  questionNo: 3,
  questionPresent: true,
  evidenceState: "frozen",
  released: true,
  answersIncluded: false,
  complete: false,
  files: [
    { path: "review.md", kind: "review", bytes: 1024, refs: [] },
    { path: "pack.json", kind: "pack", bytes: 2048, refs: [] },
    {
      path: "questions/q001/stem.md",
      kind: "question-md",
      bytes: 512,
      refs: [],
    },
    {
      path: "evidence/e001-original-01.png",
      kind: "evidence",
      bytes: 4096,
      refs: [],
    },
  ],
  missing: [
    {
      path: "evidence/e001-original-02.png",
      kind: "evidence-image",
      reason: "分析图生成失败",
      refs: ["e001"],
    },
  ],
  attachments: [
    {
      path: "evidence/e001-original-01.png",
      kind: "evidence",
      state: "ready",
      bytes: 4096,
      downloadUrl: "/api/student/note-versions/v1/images/i1.png",
    },
    {
      path: "evidence/e001-original-02.png",
      kind: "evidence",
      state: "missing",
      bytes: 0,
      reason: "分析图生成失败",
    },
  ],
  reviewMd: "# 单题复习包（第 3 题）\n\n复制文字给 AI 时不含任何图片。",
};

const COMPLETE_PREVIEW: ReviewPackPreviewData = {
  ...PREVIEW,
  complete: true,
  missing: [],
  attachments: PREVIEW.attachments.slice(0, 1),
};

beforeEach(() => {
  vi.mocked(fetchReviewPackPreviewApi).mockReset();
  vi.mocked(downloadReviewPackApi).mockReset();
  vi.mocked(downloadAttachmentApi).mockReset();
  vi.mocked(copyText).mockReset();
});

async function openPanel(preview: ReviewPackPreviewData = PREVIEW) {
  vi.mocked(fetchReviewPackPreviewApi).mockResolvedValue(preview);
  render(
    <ReviewPackPanel
      viewer="student"
      attemptId="attempt-1"
      questionId="q-1"
      questionNo={3}
    />,
  );
  await fireEvent.click(screen.getByRole("button", { name: /AI 复习包/ }));
  await waitFor(() => {
    expect(screen.getByText("附件清单")).toBeVisible();
  });
}

describe("ReviewPackPanel（T6R.13）", () => {
  it("打开即取预览：文件清单、缺失警示（不自动声称可诊断）、复制按钮只说不含图片", async () => {
    await openPanel();
    // 附件清单与缺失原因（警示区 + 清单区 + 图片区多处出现）
    expect(
      screen.getAllByText(/evidence\/e001-original-02\.png/).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/分析图生成失败/).length).toBeGreaterThanOrEqual(
      1,
    );
    // 不完整警示
    expect(screen.getByText(/材料不完整/)).toBeVisible();
    expect(screen.getByText(/无法基于原稿诊断/)).toBeVisible();
    // 复制语义红线：只见「复制文字（不含图片）」，绝无「全部复制」
    const copyButton = screen.getByRole("button", {
      name: /复制文字（不含图片）/,
    });
    expect(copyButton).toBeVisible();
    for (const misleading of [/全部复制/, /文字图片全复制/, /图片一起复制/]) {
      expect(document.body.textContent ?? "").not.toMatch(misleading);
    }
    // 参数正确传递（跨账号：各面板请求各自 attempt）
    expect(fetchReviewPackPreviewApi).toHaveBeenCalledWith(
      "student",
      "attempt-1",
      "q-1",
    );
  });

  it("完整包：无不完整警示；学生视角说明不含参考答案", async () => {
    await openPanel(COMPLETE_PREVIEW);
    expect(screen.queryByText(/材料不完整/)).toBeNull();
    expect(screen.getByText(/不含参考答案/)).toBeVisible();
  });

  it("预览网络失败：错误与重试，不显示清单", async () => {
    vi.mocked(fetchReviewPackPreviewApi).mockRejectedValue(
      new Error("连不上服务器"),
    );
    render(
      <ReviewPackPanel
        viewer="student"
        attemptId="attempt-1"
        questionId="q-1"
        questionNo={3}
      />,
    );
    await fireEvent.click(screen.getByRole("button", { name: /AI 复习包/ }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("连不上服务器");
    });
    expect(screen.queryByText("附件清单")).toBeNull();
    // 重试入口存在
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
  });

  it("下载网络失败：报错不显示成功；再点可重试", async () => {
    await openPanel();
    vi.mocked(downloadReviewPackApi).mockRejectedValueOnce(
      new Error("连不上服务器，请检查网络后重试"),
    );
    await fireEvent.click(screen.getByRole("button", { name: /下载完整包/ }));
    await waitFor(() => {
      expect(
        screen
          .getAllByRole("alert")
          .some((el) => el.textContent?.includes("连不上服务器")),
      ).toBe(true);
    });
    expect(screen.queryByText(/已下载/)).toBeNull();
    // 第二次成功 → 显示实际文件名
    vi.mocked(downloadReviewPackApi).mockResolvedValueOnce(
      "review-pack-q3-20261007-120000.zip",
    );
    await fireEvent.click(screen.getByRole("button", { name: /下载完整包/ }));
    await waitFor(() => {
      expect(
        screen.getByText(/review-pack-q3-20261007-120000\.zip/),
      ).toBeVisible();
    });
  });

  it("复制成功：提示已复制且注明图片需另行处理；无手工选中块", async () => {
    await openPanel();
    vi.mocked(copyText).mockResolvedValueOnce(true);
    await fireEvent.click(
      screen.getByRole("button", { name: /复制文字（不含图片）/ }),
    );
    await waitFor(() => {
      expect(screen.getByText(/已复制/)).toBeVisible();
    });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("HTTP 无 clipboard／失去用户手势：copyText 失败 → 手工选中文本块（内容即 reviewMd）", async () => {
    await openPanel();
    vi.mocked(copyText).mockResolvedValueOnce(false);
    await fireEvent.click(
      screen.getByRole("button", { name: /复制文字（不含图片）/ }),
    );
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeVisible();
    });
    expect(screen.queryByText(/已复制文字/)).toBeNull();
    expect(
      (screen.getByRole("textbox") as HTMLTextAreaElement).value,
    ).toContain("复制文字给 AI 时不含任何图片");
    expect(screen.getByText(/手动选择|长按|拖选/)).toBeVisible();
  });

  it("逐张下载：成功无错误；401 权限过期 → 行内错误不声称成功", async () => {
    await openPanel();
    // 唯一 ready 附件的下载按钮（精确名「下载」，区别于「下载完整包」）
    const downloadButton = screen.getByRole("button", { name: "下载" });
    // 第一次失败（权限过期）
    vi.mocked(downloadAttachmentApi).mockRejectedValueOnce(
      new Error("没有权限读取这张图片（登录可能已过期，请刷新页面后重试）"),
    );
    await fireEvent.click(downloadButton);
    await waitFor(() => {
      expect(screen.getByText(/登录可能已过期/)).toBeVisible();
    });
    // 重试成功 → 行内错误消失
    vi.mocked(downloadAttachmentApi).mockResolvedValueOnce(undefined);
    await fireEvent.click(downloadButton);
    await waitFor(() => {
      expect(screen.queryByText(/登录可能已过期/)).toBeNull();
    });
    expect(downloadAttachmentApi).toHaveBeenCalledWith(
      "/api/student/note-versions/v1/images/i1.png",
      "e001-original-01.png",
    );
  });

  it("缺失附件不提供下载按钮，只显示原因", async () => {
    await openPanel();
    // 图片区缺失行：路径 span 精确匹配唯一（警示/清单区文本是组合节点）
    const missingSpan = screen.getByText("evidence/e001-original-02.png");
    const missingItem = missingSpan.closest("li");
    expect(missingItem).not.toBeNull();
    expect(missingItem?.querySelector("button")).toBeNull();
    expect(missingItem).toHaveTextContent("分析图生成失败");
  });

  it("每次打开重新请求预览（no-store，不沿用上一次结果）", async () => {
    vi.mocked(fetchReviewPackPreviewApi).mockResolvedValue(COMPLETE_PREVIEW);
    const { unmount } = render(
      <ReviewPackPanel
        viewer="student"
        attemptId="attempt-1"
        questionId="q-1"
        questionNo={3}
      />,
    );
    await fireEvent.click(screen.getByRole("button", { name: /AI 复习包/ }));
    await waitFor(() => {
      expect(screen.getByText("附件清单")).toBeVisible();
    });
    unmount();
    render(
      <ReviewPackPanel
        viewer="student"
        attemptId="attempt-2"
        questionId="q-2"
        questionNo={1}
      />,
    );
    await fireEvent.click(screen.getByRole("button", { name: /AI 复习包/ }));
    await waitFor(() => {
      expect(fetchReviewPackPreviewApi).toHaveBeenLastCalledWith(
        "student",
        "attempt-2",
        "q-2",
      );
    });
  });
});
