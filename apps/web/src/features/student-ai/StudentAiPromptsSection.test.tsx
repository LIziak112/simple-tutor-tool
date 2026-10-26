import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AiPromptSettingsData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchStudentAiPromptsApi,
  saveStudentAiPromptsApi,
} from "@/lib/api";
import { StudentAiPromptsSection } from "./StudentAiPromptsSection";

/**
 * 学生设置「复习包 AI 提示词」区组件测试（hall-9533）：
 * - 默认回显（正文=默认正文、无已自定义标记）；
 * - 编辑后保存提交覆盖；恢复默认 + 保存 → 提交 null；
 * - 409 冲突显式放弃后重取；空正文禁用保存。
 * API 层 mock。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentAiPromptsApi: vi.fn(),
    saveStudentAiPromptsApi: vi.fn(),
  };
});

const mockedFetch = vi.mocked(fetchStudentAiPromptsApi);
const mockedSave = vi.mocked(saveStudentAiPromptsApi);

const UNSET = "1970-01-01T00:00:00.000Z";
const DEFAULT_BODY = "默认复习包指令全文";

function studentData(
  body: string = DEFAULT_BODY,
  isCustom = false,
): AiPromptSettingsData {
  return {
    slots: [
      {
        key: "review-pack-student",
        title: "单题复习包指令（学生自助）",
        description: "说明文案",
        group: "review-pack",
        body,
        defaultBody: DEFAULT_BODY,
        isCustom,
        updatedAt: isCustom ? "2026-10-25T06:00:00.000Z" : UNSET,
      },
    ],
    updatedAt: isCustom ? "2026-10-25T06:00:00.000Z" : UNSET,
  };
}

function renderSection() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <StudentAiPromptsSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedFetch.mockResolvedValue(studentData());
});

describe("StudentAiPromptsSection", () => {
  it("默认回显：正文=默认正文、无已自定义标记、恢复默认按钮禁用", async () => {
    renderSection();
    const textarea = await screen.findByLabelText("单题复习包提示词正文");
    expect(textarea).toHaveValue(DEFAULT_BODY);
    expect(screen.queryByText("已自定义")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /恢复默认/ })).toBeDisabled();
  });

  it("编辑后保存提交覆盖正文；成功后清脏提示已保存", async () => {
    mockedSave.mockResolvedValue(studentData("我的复习指令", true));
    renderSection();
    const textarea = await screen.findByLabelText("单题复习包提示词正文");
    fireEvent.change(textarea, { target: { value: "我的复习指令" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledTimes(1);
    });
    expect(mockedSave).toHaveBeenCalledWith({
      updates: [{ key: "review-pack-student", body: "我的复习指令" }],
      baseUpdatedAt: UNSET,
    });
    expect(await screen.findByText("已保存。")).toBeInTheDocument();
  });

  it("恢复默认 + 保存 → 提交 null（删覆盖行）", async () => {
    mockedFetch.mockResolvedValue(studentData("已自定义指令", true));
    mockedSave.mockResolvedValue(studentData());
    renderSection();
    const textarea = await screen.findByLabelText("单题复习包提示词正文");
    expect(textarea).toHaveValue("已自定义指令");
    fireEvent.click(screen.getByRole("button", { name: /恢复默认/ }));
    expect(textarea).toHaveValue(DEFAULT_BODY);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledTimes(1);
    });
    expect(mockedSave).toHaveBeenCalledWith({
      updates: [{ key: "review-pack-student", body: null }],
      baseUpdatedAt: "2026-10-25T06:00:00.000Z",
    });
  });

  it("409 冲突：显式放弃本地更改后重取；空正文禁用保存", async () => {
    mockedFetch.mockResolvedValue(studentData());
    mockedSave.mockRejectedValue(
      new ApiError("AI_SETTINGS_STALE", "已在其他页面被修改", 409),
    );
    renderSection();
    const textarea = await screen.findByLabelText("单题复习包提示词正文");
    fireEvent.change(textarea, { target: { value: "本地编辑" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/已在其他页面被修改/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /放弃本地更改并重新加载/ }),
    );
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });

    fireEvent.change(textarea, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });
});
