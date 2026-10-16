import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  type AiTeacherSettingsData,
  DEFAULT_AI_PROMPT_TEMPLATES,
} from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchTeacherAiSettingsApi,
  saveTeacherAiSettingsApi,
} from "@/lib/api";
import { TeacherAiSettingsSection } from "./TeacherAiSettingsSection";

/**
 * SAI-07 教师设置「AI 伴学」区组件测试（B03「必须先测」逐条）：
 * - 默认开放回显 + 说明常驻文本（不依赖 hover/title）+ 原生 radio 可键盘操作；
 * - 未保存切分类再回来仍在（草稿 queryClient 缓存）；后台 refetch 不覆盖；
 * - 保存成功清脏、失败保留编辑；
 * - 模板恢复默认只影响当前模板（保存请求只带变化字段，恢复 → null）；
 * - 版本冲突（409 AI_SETTINGS_STALE）不自动覆盖输入，显式放弃才回到服务器值。
 * API 层 mock；真实路由 get→暂存→save→refetch 见 route-integration.test.tsx。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchTeacherAiSettingsApi: vi.fn(),
    saveTeacherAiSettingsApi: vi.fn(),
  };
});

const mockedFetch = vi.mocked(fetchTeacherAiSettingsApi);
const mockedSave = vi.mocked(saveTeacherAiSettingsApi);

const UNSET_SETTINGS: AiTeacherSettingsData = {
  defaultMode: "open_study",
  promptsOpen: null,
  promptsGuided: null,
  promptsReview: null,
  updatedAt: "1970-01-01T00:00:00.000Z",
};

function renderSection(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TeacherAiSettingsSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue(UNSET_SETTINGS);
});

describe("TeacherAiSettingsSection（SAI-07 AI 伴学设置区）", () => {
  it("未设置时默认模式为开放伴学；模板显示默认正文；说明是常驻文本不依赖 hover", async () => {
    renderSection();
    expect(
      await screen.findByRole("radio", { name: "开放伴学" }),
    ).toBeChecked();
    expect(screen.getByRole("radio", { name: "仅启发" })).not.toBeChecked();
    // 说明常驻在文档里（禁 title 属性承载）
    expect(
      screen.getByText(/已有答案和解析会一起提供给 AI/u),
    ).toBeInTheDocument();
    expect(screen.getByText(/不能保证原始答案保密/u)).toBeInTheDocument();
    // 模板 tab + 默认正文（预览）
    fireEvent.click(screen.getByRole("button", { name: "模板：仅启发" }));
    expect(
      await screen.findByRole("textbox", { name: "仅启发模板正文" }),
    ).toHaveValue(DEFAULT_AI_PROMPT_TEMPLATES.guided);
  });

  it("未保存切走再回来仍在（设置分类切换不丢草稿）", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const first = renderSection(client);
    fireEvent.click(await screen.findByRole("radio", { name: "仅启发" }));
    first.unmount();
    renderSection(client);
    expect(await screen.findByRole("radio", { name: "仅启发" })).toBeChecked();
  });

  it("后台 refetch 不覆盖未保存的本地草稿", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderSection(client);
    fireEvent.click(await screen.findByRole("radio", { name: "完成后可用" }));
    await waitFor(() =>
      client.setQueryData(["teacher", "ai-settings"], {
        ...UNSET_SETTINGS,
        defaultMode: "open_study",
      }),
    );
    // 服务器数据回到开放，草稿仍是完成后可用
    expect(
      await screen.findByRole("radio", { name: "完成后可用" }),
    ).toBeChecked();
  });

  it("保存成功清脏；保存失败保留编辑与草稿", async () => {
    mockedSave.mockRejectedValueOnce(new Error("测试保存失败"));
    renderSection();
    fireEvent.click(await screen.findByRole("radio", { name: "仅启发" }));
    fireEvent.click(screen.getByRole("button", { name: "保存 AI 设置" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("radio", { name: "仅启发" })).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("有未保存的更改");

    mockedSave.mockResolvedValue({
      ...UNSET_SETTINGS,
      defaultMode: "guided_only",
      updatedAt: "2026-10-15T00:00:00.000Z",
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 AI 设置" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("更改已保存"),
    );
    expect(mockedSave).toHaveBeenCalledWith({
      defaultMode: "guided_only",
      baseUpdatedAt: "1970-01-01T00:00:00.000Z",
    });
  });

  it("模板编辑与恢复默认只影响当前模板；保存只提交变化字段（恢复 → null）", async () => {
    mockedFetch.mockResolvedValue({
      ...UNSET_SETTINGS,
      promptsOpen: "开放自定义原文",
      promptsGuided: "仅启发自定义原文",
      updatedAt: "2026-10-14T00:00:00.000Z",
    });
    renderSection();
    const openBox = await screen.findByRole("textbox", {
      name: "开放伴学模板正文",
    });
    expect(openBox).toHaveValue("开放自定义原文");
    // 恢复默认：确认弹层说明替换范围（只替换当前模式模板）
    fireEvent.click(screen.getByRole("button", { name: "恢复默认模板" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/只替换「开放伴学」的模板正文/u),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/其他两个模式的模板不受影响/u),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "恢复默认" }));
    await waitFor(() =>
      expect(openBox).toHaveValue(DEFAULT_AI_PROMPT_TEMPLATES.open),
    );
    // guided 模板不受恢复影响
    fireEvent.click(screen.getByRole("button", { name: "模板：仅启发" }));
    expect(screen.getByRole("textbox", { name: "仅启发模板正文" })).toHaveValue(
      "仅启发自定义原文",
    );
    // 保存：open 恢复默认 → null；guided 未改不带；带版本锚点
    mockedSave.mockResolvedValue(UNSET_SETTINGS);
    fireEvent.click(screen.getByRole("button", { name: "保存 AI 设置" }));
    await waitFor(() => expect(mockedSave).toHaveBeenCalled());
    expect(mockedSave).toHaveBeenLastCalledWith({
      promptsOpen: null,
      baseUpdatedAt: "2026-10-14T00:00:00.000Z",
    });
  });

  it("版本冲突（AI_SETTINGS_STALE）不自动覆盖输入；显式放弃后才回到服务器值", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("radio", { name: "仅启发" }));
    // 另一页面已保存：服务器已是仅启发 + 新锚点
    const serverNow: AiTeacherSettingsData = {
      ...UNSET_SETTINGS,
      defaultMode: "open_study",
      updatedAt: "2026-10-15T08:00:00.000Z",
    };
    mockedSave.mockRejectedValueOnce(
      new ApiError("AI_SETTINGS_STALE", "AI 设置已在其他页面被修改", 409),
    );
    mockedFetch.mockResolvedValue(serverNow);
    fireEvent.click(screen.getByRole("button", { name: "保存 AI 设置" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/其他页面被修改/u);
    // 本地输入不被覆盖（仍是仅启发，不自动改回服务器开放）
    expect(screen.getByRole("radio", { name: "仅启发" })).toBeChecked();
    // 显式放弃本地更改 → 回到服务器值
    fireEvent.click(
      screen.getByRole("button", { name: "放弃本地更改并重新加载" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "开放伴学" })).toBeChecked(),
    );
  });

  it("B17 ④模式文案纪律：启发是提示词约束不承诺绝不解题，严格项指向完成后", async () => {
    renderSection();
    await screen.findByRole("radio", { name: "仅启发" });
    // 仅启发描述 = 提示词输出约束口径（不是保密承诺）
    expect(screen.getByText(/不直接给最终答案/u)).toBeInTheDocument();
    // 常驻警示：允许求助即携带答案解析；仅启发不能保证保密（严格需求选完成后）
    expect(
      screen.getByText(/已有答案和解析会一起提供给 AI/u),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/仅启发通过提示词要求控制输出，不能保证原始答案保密/u),
    ).toBeInTheDocument();
    // 完成后才可求助的严格项如实描述拒绝行为
    expect(screen.getByText(/都会被拒绝/u)).toBeInTheDocument();
    // 全文不出现「绝不/保证不」类解题承诺（「不能保证……保密」是警示句，不算承诺）
    const allText = document.body.textContent ?? "";
    expect(allText).not.toMatch(/绝不(?:给|解|提|泄露)/u);
    expect(allText).not.toMatch(/保证不(?:给|解|泄露)/u);
  });
});
