import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReviewPackPreviewData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportReviewImageSection } from "./ExportReviewImageSection";

/**
 * T6R.19 合成图导出区组件测试（三态/失败回落/学生红线/剪贴板降级）：
 * - 三态：idle 按钮 → loading（禁用防重复）→ done（已导出 N 张＋文件名）；
 * - 失败回落：错误显式中文原因＋指引既有出口，绝不显示「已导出」；
 * - 学生红线文案在场（不含参考答案口径）；教师视角注明含答案；
 * - 复制图片：单页成功即显示「复制图片」（审查修复轮——曾误写 >1 致单页
 *   无入口），多页显示「复制第一张图片」；
 * - preview 换新重置导出状态（旧「已导出」不残留）；
 * - 复制图片降级：clipboard 不可用 → 提示改用下载文件，不显示「已复制」。
 */

vi.mock("./export-review-image", async (importActual) => ({
  // 常量（红线文案）用真实实现，只替换异步导出函数
  ...(await importActual<typeof import("./export-review-image")>()),
  exportReviewImages: vi.fn(),
}));

vi.mock("@/lib/copy", () => ({
  copyPngBlobToClipboard: vi.fn(),
}));

import { copyPngBlobToClipboard } from "@/lib/copy";
import { exportReviewImages } from "./export-review-image";

const STUDENT_PREVIEW: ReviewPackPreviewData = {
  role: "student",
  questionNo: 3,
  questionPresent: true,
  handwritten: false,
  evidenceState: "frozen",
  released: true,
  answersIncluded: false,
  complete: true,
  files: [],
  missing: [],
  attachments: [
    {
      path: "evidence/e001-original-01.png",
      kind: "evidence",
      state: "ready",
      bytes: 4096,
      downloadUrl: "/api/student/note-versions/v1/images/i1.png",
    },
  ],
  reviewMd: "",
  questionMd: "### 题目 3\n\n题面。\n\n**学生答案**：B\n",
};

const pngBlob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
  type: "image/png",
});

beforeEach(() => {
  vi.mocked(exportReviewImages).mockReset();
  vi.mocked(copyPngBlobToClipboard).mockReset();
});

function renderSection(
  preview: ReviewPackPreviewData = STUDENT_PREVIEW,
): ReturnType<typeof render> {
  return render(<ExportReviewImageSection preview={preview} />);
}

describe("ExportReviewImageSection（T6R.19 三态与红线）", () => {
  it("idle：按钮与学生红线文案在场（不含参考答案口径）", () => {
    renderSection();
    expect(
      screen.getByRole("button", { name: /导出合成图（PNG）/ }),
    ).toBeVisible();
    expect(screen.getByText(/不含参考答案与对错判定/)).toBeVisible();
  });

  it("教师视角：文案注明含参考答案与判定", () => {
    renderSection({
      ...STUDENT_PREVIEW,
      role: "teacher",
      answersIncluded: true,
    });
    expect(screen.getByText(/含参考答案、判定与评语/)).toBeVisible();
    expect(screen.queryByText(/不含参考答案与对错判定/)).toBeNull();
  });

  it("loading → done：先禁用防重复，成功后显示张数与文件名", async () => {
    let resolveExport: (value: {
      ok: true;
      pages: Array<{ filename: string; bytes: number; blob: Blob }>;
    }) => void = () => {};
    vi.mocked(exportReviewImages).mockReturnValue(
      new Promise((resolve) => {
        resolveExport = resolve;
      }),
    );
    renderSection();
    await fireEvent.click(
      screen.getByRole("button", { name: /导出合成图（PNG）/ }),
    );
    // loading 态：按钮禁用、显示进行中文案
    expect(
      screen.getByRole("button", { name: /正在生成合成图/ }),
    ).toBeDisabled();
    resolveExport({
      ok: true,
      pages: [
        {
          filename: "review-image-q3-student-01.png",
          bytes: 4096,
          blob: pngBlob,
        },
      ],
    });
    await waitFor(() => {
      expect(screen.getByText(/已导出 1 张 PNG/)).toBeVisible();
    });
    expect(screen.getByText(/review-image-q3-student-01\.png/)).toBeVisible();
  });

  it("单页成功：显示「复制图片」入口（审查修复轮——曾误写 >1 致单页无入口）", async () => {
    vi.mocked(exportReviewImages).mockResolvedValue({
      ok: true,
      pages: [
        {
          filename: "review-image-q3-student-01.png",
          bytes: 4096,
          blob: pngBlob,
        },
      ],
    });
    renderSection();
    await fireEvent.click(
      screen.getByRole("button", { name: /导出合成图（PNG）/ }),
    );
    expect(
      await screen.findByRole("button", { name: /^复制图片$/ }),
    ).toBeVisible();
    // 多页文案不出现（文案随页数区分）
    expect(screen.queryByRole("button", { name: /复制第一张图片/ })).toBeNull();
  });

  it("多页成功提示多文件下载权限（浏览器询问时选择允许）", async () => {
    vi.mocked(exportReviewImages).mockResolvedValue({
      ok: true,
      pages: [
        {
          filename: "review-image-q3-student-01.png",
          bytes: 4096,
          blob: pngBlob,
        },
        {
          filename: "review-image-q3-student-02.png",
          bytes: 4096,
          blob: pngBlob,
        },
      ],
    });
    renderSection();
    await fireEvent.click(
      screen.getByRole("button", { name: /导出合成图（PNG）/ }),
    );
    expect(await screen.findByText(/是否允许下载多个文件/)).toBeVisible();
  });

  it("preview 换新（面板重试/重开）：导出状态重置回 idle，旧「已导出」不残留", async () => {
    vi.mocked(exportReviewImages).mockResolvedValue({
      ok: true,
      pages: [
        {
          filename: "review-image-q3-student-01.png",
          bytes: 4096,
          blob: pngBlob,
        },
      ],
    });
    const { rerender } = renderSection();
    await fireEvent.click(
      screen.getByRole("button", { name: /导出合成图（PNG）/ }),
    );
    await waitFor(() => {
      expect(screen.getByText(/已导出 1 张 PNG/)).toBeVisible();
    });
    // preview 载荷换新（新对象）：旧材料的导出结果不得残留
    rerender(
      <ExportReviewImageSection
        preview={{ ...STUDENT_PREVIEW, questionNo: 4 }}
      />,
    );
    expect(screen.queryByText(/已导出/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^复制图片$/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: /导出合成图（PNG）/ }),
    ).toBeVisible();
  });

  it("失败：显式中文原因＋指引既有出口，绝不显示「已导出」", async () => {
    vi.mocked(exportReviewImages).mockResolvedValue({
      ok: false,
      error: { kind: "font", message: "本地字体嵌入失败（样式表不可读）" },
    });
    renderSection();
    await fireEvent.click(
      screen.getByRole("button", { name: /导出合成图（PNG）/ }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("合成图导出失败：本地字体嵌入失败");
    expect(alert).toHaveTextContent("下载完整包（zip）");
    expect(screen.queryByText(/已导出/)).toBeNull();
  });

  it("多页成功：显示复制第一张图片按钮；复制不可用→提示改用下载，不显示已复制", async () => {
    vi.mocked(exportReviewImages).mockResolvedValue({
      ok: true,
      pages: [
        {
          filename: "review-image-q3-student-01.png",
          bytes: 4096,
          blob: pngBlob,
        },
        {
          filename: "review-image-q3-student-02.png",
          bytes: 4096,
          blob: pngBlob,
        },
      ],
    });
    vi.mocked(copyPngBlobToClipboard).mockResolvedValue(false);
    renderSection();
    await fireEvent.click(
      screen.getByRole("button", { name: /导出合成图（PNG）/ }),
    );
    const copyButton = await screen.findByRole("button", {
      name: /复制第一张图片/,
    });
    await fireEvent.click(copyButton);
    expect(await screen.findByText(/不支持复制图片/)).toBeVisible();
    expect(screen.queryByText(/已复制/)).toBeNull();
  });

  it("复制成功：显示已复制（多页说明其余走下载文件）", async () => {
    vi.mocked(exportReviewImages).mockResolvedValue({
      ok: true,
      pages: [
        {
          filename: "review-image-q3-student-01.png",
          bytes: 4096,
          blob: pngBlob,
        },
        {
          filename: "review-image-q3-student-02.png",
          bytes: 4096,
          blob: pngBlob,
        },
      ],
    });
    vi.mocked(copyPngBlobToClipboard).mockResolvedValue(true);
    renderSection();
    await fireEvent.click(
      screen.getByRole("button", { name: /导出合成图（PNG）/ }),
    );
    await fireEvent.click(
      await screen.findByRole("button", { name: /复制第一张图片/ }),
    );
    expect(await screen.findByText(/已复制第一张图片/)).toBeVisible();
  });
});
