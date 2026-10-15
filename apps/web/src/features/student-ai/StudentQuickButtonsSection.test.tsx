import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  DEFAULT_QUICK_BUTTONS,
  type StudentQuickButtonsData,
} from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchStudentQuickButtonsApi,
  saveStudentQuickButtonsApi,
} from "@/lib/api";
import { StudentQuickButtonsSection } from "./StudentQuickButtonsSection";

/**
 * SAI-08 学生快捷按钮管理组件测试（B03「先测」组件层逐条）：
 * - 未配置显示契约默认四项（名称/提示词/三类附件勾选与常量一致）；
 * - label 与 prompt 分开编辑；附件三类（圈画/草稿/正式手写）独立勾选，
 *   不用一个布尔混淆；
 * - 禁用/重排/删除/新增/删光均只改本地草稿，保存才 PUT 整组
 *   （orderIndex 按数组位次重排 + baseUpdatedAt 锚点）；
 * - 空白名称/提示词阻止保存并提示；删光有空态说明（自由输入仍可用）；
 * - 恢复默认先弹层列明将替换的个人修改，取消无副作用，确认后本地为四默认项；
 * - 409 AI_SETTINGS_STALE 不自动覆盖输入，显式放弃才回到服务器值；
 * - 后台 refetch 不覆盖未保存草稿；卸载重挂草稿仍在；
 * - 「实际发送仍服从教师模式」说明常驻，不依赖 hover；长中文名称完整在 DOM。
 * API 层 mock；真实路由往返见 route-integration.test.tsx 学生端例。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentQuickButtonsApi: vi.fn(),
    saveStudentQuickButtonsApi: vi.fn(),
  };
});

const mockedFetch = vi.mocked(fetchStudentQuickButtonsApi);
const mockedSave = vi.mocked(saveStudentQuickButtonsApi);

/** 未配置形态（服务端约定：默认四项 + 未设置锚点） */
const UNSET: StudentQuickButtonsData = {
  buttons: DEFAULT_QUICK_BUTTONS.map((button) => ({ ...button })),
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
        <StudentQuickButtonsSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue(UNSET);
});

describe("StudentQuickButtonsSection（SAI-08 快捷按钮管理）", () => {
  it("未配置显示默认四项：名称/提示词/附件勾选与契约常量一致；模式说明常驻", async () => {
    renderSection();
    expect(await screen.findByLabelText("第 1 项按钮名称")).toHaveValue(
      "启发下一步",
    );
    expect(screen.getByLabelText("第 4 项按钮名称")).toHaveValue("完整拆解");
    // 附件三类独立回显：启发下一步三项全选、讲核心概念三项全不选
    expect(screen.getByLabelText("第 1 项附圈画")).toBeChecked();
    expect(screen.getByLabelText("第 1 项附草稿")).toBeChecked();
    expect(screen.getByLabelText("第 1 项附正式手写")).toBeChecked();
    expect(screen.getByLabelText("第 3 项附圈画")).not.toBeChecked();
    expect(screen.getByLabelText("第 3 项附草稿")).not.toBeChecked();
    expect(screen.getByLabelText("第 3 项附正式手写")).not.toBeChecked();
    // 实际发送仍服从教师模式的说明是常驻文本（不依赖 hover/title）
    expect(
      screen.getByText(/实际发送时.*服从.*教师设置的教学模式/u),
    ).toBeInTheDocument();
    expect(screen.getByText(/仅启发/u)).toBeInTheDocument();
  });

  it("名称与提示词分开编辑；三类附件独立勾选不互相影响", async () => {
    renderSection();
    await screen.findByLabelText("第 1 项按钮名称");
    // 改名不动提示词；改提示词不动名
    fireEvent.change(screen.getByLabelText("第 1 项按钮名称"), {
      target: { value: "再想想" },
    });
    expect(screen.getByLabelText("第 1 项按钮提示词")).toHaveValue(
      DEFAULT_QUICK_BUTTONS[0]?.prompt ?? "",
    );
    // 编辑第 3 项（讲核心概念）的提示词：与下方 third（buttons[2]）断言一致；
    // 原稿误写「第 2 项」，与同文件「第 1/4 项提示词 = buttons[0]/buttons[3]」口径矛盾
    fireEvent.change(screen.getByLabelText("第 3 项按钮提示词"), {
      target: { value: "看看这一步对不对。" },
    });
    expect(screen.getByLabelText("第 2 项按钮名称")).toHaveValue("查当前步骤");
    // 讲核心概念（默认三项全不选）只勾草稿：三类各自独立
    fireEvent.click(screen.getByLabelText("第 3 项附草稿"));
    expect(screen.getByLabelText("第 3 项附草稿")).toBeChecked();
    expect(screen.getByLabelText("第 3 项附圈画")).not.toBeChecked();
    expect(screen.getByLabelText("第 3 项附正式手写")).not.toBeChecked();

    mockedSave.mockResolvedValue(UNSET);
    fireEvent.click(screen.getByRole("button", { name: "保存快捷按钮" }));
    await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(1));
    const request = mockedSave.mock.calls[0]?.[0];
    const first = request?.buttons[0];
    const third = request?.buttons[2];
    expect(first).toMatchObject({ name: "再想想" });
    expect(first?.prompt).toBe(DEFAULT_QUICK_BUTTONS[0]?.prompt);
    expect(third?.prompt).toBe("看看这一步对不对。");
    expect(third?.name).toBe("讲核心概念");
    expect(third?.attachmentPref).toEqual({
      annotation: false,
      draft: true,
      formalInk: false,
    });
    expect(request?.baseUpdatedAt).toBe(UNSET.updatedAt);
  });

  it("重排（上移）/禁用/删除/新增只改草稿；保存按位次重排 orderIndex", async () => {
    renderSection();
    await screen.findByLabelText("第 2 项上移");
    fireEvent.click(screen.getByLabelText("第 2 项上移"));
    expect(screen.getByLabelText("第 1 项按钮名称")).toHaveValue("查当前步骤");
    // 禁用第 1 项（重排后的查当前步骤）
    fireEvent.click(screen.getByLabelText("第 1 项启用"));
    // 删除第 4 项
    fireEvent.click(screen.getByLabelText("第 4 项删除"));
    // 新增一项
    fireEvent.click(screen.getByRole("button", { name: "新增按钮" }));
    fireEvent.change(screen.getByLabelText("第 4 项按钮名称"), {
      target: { value: "我的按钮" },
    });
    fireEvent.change(screen.getByLabelText("第 4 项按钮提示词"), {
      target: { value: "帮我检查计算。" },
    });

    const saved: StudentQuickButtonsData = {
      buttons: [],
      updatedAt: "2026-10-15T00:00:00.000Z",
    };
    mockedSave.mockResolvedValue(saved);
    fireEvent.click(screen.getByRole("button", { name: "保存快捷按钮" }));
    await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(1));
    const request = mockedSave.mock.calls[0]?.[0];
    expect(request?.buttons.map((b) => b.name)).toEqual([
      "查当前步骤",
      "启发下一步",
      "讲核心概念",
      "我的按钮",
    ]);
    // orderIndex 按保存时数组位次重排为 0..n-1；禁用状态随按钮走
    expect(request?.buttons.map((b) => b.orderIndex)).toEqual([0, 1, 2, 3]);
    expect(request?.buttons[0]?.enabled).toBe(false);
    expect(request?.buttons[1]?.enabled).toBe(true);
  });

  it("空白名称/提示词阻止保存并提示；删光保存空组且有空态说明", async () => {
    renderSection();
    await screen.findByLabelText("第 1 项按钮名称");
    // 清空第 1 项名称 → 保存禁用 + 常驻错误提示
    fireEvent.change(screen.getByLabelText("第 1 项按钮名称"), {
      target: { value: "" },
    });
    const save = screen.getByRole("button", { name: "保存快捷按钮" });
    expect(save).toBeDisabled();
    expect(screen.getByText(/按钮名称不能为空/u)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("第 1 项按钮名称"), {
      target: { value: "启发下一步" },
    });
    expect(save).toBeEnabled();

    // 删光四项：空态说明 + 保存空组
    for (let index = 4; index >= 1; index -= 1)
      fireEvent.click(screen.getByLabelText(`第 ${index} 项删除`));
    expect(
      screen.getByText(/没有快捷按钮也可以直接输入问题/u),
    ).toBeInTheDocument();
    const emptied: StudentQuickButtonsData = {
      buttons: [],
      updatedAt: "2026-10-15T00:00:01.000Z",
    };
    mockedSave.mockResolvedValue(emptied);
    fireEvent.click(screen.getByRole("button", { name: "保存快捷按钮" }));
    await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(1));
    expect(mockedSave.mock.calls[0]?.[0]?.buttons).toEqual([]);
    expect(mockedSave.mock.calls[0]?.[0]?.baseUpdatedAt).toBe(UNSET.updatedAt);
  });

  it("恢复默认：弹层列明替换范围，取消无副作用，确认后草稿为四默认项", async () => {
    renderSection();
    await screen.findByLabelText("第 1 项按钮名称");
    // 先做个人修改（改名 + 删一项）
    fireEvent.change(screen.getByLabelText("第 1 项按钮名称"), {
      target: { value: "我的改法" },
    });
    fireEvent.click(screen.getByLabelText("第 4 项删除"));

    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    const dialog = await screen.findByRole("dialog");
    // 列明将替换的个人修改（当前 3 项），说明只影响快捷按钮
    expect(
      within(dialog).getByText(/将替换当前的 3 项个人配置/u),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/不影响其他设置/u)).toBeInTheDocument();
    // 取消：草稿不动（仍是改名后的 3 项）
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("第 1 项按钮名称")).toHaveValue("我的改法");
    expect(screen.queryByLabelText("第 4 项按钮名称")).not.toBeInTheDocument();
    // 确认：本地草稿回到四默认项（保存前不落库）
    expect(mockedSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "恢复默认",
      }),
    );
    expect(screen.getByLabelText("第 1 项按钮名称")).toHaveValue("启发下一步");
    expect(screen.getByLabelText("第 4 项按钮名称")).toHaveValue("完整拆解");
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("版本冲突 409：输入保留，显式放弃后才回到服务器值", async () => {
    renderSection();
    await screen.findByLabelText("第 1 项按钮名称");
    fireEvent.change(screen.getByLabelText("第 1 项按钮名称"), {
      target: { value: "冲突中的编辑" },
    });
    const serverValue: StudentQuickButtonsData = {
      buttons: DEFAULT_QUICK_BUTTONS.map((button, index) =>
        index === 0 ? { ...button, name: "服务器新名" } : { ...button },
      ),
      updatedAt: "2026-10-15T00:00:02.000Z",
    };
    mockedSave.mockRejectedValue(
      new ApiError(
        "AI_SETTINGS_STALE",
        "快捷按钮已在其他设备修改，请刷新后重试",
        409,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存快捷按钮" }));
    expect(
      await screen.findByRole("button", { name: "放弃本地更改并重新加载" }),
    ).toBeInTheDocument();
    // 本地输入未被覆盖
    expect(screen.getByLabelText("第 1 项按钮名称")).toHaveValue(
      "冲突中的编辑",
    );

    mockedFetch.mockResolvedValue(serverValue);
    fireEvent.click(
      screen.getByRole("button", { name: "放弃本地更改并重新加载" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("第 1 项按钮名称")).toHaveValue(
        "服务器新名",
      ),
    );
  });

  it("后台 refetch 不覆盖未保存草稿；卸载重挂草稿仍在", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const first = renderSection(client);
    fireEvent.change(await screen.findByLabelText("第 1 项按钮名称"), {
      target: { value: "离线草稿" },
    });
    // 服务器已有新值（另一设备保存）：后台失效重取不覆盖本地编辑
    client.setQueryData(["student", "ai-quick-buttons"], {
      buttons: [],
      updatedAt: "2026-10-15T00:00:03.000Z",
    });
    await waitFor(() =>
      expect(
        client.getQueryData(["student", "ai-quick-buttons"]),
      ).toMatchObject({ updatedAt: "2026-10-15T00:00:03.000Z" }),
    );
    expect(screen.getByLabelText("第 1 项按钮名称")).toHaveValue("离线草稿");
    // 卸载重挂：草稿从 queryClient 缓存恢复
    first.unmount();
    renderSection(client);
    expect(await screen.findByLabelText("第 1 项按钮名称")).toHaveValue(
      "离线草稿",
    );
  });

  it("加载失败提供重新加载；保存失败保留编辑可重试", async () => {
    mockedFetch.mockRejectedValueOnce(
      new ApiError("INTERNAL", "网络异常", 500),
    );
    renderSection();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /无法加载快捷按钮/u,
    );
    mockedFetch.mockResolvedValue(UNSET);
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByLabelText("第 1 项按钮名称")).toHaveValue(
      "启发下一步",
    );

    fireEvent.change(screen.getByLabelText("第 1 项按钮名称"), {
      target: { value: "待重试的修改" },
    });
    mockedSave.mockRejectedValueOnce(new ApiError("INTERNAL", "保存失败", 500));
    fireEvent.click(screen.getByRole("button", { name: "保存快捷按钮" }));
    expect(await screen.findByText(/保存失败/u)).toBeInTheDocument();
    expect(screen.getByLabelText("第 1 项按钮名称")).toHaveValue(
      "待重试的修改",
    );
    expect(screen.getByRole("button", { name: "保存快捷按钮" })).toBeEnabled();
  });

  it("长中文名称完整可查看：输入框不截断值、名称上限 16 字符", async () => {
    mockedFetch.mockResolvedValue({
      buttons: [
        {
          id: "long-name",
          name: "一二三四五六七八九十一二三四五六",
          prompt: "很长的中文提示词。",
          orderIndex: 0,
          enabled: true,
          attachmentPref: { annotation: false, draft: false, formalInk: false },
        },
      ],
      updatedAt: "2026-10-15T00:00:04.000Z",
    });
    renderSection();
    const name = await screen.findByLabelText("第 1 项按钮名称");
    expect(name).toHaveValue("一二三四五六七八九十一二三四五六");
    expect(name).toHaveAttribute("maxlength", "16");
    expect(name.className).toMatch(/min-w-0|w-full/u);
    expect(screen.getByLabelText("第 1 项按钮提示词")).toHaveAttribute(
      "maxlength",
      "500",
    );
  });
});
