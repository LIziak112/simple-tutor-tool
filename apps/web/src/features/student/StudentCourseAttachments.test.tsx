import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listStudentCourseAttachmentsApi } from "@/lib/attachment-api";
import { StudentCourseAttachments } from "./StudentCourseAttachments";

vi.mock("@/lib/attachment-api", () => ({
  listStudentCourseAttachmentsApi: vi.fn(),
}));
const mocked = vi.mocked(listStudentCourseAttachmentsApi);
const COURSE_ID = "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b";

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <StudentCourseAttachments courseId={COURSE_ID} />
    </QueryClientProvider>,
  );
}

describe("学生课程页「资料」区（模块 6 第一步）", () => {
  beforeEach(() => mocked.mockReset());

  it("有资料：计数、格式、大小、页数已知时、下载链接指向学生侧直出地址", async () => {
    mocked.mockResolvedValue({
      attachments: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          fileName: "2024 国考行测真题.pdf",
          format: "pdf",
          bytes: 1_572_864,
          pageCount: 42,
          createdAt: "2026-11-10T00:00:00.000Z",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          fileName: "申论材料.docx",
          format: "docx",
          bytes: 20_480,
          pageCount: null,
          createdAt: "2026-11-10T00:00:00.000Z",
        },
      ],
    });
    renderSection();
    const section = await screen.findByTestId("student-course-attachments");
    expect(section.textContent).toContain("资料（2）");
    const pdf = screen.getByRole("link", { name: /2024 国考行测真题\.pdf/ });
    expect(pdf.getAttribute("href")).toBe(
      "/api/student/attachments/11111111-1111-4111-8111-111111111111/file",
    );
    expect(pdf.getAttribute("download")).toBe("2024 国考行测真题.pdf");
    expect(pdf.textContent).toContain("PDF");
    expect(pdf.textContent).toContain("1.5 MB");
    expect(pdf.textContent).toContain("42 页");
    const docx = screen.getByRole("link", { name: /申论材料\.docx/ });
    expect(docx.textContent).toContain("Word");
    expect(docx.textContent).not.toContain("页");
  });

  it("没有资料整块不渲染；加载失败给一行可重试提示", async () => {
    mocked.mockResolvedValueOnce({ attachments: [] });
    const { unmount } = renderSection();
    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("student-course-attachments")).toBeNull();
    unmount();

    mocked.mockRejectedValueOnce(new Error("网络异常"));
    renderSection();
    await screen.findByText(/课程资料暂时加载不出来/);
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
