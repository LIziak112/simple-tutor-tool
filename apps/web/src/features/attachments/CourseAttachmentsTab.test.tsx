import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Attachment } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  deleteAttachmentApi,
  listAttachmentsApi,
  updateAttachmentApi,
  uploadAttachmentApi,
} from "@/lib/attachment-api";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/test/render-with-portal";
import { resetAttachmentUploadStoreForTest } from "./attachment-upload-store";
import { CourseAttachmentsTab } from "./CourseAttachmentsTab";

vi.mock("@/lib/attachment-api", () => ({
  listAttachmentsApi: vi.fn(),
  updateAttachmentApi: vi.fn(),
  deleteAttachmentApi: vi.fn(),
  uploadAttachmentApi: vi.fn(),
}));

const mockedList = vi.mocked(listAttachmentsApi);
const mockedUpdate = vi.mocked(updateAttachmentApi);
const mockedDelete = vi.mocked(deleteAttachmentApi);
const mockedUpload = vi.mocked(uploadAttachmentApi);

const COURSE_ID = "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b";

const PDF: Attachment = {
  id: "11111111-1111-4111-8111-111111111111",
  courseId: COURSE_ID,
  courseTitle: "行测冲刺",
  fileName: "2024 国考行测真题.pdf",
  format: "pdf",
  bytes: 1_572_864,
  pageCount: 42,
  visibility: "students",
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
};
const DOCX: Attachment = {
  ...PDF,
  id: "22222222-2222-4222-8222-222222222222",
  fileName: "申论材料.docx",
  format: "docx",
  bytes: 20_480,
  pageCount: null,
  visibility: "teacher_only",
};

function renderTab(courseId = COURSE_ID) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (id: string) => (
    <QueryClientProvider client={client}>
      <CourseAttachmentsTab courseId={id} />
    </QueryClientProvider>
  );
  const utils = render(tree(courseId));
  return {
    ...utils,
    /** 换课程（同一组件实例、courseId 变了） */
    switchCourse: (id: string) => utils.rerender(tree(id)),
    /** 模拟切页签再切回：卸载后重新挂载 */
    remount: () => {
      utils.unmount();
      return render(tree(courseId));
    },
  };
}

function pickFiles(files: File[]) {
  const input = screen.getByLabelText("选择要上传的资料文件");
  fireEvent.change(input, { target: { files } });
}

describe("课程「资料」页签（模块 6 第一步）", () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedUpdate.mockReset();
    mockedDelete.mockReset();
    mockedUpload.mockReset();
    resetAttachmentUploadStoreForTest();
  });

  it("列表：格式徽标、大小、页数已知时显示、可见性与下载链接；切换可见性", async () => {
    mockedList.mockResolvedValue({ attachments: [PDF, DOCX] });
    mockedUpdate.mockResolvedValue({ ...PDF, visibility: "teacher_only" });
    renderTab();
    const pdfRow = (await screen.findByText("2024 国考行测真题.pdf")).closest(
      "li",
    ) as HTMLElement;
    expect(pdfRow.textContent).toContain("PDF");
    expect(pdfRow.textContent).toContain("1.5 MB");
    expect(pdfRow.textContent).toContain("42 页");
    const docxRow = screen
      .getByText("申论材料.docx")
      .closest("li") as HTMLElement;
    expect(docxRow.textContent).toContain("Word");
    expect(docxRow.textContent).not.toContain("页");
    expect(docxRow.textContent).toContain("仅教师可见");
    expect(
      within(pdfRow).getByRole("link", { name: /下载/ }).getAttribute("href"),
    ).toBe(`/api/teacher/attachments/${PDF.id}/file`);

    fireEvent.click(
      within(pdfRow).getByRole("button", { name: /学生可查看和下载/ }),
    );
    await waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith(PDF.id, {
        visibility: "teacher_only",
      }),
    );
  });

  it("上传：进度 → 完成并刷新列表；含答案文件名按仅教师可见上传并提示", async () => {
    mockedList.mockResolvedValue({ attachments: [] });
    let progressCb: ((ratio: number) => void) | undefined;
    let finish: (value: Attachment) => void = () => undefined;
    mockedUpload.mockImplementation(
      (_file, options) =>
        new Promise<Attachment>((resolve) => {
          progressCb = options?.onProgress ?? undefined;
          finish = resolve;
        }),
    );
    renderTab();
    await screen.findByText(/还没有资料/);
    pickFiles([
      new File([new Uint8Array(10)], "行测参考答案.pdf", {
        type: "application/pdf",
      }),
    ]);
    const queue = await screen.findByRole("list", { name: "上传队列" });
    await waitFor(() =>
      expect(mockedUpload).toHaveBeenCalledWith(
        expect.objectContaining({ name: "行测参考答案.pdf" }),
        expect.objectContaining({
          courseId: COURSE_ID,
          visibility: "teacher_only",
        }),
      ),
    );
    expect(queue.textContent).toContain("文件名像含答案");
    progressCb?.(0.5);
    await waitFor(() => expect(queue.textContent).toContain("上传中 50%"));
    expect(
      screen.getByRole("progressbar", { name: "行测参考答案.pdf 上传进度" }),
    ).toBeInTheDocument();
    mockedList.mockResolvedValue({
      attachments: [{ ...PDF, fileName: "行测参考答案.pdf" }],
    });
    finish({
      ...PDF,
      fileName: "行测参考答案.pdf",
      visibility: "teacher_only",
    });
    await waitFor(() => expect(queue.textContent).toContain("已上传"));
    // 列表刷新后出现该行（队列里同名文件也在，按资料列表区定位）
    const list = screen.getByRole("region", { name: "资料列表" });
    await waitFor(() =>
      expect(within(list).getByText("行测参考答案.pdf")).toBeInTheDocument(),
    );
  });

  it("批量上传：同时最多 2 个请求，前一个完成后第 3 个才开始；完成行仍显示文件名与大小（#103-05）", async () => {
    mockedList.mockResolvedValue({ attachments: [] });
    const finishers: Array<(value: Attachment) => void> = [];
    mockedUpload.mockImplementation(
      () =>
        new Promise<Attachment>((resolve) => {
          finishers.push(resolve);
        }),
    );
    renderTab();
    await screen.findByText(/还没有资料/);
    pickFiles(
      ["一.pdf", "二.pdf", "三.pdf"].map(
        (name) =>
          new File([new Uint8Array(2048)], name, { type: "application/pdf" }),
      ),
    );
    await waitFor(() => expect(mockedUpload).toHaveBeenCalledTimes(2));
    expect(mockedUpload.mock.calls.map((call) => call[0].name)).toEqual([
      "一.pdf",
      "二.pdf",
    ]);
    const queue = await screen.findByRole("list", { name: "上传队列" });
    const third = within(queue)
      .getByText("三.pdf")
      .closest("li") as HTMLElement;
    expect(third.textContent).toContain("等待上传");
    // 再等一拍：没有第三个请求被发出
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockedUpload).toHaveBeenCalledTimes(2);

    finishers[0]?.({ ...PDF, fileName: "一.pdf" });
    await waitFor(() => expect(mockedUpload).toHaveBeenCalledTimes(3));
    expect(mockedUpload.mock.calls[2]?.[0].name).toBe("三.pdf");
    const first = within(queue)
      .getByText("一.pdf")
      .closest("li") as HTMLElement;
    expect(first.textContent).toContain("已上传");
    expect(first.textContent).toContain("2.0 KB");
    expect(within(first).queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("切页签（卸载）再切回：排队中与在传的文件都还在，前一个完成后第 3 个照常开始，列表刷新（第二轮）", async () => {
    mockedList.mockResolvedValue({ attachments: [] });
    const finishers: Array<(value: Attachment) => void> = [];
    mockedUpload.mockImplementation(
      () =>
        new Promise<Attachment>((resolve) => {
          finishers.push(resolve);
        }),
    );
    const view = renderTab();
    await screen.findByText(/还没有资料/);
    pickFiles(
      ["一.pdf", "二.pdf", "三.pdf"].map(
        (name) =>
          new File([new Uint8Array(2048)], name, { type: "application/pdf" }),
      ),
    );
    await waitFor(() => expect(mockedUpload).toHaveBeenCalledTimes(2));
    // 切到别的页签：组件卸载；此时第 3 个还没发请求
    view.remount();
    await screen.findByText(/还没有资料/);
    const queue = await screen.findByRole("list", { name: "上传队列" });
    expect(within(queue).getAllByRole("listitem")).toHaveLength(3);
    expect(
      (within(queue).getByText("三.pdf").closest("li") as HTMLElement)
        .textContent,
    ).toContain("等待上传");
    expect(mockedUpload).toHaveBeenCalledTimes(2);

    mockedList.mockResolvedValue({
      attachments: [{ ...PDF, fileName: "一.pdf" }],
    });
    finishers[0]?.({ ...PDF, fileName: "一.pdf" });
    await waitFor(() => expect(mockedUpload).toHaveBeenCalledTimes(3));
    expect(mockedUpload.mock.calls[2]?.[0].name).toBe("三.pdf");
    const list = screen.getByRole("region", { name: "资料列表" });
    await waitFor(() =>
      expect(within(list).getByText("一.pdf")).toBeInTheDocument(),
    );
  });

  it("换课程：为 A 选的文件仍传进 A，B 的页签不显示它们；没人听时完成的上传在回到 A 时刷新列表（第二轮）", async () => {
    const COURSE_B = "1c7f29bf-7c0b-4e1f-9c8d-0c2c2c2c2c2c";
    mockedList.mockResolvedValue({ attachments: [] });
    const finishers: Array<(value: Attachment) => void> = [];
    mockedUpload.mockImplementation(
      () =>
        new Promise<Attachment>((resolve) => {
          finishers.push(resolve);
        }),
    );
    const view = renderTab();
    await screen.findByText(/还没有资料/);
    pickFiles(
      ["一.pdf", "二.pdf", "三.pdf"].map(
        (name) =>
          new File([new Uint8Array(2048)], name, { type: "application/pdf" }),
      ),
    );
    await waitFor(() => expect(mockedUpload).toHaveBeenCalledTimes(2));
    view.switchCourse(COURSE_B);
    await waitFor(() => expect(mockedList).toHaveBeenCalledWith(COURSE_B));
    expect(screen.queryByRole("list", { name: "上传队列" })).toBeNull();

    // A 的第 1 个传完：第 3 个开始，且仍然发给 A，不是正在看的 B
    finishers[0]?.({ ...PDF, fileName: "一.pdf" });
    await waitFor(() => expect(mockedUpload).toHaveBeenCalledTimes(3));
    for (const call of mockedUpload.mock.calls) {
      expect(call[1]?.courseId).toBe(COURSE_ID);
    }

    // 完全离开（没有页签在听）时第 2 个传完 → 回到 A 时列表刷新一次
    view.unmount();
    finishers[1]?.({ ...PDF, fileName: "二.pdf" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    mockedList.mockClear();
    mockedList.mockResolvedValue({
      attachments: [
        { ...PDF, fileName: "一.pdf" },
        {
          ...PDF,
          id: "33333333-3333-4333-8333-333333333333",
          fileName: "二.pdf",
        },
      ],
    });
    renderTab();
    const list = await screen.findByRole("region", { name: "资料列表" });
    await waitFor(() =>
      expect(within(list).getByText("二.pdf")).toBeInTheDocument(),
    );
    const queue = screen.getByRole("list", { name: "上传队列" });
    expect(within(queue).getAllByRole("listitem")).toHaveLength(3);
  });

  it("上传失败：显示服务端原因，可重试、可移除；本地预检失败不发请求", async () => {
    mockedList.mockResolvedValue({ attachments: [] });
    mockedUpload.mockRejectedValueOnce(
      new ApiError(
        "ATTACHMENT_UNSUPPORTED_TYPE",
        "文件格式不受支持：按文件内容识别，只接受 PDF 与 Word（docx）",
        415,
      ),
    );
    renderTab();
    await screen.findByText(/还没有资料/);
    pickFiles([
      new File([new Uint8Array(10)], "伪装.pdf", { type: "application/pdf" }),
      new File([new Uint8Array(10)], "表格.xlsx", { type: "application/x" }),
    ]);
    const queue = await screen.findByRole("list", { name: "上传队列" });
    await waitFor(() =>
      expect(queue.textContent).toContain("上传失败：文件格式不受支持"),
    );
    expect(queue.textContent).toContain(
      "上传失败：只接受 PDF 与 Word（.docx）文件",
    );
    expect(mockedUpload).toHaveBeenCalledTimes(1);

    mockedUpload.mockResolvedValueOnce({ ...PDF, fileName: "伪装.pdf" });
    const failedRow = screen.getByText("伪装.pdf").closest("li") as HTMLElement;
    fireEvent.click(within(failedRow).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mockedUpload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(failedRow.textContent).toContain("已上传"));
    // 重试复用同一个幂等键（#103-04）：服务端据此不重复建资料
    const firstUploadId = mockedUpload.mock.calls[0]?.[1]?.uploadId;
    expect(firstUploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockedUpload.mock.calls[1]?.[1]?.uploadId).toBe(firstUploadId);

    fireEvent.click(screen.getByRole("button", { name: "移除 表格.xlsx" }));
    expect(screen.queryByText("表格.xlsx")).toBeNull();
  });

  it("删除：确认弹层 → 调删除接口并刷新", async () => {
    mockedList.mockResolvedValueOnce({ attachments: [PDF] });
    mockedList.mockResolvedValue({ attachments: [] });
    mockedDelete.mockResolvedValue({ id: PDF.id });
    renderTab();
    await screen.findByText("2024 国考行测真题.pdf");
    fireEvent.click(
      screen.getByRole("button", { name: "删除 2024 国考行测真题.pdf" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith(PDF.id));
    await screen.findByText(/还没有资料/);
  });
});
