import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AiPromptSettingsData, AiPromptSlotKey } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchTeacherAiPromptsApi,
  saveTeacherAiPromptsApi,
} from "@/lib/api";
import { TeacherAiPromptsSection } from "./TeacherAiPromptsSection";

/**
 * 教师设置「AI 提示词」区组件测试（hall-9533）：
 * - 默认回显（正文=默认正文、无「已自定义」标记）；
 * - 编辑后保存只带变化槽位，保存成功清脏提示「已保存」；
 * - 「恢复默认」+ 保存 → 提交 null（删覆盖行）；
 * - 409 AI_SETTINGS_STALE 显示冲突、显式「放弃本地更改并重新加载」后重取；
 * - 空正文槽位禁用保存并提示。
 * API 层 mock；真实路由链路在服务端 route 测试覆盖。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchTeacherAiPromptsApi: vi.fn(),
    saveTeacherAiPromptsApi: vi.fn(),
  };
});

const mockedFetch = vi.mocked(fetchTeacherAiPromptsApi);
const mockedSave = vi.mocked(saveTeacherAiPromptsApi);

const UNSET = "1970-01-01T00:00:00.000Z";
const DEFAULT_INTRO = "默认出题指令 {kind} {topic}";
const DEFAULT_PACK = "默认学情包指令全文";

function slot(
  key: AiPromptSlotKey,
  group: "content-ai" | "learning-pack" | "review-pack",
  body: string,
  overrides?: Partial<
    Extract<AiPromptSettingsData["slots"][number], { key: string }>
  >,
): AiPromptSettingsData["slots"][number] {
  return {
    key,
    title: `标题-${key}`,
    description: `说明-${key}`,
    group,
    body,
    defaultBody: body,
    isCustom: false,
    updatedAt: UNSET,
    ...overrides,
  };
}

function settingsData(
  slots?: AiPromptSettingsData["slots"],
): AiPromptSettingsData {
  const list = slots ?? [
    slot("content-ai-instruction", "content-ai", DEFAULT_INTRO),
    slot("learning-pack.diagnose-weakness", "learning-pack", DEFAULT_PACK),
    slot("review-pack-teacher", "review-pack", DEFAULT_PACK),
  ];
  return {
    slots: list,
    // 组锚点 = 各行最大 updatedAt（与服务端「MAX(updated_at)」口径一致）
    updatedAt: list.reduce<string>(
      (max, entry) => (entry.updatedAt > max ? entry.updatedAt : max),
      UNSET,
    ),
  };
}

function renderSection(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TeacherAiPromptsSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedFetch.mockResolvedValue(settingsData());
});

describe("TeacherAiPromptsSection", () => {
  it("默认回显：正文=默认正文、无已自定义标记、分组标题齐全", async () => {
    renderSection();
    const intro = await screen.findByLabelText(
      "标题-content-ai-instruction提示词正文",
    );
    expect(intro).toHaveValue(DEFAULT_INTRO);
    expect(screen.queryByText("已自定义")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "AI 出题助手" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "学情数据包（导出给 AI 的 prompt.md）",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "单题复习包（教师域）" }),
    ).toBeInTheDocument();
  });

  it("编辑后保存只带变化槽位；成功后清脏并提示已保存", async () => {
    const custom = "自定义出题指令：只要 3 道题。";
    mockedFetch.mockResolvedValue(settingsData());
    mockedSave.mockResolvedValue(
      settingsData([
        slot("content-ai-instruction", "content-ai", custom, {
          isCustom: true,
          updatedAt: "2026-10-25T08:00:00.000Z",
        }),
        slot("learning-pack.diagnose-weakness", "learning-pack", DEFAULT_PACK),
        slot("review-pack-teacher", "review-pack", DEFAULT_PACK),
      ]),
    );
    renderSection();
    const intro = await screen.findByLabelText(
      "标题-content-ai-instruction提示词正文",
    );
    fireEvent.change(intro, { target: { value: custom } });
    fireEvent.click(screen.getByRole("button", { name: "保存全部改动" }));
    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledTimes(1);
    });
    expect(mockedSave).toHaveBeenCalledWith({
      updates: [{ key: "content-ai-instruction", body: custom }],
      baseUpdatedAt: UNSET,
    });
    expect(await screen.findByText("已保存。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存全部改动" })).toBeDisabled();
  });

  it("恢复默认 + 保存 → 该槽位提交 null（删覆盖行）", async () => {
    mockedFetch.mockResolvedValue(
      settingsData([
        slot("content-ai-instruction", "content-ai", "已自定义的开场", {
          defaultBody: DEFAULT_INTRO,
          isCustom: true,
          updatedAt: "2026-10-25T07:00:00.000Z",
        }),
        slot("learning-pack.diagnose-weakness", "learning-pack", DEFAULT_PACK),
        slot("review-pack-teacher", "review-pack", DEFAULT_PACK),
      ]),
    );
    mockedSave.mockResolvedValue(settingsData());
    renderSection();
    const intro = await screen.findByLabelText(
      "标题-content-ai-instruction提示词正文",
    );
    expect(intro).toHaveValue("已自定义的开场");
    // 前 8 个恢复默认按钮中第一个属于出题助手槽位（每槽位各一个）
    fireEvent.click(
      screen.getAllByRole("button", { name: /恢复默认/ })[0] as HTMLElement,
    );
    expect(intro).toHaveValue(DEFAULT_INTRO);
    fireEvent.click(screen.getByRole("button", { name: "保存全部改动" }));
    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledTimes(1);
    });
    expect(mockedSave).toHaveBeenCalledWith({
      updates: [{ key: "content-ai-instruction", body: null }],
      baseUpdatedAt: "2026-10-25T07:00:00.000Z",
    });
  });

  it("409 冲突：显示冲突提示，显式放弃本地更改后重取服务器值", async () => {
    mockedFetch.mockResolvedValue(settingsData());
    mockedSave.mockRejectedValue(
      new ApiError("AI_SETTINGS_STALE", "已在其他页面被修改", 409),
    );
    renderSection();
    const intro = await screen.findByLabelText(
      "标题-content-ai-instruction提示词正文",
    );
    fireEvent.change(intro, { target: { value: "本地未保存编辑" } });
    fireEvent.click(screen.getByRole("button", { name: "保存全部改动" }));
    expect(await screen.findByText(/已在其他页面被修改/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /放弃本地更改并重新加载/ }),
    );
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });
    expect(
      screen.queryByText(/放弃本地更改并重新加载/),
    ).not.toBeInTheDocument();
  });

  it("变化中的槽位正文为空 → 保存禁用并提示", async () => {
    mockedFetch.mockResolvedValue(settingsData());
    renderSection();
    const intro = await screen.findByLabelText(
      "标题-content-ai-instruction提示词正文",
    );
    fireEvent.change(intro, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "保存全部改动" })).toBeDisabled();
    expect(screen.getByText(/正文为空|有槽位正文为空/)).toBeInTheDocument();
  });
});
