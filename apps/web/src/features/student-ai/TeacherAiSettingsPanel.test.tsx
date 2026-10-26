import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AiPromptSettingsData,
  AiTeacherSettingsData,
} from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchTeacherAiPromptsApi,
  fetchTeacherAiSettingsApi,
  saveTeacherAiPromptsApi,
  saveTeacherAiSettingsApi,
} from "@/lib/api";
import { TeacherAiSettingsPanel } from "./TeacherAiSettingsPanel";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchTeacherAiPromptsApi: vi.fn(),
  fetchTeacherAiSettingsApi: vi.fn(),
  saveTeacherAiPromptsApi: vi.fn(),
  saveTeacherAiSettingsApi: vi.fn(),
}));
const settings: AiTeacherSettingsData = {
  defaultMode: "open_study",
  promptsOpen: null,
  promptsGuided: null,
  promptsReview: null,
  updatedAt: "1970-01-01T00:00:00.000Z",
};
const prompts: AiPromptSettingsData = {
  updatedAt: settings.updatedAt,
  slots: [
    {
      key: "content-ai-instruction",
      group: "content-ai",
      title: "出题助手开场指令",
      description: "复制给 AI 使用",
      body: "默认出题指令",
      defaultBody: "默认出题指令",
      isCustom: false,
      updatedAt: settings.updatedAt,
    },
  ],
};
function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TeacherAiSettingsPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchTeacherAiSettingsApi).mockResolvedValue(settings);
  vi.mocked(fetchTeacherAiPromptsApi).mockResolvedValue(prompts);
  vi.mocked(saveTeacherAiSettingsApi).mockImplementation(async (request) => ({
    ...settings,
    defaultMode: request.defaultMode ?? settings.defaultMode,
  }));
  vi.mocked(saveTeacherAiPromptsApi).mockImplementation(async () => ({
    ...prompts,
    slots: prompts.slots.map((slot) => ({
      ...slot,
      body: "自定义出题",
      isCustom: true,
    })),
  }));
});
it("默认折叠长正文，只有一个保存入口，展开再收起不丢编辑", async () => {
  renderPanel();
  await screen.findByRole("radio", { name: "开放伴学" });
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "保存 AI 设置" })).toHaveLength(
    1,
  );
  expect(
    screen.queryByRole("button", { name: "保存全部改动" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("AI 出题助手"));
  const input = screen.getByRole("textbox", {
    name: "出题助手开场指令提示词正文",
  });
  fireEvent.change(input, { target: { value: "自定义出题" } });
  fireEvent.click(screen.getByText("AI 出题助手"));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getByText(/1 项未保存/)).toBeVisible();
  fireEvent.click(screen.getByText("AI 出题助手"));
  expect(input).toHaveValue("自定义出题");
});
it("一次保存两个区域；失败部分保留草稿，重试不重复提交成功部分", async () => {
  vi.mocked(saveTeacherAiPromptsApi).mockRejectedValueOnce(
    new Error("网络中断"),
  );
  renderPanel();
  fireEvent.click(await screen.findByRole("radio", { name: "仅启发" }));
  fireEvent.click(screen.getByText("AI 出题助手"));
  fireEvent.change(
    screen.getByRole("textbox", { name: "出题助手开场指令提示词正文" }),
    { target: { value: "自定义出题" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "保存 AI 设置" }));
  expect(await screen.findByText(/部分设置未保存/)).toBeVisible();
  expect(screen.getByRole("textbox")).toHaveValue("自定义出题");
  expect(saveTeacherAiSettingsApi).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "保存 AI 设置" }));
  await waitFor(() => expect(saveTeacherAiPromptsApi).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("AI 设置已保存")).toBeVisible();
  expect(saveTeacherAiSettingsApi).toHaveBeenCalledTimes(1);
});
it("折叠中的空白模板仍阻止统一保存", async () => {
  renderPanel();
  await screen.findByRole("radio", { name: "开放伴学" });
  fireEvent.click(screen.getByText("伴学提示词模板"));
  fireEvent.change(screen.getByRole("textbox", { name: "开放伴学模板正文" }), {
    target: { value: " " },
  });
  fireEvent.click(screen.getByRole("button", { name: "模板：仅启发" }));
  fireEvent.click(screen.getByText("伴学提示词模板"));
  expect(screen.getByRole("button", { name: "保存 AI 设置" })).toBeDisabled();
  expect(screen.getByText(/请先处理/)).toBeVisible();
});

it("只编辑导出提示词时不提交伴学设置，版本冲突仍保留草稿", async () => {
  vi.mocked(saveTeacherAiPromptsApi).mockRejectedValueOnce(
    new ApiError("AI_SETTINGS_STALE", "其他页面已修改", 409),
  );
  renderPanel();
  fireEvent.click(await screen.findByText("AI 出题助手"));
  const input = screen.getByRole("textbox", {
    name: "出题助手开场指令提示词正文",
  });
  fireEvent.change(input, { target: { value: "自定义出题" } });
  fireEvent.click(screen.getByRole("button", { name: "保存 AI 设置" }));
  expect(await screen.findByText(/提示词已在其他页面被修改/)).toBeVisible();
  expect(input).toHaveValue("自定义出题");
  expect(saveTeacherAiSettingsApi).not.toHaveBeenCalled();
  expect(saveTeacherAiPromptsApi).toHaveBeenCalledWith({
    baseUpdatedAt: settings.updatedAt,
    updates: [{ key: "content-ai-instruction", body: "自定义出题" }],
  });
});

it("保存期间禁用编辑与重复提交，成功前不显示已保存", async () => {
  let finish: ((data: AiTeacherSettingsData) => void) | undefined;
  vi.mocked(saveTeacherAiSettingsApi).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  renderPanel();
  const mode = await screen.findByRole("radio", { name: "仅启发" });
  fireEvent.click(mode);
  const save = screen.getByRole("button", { name: "保存 AI 设置" });
  fireEvent.click(save);
  expect(save).toBeDisabled();
  expect(mode).toBeDisabled();
  expect(screen.queryByText("AI 设置已保存")).not.toBeInTheDocument();
  await waitFor(() => expect(finish).toBeDefined());
  finish?.({ ...settings, defaultMode: "guided_only" });
  expect(await screen.findByText("AI 设置已保存")).toBeVisible();
  expect(saveTeacherAiPromptsApi).not.toHaveBeenCalled();
});

it("任一区域加载失败时不能误报全部已保存", async () => {
  vi.mocked(fetchTeacherAiPromptsApi).mockRejectedValue(new Error("读取失败"));
  renderPanel();
  expect(await screen.findByText(/AI 提示词加载失败/)).toBeVisible();
  fireEvent.click(await screen.findByRole("radio", { name: "仅启发" }));
  expect(screen.getByRole("button", { name: "保存 AI 设置" })).toBeDisabled();
  expect(screen.queryByText("当前 AI 设置已保存")).not.toBeInTheDocument();
});
