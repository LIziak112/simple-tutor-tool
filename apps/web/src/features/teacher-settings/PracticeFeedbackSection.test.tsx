import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPracticeFeedbackSettings,
  savePracticeFeedbackSettings,
} from "@/lib/api";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test/render-with-portal";
import { PracticeFeedbackSection } from "./PracticeFeedbackSection";

/**
 * M1b 设置页「练习反馈默认策略」区测试：
 * - 回显：未配置（null）按「由学生选择」有效默认勾选并标注未配置；
 * - 保存：切到「交卷后公布」后点保存 → savePracticeFeedbackSettings 收到
 *   after_attempt；选择不直接保存（显式「保存更改」一次提交）；
 * - 草稿：暂存选择独立于服务端查询，教师之间隔离。
 */

vi.mock("@/lib/api", () => ({
  fetchPracticeFeedbackSettings: vi.fn(),
  savePracticeFeedbackSettings: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchPracticeFeedbackSettings);
const mockedSave = vi.mocked(savePracticeFeedbackSettings);

function renderSection(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
  teacherId = "current",
) {
  return render(
    <QueryClientProvider client={client}>
      <PracticeFeedbackSection teacherId={teacherId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PracticeFeedbackSection（M1b 练习反馈默认策略）", () => {
  it("未配置（null）默认勾选「由学生选择」并标注未配置默认", async () => {
    mockedFetch.mockResolvedValue({
      practiceFeedbackPolicy: null,
      studentSelfReviewEnabled: true,
    });
    renderSection();
    expect(await screen.findByLabelText("由学生选择")).toBeChecked();
    expect(screen.getByText("（未配置时的默认）")).toBeTruthy();
    expect(screen.getByLabelText("交卷后公布")).not.toBeChecked();
  });

  it("已配置 after_attempt 原样回显；切换后显式保存才提交", async () => {
    mockedFetch.mockResolvedValue({
      practiceFeedbackPolicy: "after_attempt",
      studentSelfReviewEnabled: true,
    });
    renderSection();
    expect(await screen.findByLabelText("交卷后公布")).toBeChecked();
    expect(mockedSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("由学生选择"));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("有未保存的更改");
    });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledWith({
        practiceFeedbackPolicy: "student_choice",
      });
    });
  });

  it("自评默认开启，关闭后只保存自评设置", async () => {
    mockedFetch.mockResolvedValue({
      practiceFeedbackPolicy: null,
      studentSelfReviewEnabled: true,
    });
    mockedSave.mockResolvedValue({
      practiceFeedbackPolicy: null,
      studentSelfReviewEnabled: false,
    });
    renderSection();
    const toggle = await screen.findByRole("checkbox", {
      name: "允许学生对照自评",
    });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(mockedSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await waitFor(() =>
      expect(mockedSave).toHaveBeenCalledWith({
        studentSelfReviewEnabled: false,
      }),
    );
  });

  it("保存失败保留更改，可重试", async () => {
    mockedFetch.mockResolvedValue({
      practiceFeedbackPolicy: null,
      studentSelfReviewEnabled: true,
    });
    mockedSave.mockRejectedValue(new Error("网络错误"));
    renderSection();
    fireEvent.click(await screen.findByLabelText("交卷后公布"));
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("更改仍保留");
    expect(screen.getByLabelText("交卷后公布")).toBeChecked();
  });

  it("草稿按教师隔离，重取不覆盖编辑", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockedFetch.mockResolvedValue({
      practiceFeedbackPolicy: null,
      studentSelfReviewEnabled: true,
    });
    const first = renderSection(client, "teacher-one");
    fireEvent.click(await screen.findByLabelText("交卷后公布"));
    first.unmount();
    const second = renderSection(client, "teacher-two");
    expect(await screen.findByLabelText("由学生选择")).toBeChecked();
    second.unmount();
    renderSection(client, "teacher-one");
    expect(await screen.findByLabelText("交卷后公布")).toBeChecked();
  });
});

// act 引用（React 18 状态更新警告抑制；与本组用例的 fireEvent 配套）
void act;
