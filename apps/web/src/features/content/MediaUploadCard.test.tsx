import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, postTeacherMediaApi } from "@/lib/api";
import { buildImageSnippet, MediaUploadCard } from "./MediaUploadCard";

/**
 * "图片上传"小卡组件测试（媒体管线第三单验收项）：
 * - 成功路径：选择图片 → 上传 → 展示 src 与 ::image 片段；填 alt 后片段更新；
 *   复制按钮写入剪贴板的内容即片段，且出现「已复制」反馈；
 * - 上传中：按钮禁用 + 进行中状态文案；
 * - 失败路径：服务端中文文案（413/415）原样透出（role=alert）；
 * - buildImageSnippet 纯函数：alt 留空不带属性。
 * postTeacherMediaApi 打桩（真实接口链路在 teacher-media.test.ts 覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    postTeacherMediaApi: vi.fn(),
  };
});

const mockedUpload = vi.mocked(postTeacherMediaApi);

/** 契约合法形态的返回 src（64 位 hex + png） */
const FAKE_SRC =
  "blobs/media/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png";

function mountClipboard(resolve = true): ReturnType<typeof vi.fn> {
  const writeText = resolve
    ? vi.fn().mockResolvedValue(undefined)
    : vi.fn().mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

/** 通过隐藏 file input 选择一张图片（同 ImportPage 的 input 快照口径） */
function selectImage(): void {
  const input = document.querySelector('input[type="file"]');
  if (input === null) throw new Error("测试夹具：找不到图片选择 input");
  const file = new File([new Uint8Array([0x89, 0x50])], "配图.png", {
    type: "image/png",
  });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  mockedUpload.mockReset();
  mountClipboard();
});

describe("MediaUploadCard（图片上传小卡）", () => {
  it("成功路径：上传后展示 src 与片段；填 alt 片段更新；复制写入剪贴板并给反馈", async () => {
    const writeText = mountClipboard();
    mockedUpload.mockResolvedValue({ src: FAKE_SRC, bytes: 1234 });
    render(<MediaUploadCard />);

    selectImage();

    // 成功态：src 路径与片段出现（alt 留空 → 片段不带 alt）
    const preview = await screen.findByLabelText("::image 片段预览");
    expect(preview.textContent).toBe(`::image{src="${FAKE_SRC}"}`);
    expect(screen.getByText(FAKE_SRC)).toBeInTheDocument();
    expect(mockedUpload).toHaveBeenCalledTimes(1);
    // multipart 组装：把 File 原样交给接口层
    const sent = mockedUpload.mock.calls[0]?.[0];
    expect(sent).toBeInstanceOf(File);
    expect(sent?.name).toBe("配图.png");

    // 填 alt → 片段带上 alt 属性
    fireEvent.change(screen.getByLabelText("替代文本（alt，可选）"), {
      target: { value: " 直角三角形图示 " },
    });
    expect(screen.getByLabelText("::image 片段预览").textContent).toBe(
      `::image{src="${FAKE_SRC}" alt="直角三角形图示"}`,
    );

    // 复制：剪贴板内容即当前片段，并出现「已复制」反馈
    fireEvent.click(screen.getByRole("button", { name: /复制 ::image 片段/ }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        `::image{src="${FAKE_SRC}" alt="直角三角形图示"}`,
      );
    });
    expect(screen.getByText("已复制，粘贴到文档中即可。")).toBeInTheDocument();
  });

  it("上传中：按钮禁用并显示进行中状态", async () => {
    let release: (() => void) | undefined;
    mockedUpload.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ src: FAKE_SRC, bytes: 1 });
        }),
    );
    render(<MediaUploadCard />);

    selectImage();

    const button = screen.getByRole("button", { name: /上传中/ });
    expect(button).toBeDisabled();
    expect(screen.getByRole("status").textContent).toContain("配图.png");

    release?.();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /选择图片/ }),
      ).toBeInTheDocument();
    });
  });

  it("失败路径：服务端中文文案原样透出（413 超限示例）", async () => {
    mockedUpload.mockRejectedValue(
      new ApiError(
        "MEDIA_TOO_LARGE",
        "图片超过 5MB 上传上限，请压缩后重试",
        413,
      ),
    );
    render(<MediaUploadCard />);

    selectImage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("图片超过 5MB 上传上限，请压缩后重试");
    // 失败后可重新选择（按钮回到可用态）
    expect(
      screen.getByRole("button", { name: /选择图片/ }),
    ).toBeEnabled();
  });

  it("失败路径：网络层中文文案同样透出", async () => {
    mockedUpload.mockRejectedValue(
      new Error("连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试"),
    );
    render(<MediaUploadCard />);

    selectImage();

    expect(
      await screen.findByRole("alert").then((el) => el.textContent),
    ).toContain("连不上服务器");
  });
});

describe("buildImageSnippet（片段构造纯函数）", () => {
  it("alt 留空/全空白 → 片段不带 alt 属性", () => {
    expect(buildImageSnippet(FAKE_SRC, "")).toBe(`::image{src="${FAKE_SRC}"}`);
    expect(buildImageSnippet(FAKE_SRC, "  ")).toBe(
      `::image{src="${FAKE_SRC}"}`,
    );
  });

  it("alt 有值 → trim 后带进片段", () => {
    expect(buildImageSnippet(FAKE_SRC, " 图示 ")).toBe(
      `::image{src="${FAKE_SRC}" alt="图示"}`,
    );
  });
});
