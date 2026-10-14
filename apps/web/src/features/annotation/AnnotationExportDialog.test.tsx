import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AnnotationExportDialog } from "./AnnotationExportDialog";

const mocks = vi.hoisted(() => ({ save: vi.fn(), copy: vi.fn() }));
vi.mock("@/lib/api", () => ({ saveBlobAs: mocks.save }));
vi.mock("@/lib/copy", () => ({ copyPngBlobToClipboard: mocks.copy }));
afterEach(() => vi.restoreAllMocks());

it("本题多页导出逐页复制且全部下载，重开释放全部预览", async () => {
  const pages = [1, 2].map((n) => ({
    blob: new Blob([String(n)]),
    label: "题面与草稿",
  }));
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:page");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  mocks.save.mockClear();
  mocks.copy.mockResolvedValue(true);
  const view = render(
    <AnnotationExportDialog
      open
      onOpenChange={vi.fn()}
      createImage={async () => pages}
      filename="本题.png"
      title="导出本题"
      previewLabel="本题导出预览"
    />,
  );
  await screen.findByRole("img", { name: "本题导出预览" });
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  fireEvent.click(screen.getByRole("button", { name: "复制本页图片" }));
  await screen.findByText("已复制第 2 页图片");
  expect(mocks.copy).toHaveBeenLastCalledWith(pages[1]?.blob);
  fireEvent.click(screen.getByRole("button", { name: "下载全部图片" }));
  expect(mocks.save).toHaveBeenCalledWith(pages[0]?.blob, "本题-1.png");
  expect(mocks.save).toHaveBeenCalledWith(pages[1]?.blob, "本题-2.png");
  view.unmount();
  expect(revoke).toHaveBeenCalledTimes(2);
});

it("预览下载复制使用同Blob，复制失败不影响下载，关闭释放URL", async () => {
  const blob = new Blob(["png"], { type: "image/png" });
  const create = vi.fn(async () => blob);
  const url = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  mocks.copy.mockResolvedValue(false);
  const view = render(
    <AnnotationExportDialog
      open
      onOpenChange={vi.fn()}
      createImage={create}
      filename="第1题.png"
    />,
  );
  await screen.findByRole("img", { name: "标画导出预览" });
  expect(url).toHaveBeenCalledWith(blob);
  fireEvent.click(screen.getByRole("button", { name: "按原尺寸预览" }));
  expect(screen.getByRole("img", { name: "标画导出预览" })).toHaveClass(
    "max-w-none",
  );
  fireEvent.click(screen.getByRole("button", { name: "适应宽度预览" }));
  expect(screen.getByRole("img", { name: "标画导出预览" })).toHaveClass(
    "w-full",
  );
  fireEvent.click(screen.getByRole("button", { name: "复制图片" }));
  await screen.findByText("复制失败，请下载图片");
  fireEvent.click(screen.getByRole("button", { name: "下载图片" }));
  expect(mocks.save).toHaveBeenCalledWith(blob, "第1题.png");
  expect(mocks.copy).toHaveBeenCalledWith(blob);
  expect(create).toHaveBeenCalledOnce();
  view.unmount();
  expect(revoke).toHaveBeenCalledWith("blob:preview");
});

it("图片生成失败可重试，不导出孤立笔迹；卸载后迟到产物不建URL", async () => {
  const create = vi
    .fn<() => Promise<Blob>>()
    .mockRejectedValueOnce(new Error("底图加载失败"))
    .mockResolvedValue(new Blob(["png"]));
  const url = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retry");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const view = render(
    <AnnotationExportDialog
      open
      onOpenChange={vi.fn()}
      createImage={create}
      filename="题.png"
    />,
  );
  await screen.findByText("底图加载失败");
  fireEvent.click(screen.getByRole("button", { name: "重试生成" }));
  await screen.findByRole("img", { name: "标画导出预览" });
  expect(create).toHaveBeenCalledTimes(2);
  view.unmount();
  url.mockClear();
  let resolve: ((value: Blob) => void) | undefined;
  const pending = new Promise<Blob>((done) => {
    resolve = done;
  });
  const late = render(
    <AnnotationExportDialog
      open
      onOpenChange={vi.fn()}
      createImage={() => pending}
      filename="题.png"
    />,
  );
  late.unmount();
  resolve?.(new Blob(["late"]));
  await waitFor(() => expect(url).not.toHaveBeenCalled());
});

it("预览解码失败时不能继续下载或复制旧产物", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:broken");
  render(
    <AnnotationExportDialog
      open
      onOpenChange={vi.fn()}
      createImage={async () => new Blob(["png"])}
      filename="题.png"
    />,
  );
  fireEvent.error(await screen.findByRole("img", { name: "标画导出预览" }));
  expect(screen.getByRole("button", { name: "下载图片" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "复制图片" })).toBeDisabled();
});
