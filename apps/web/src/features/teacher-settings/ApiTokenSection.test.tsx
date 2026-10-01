import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiTokenSection } from "@/features/teacher-settings/ApiTokenSection";
import { fetchApiToken, resetApiToken } from "@/lib/api";

/**
 * 设置页「AI 连接（API Token）」区组件测试（T4.6 D22）：
 * - 三态：未生成（提示 + 生成按钮）、已生成（明文展示 + 复制 + 重置）、加载失败；
 * - 生成：直接调用（无弹层）；
 * - 重置：二次确认弹层（含「已配置的客户端需要更新」提示）→ 确认才调用；
 * - 复制：copyText 成功反馈「已复制」（clipboard mock）。
 * API 层 mock（服务端流转由路由测试覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchApiToken: vi.fn(),
    resetApiToken: vi.fn(),
  };
});

const mockedFetch = vi.mocked(fetchApiToken);
const mockedReset = vi.mocked(resetApiToken);

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiTokenSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue({ token: null });
});

describe("ApiTokenSection（T4.6 D22）", () => {
  it("未生成：提示文案 + 「生成 Token」按钮，点击直接调用（无确认弹层）", async () => {
    mockedReset.mockResolvedValue({ token: "new-token-abc" });
    renderSection();

    expect(await screen.findByText(/尚未生成 Token/)).toBeVisible();
    const generate = screen.getByRole("button", { name: /生成 Token/ });
    expect(generate).toBeEnabled();
    fireEvent.click(generate);

    await waitFor(() => {
      expect(mockedReset).toHaveBeenCalledTimes(1);
    });
    // 未生成时首次生成不弹确认（无重置损失）
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("已生成：明文展示（可随时查看，D22）+ 复制反馈 + 重置按钮", async () => {
    mockedFetch.mockResolvedValue({ token: "t46-token-plain-value" });
    // clipboard mock（jsdom 无安全上下文时的 writeText 路径）
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderSection();

    expect(await screen.findByText("t46-token-plain-value")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /复制/ }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("t46-token-plain-value");
    });
    expect(await screen.findByText("已复制")).toBeVisible();

    expect(
      screen.getByRole("button", { name: /重置 Token/ }),
    ).toBeEnabled();
  });

  it("重置走二次确认弹层：提示旧 token 立即失效与客户端需更新；确认后调用、取消不调用", async () => {
    mockedFetch.mockResolvedValue({ token: "old-token-t46" });
    mockedReset.mockResolvedValue({ token: "new-token-t46" });
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: /重置 Token/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeVisible();
    expect(screen.getByText("重置 API Token？")).toBeVisible();
    expect(
      screen.getByText(/已配置的客户端（如 Claude Desktop）需要更新为新 Token/),
    ).toBeVisible();
    expect(mockedReset).not.toHaveBeenCalled();

    // 取消：不调用
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(mockedReset).not.toHaveBeenCalled();

    // 再开 → 确认：调用
    fireEvent.click(screen.getByRole("button", { name: /重置 Token/ }));
    fireEvent.click(await screen.findByRole("button", { name: "确认重置" }));
    await waitFor(() => {
      expect(mockedReset).toHaveBeenCalledTimes(1);
    });
  });

  it("加载失败显示错误文案", async () => {
    mockedFetch.mockRejectedValue(new Error("boom"));
    renderSection();
    expect(await screen.findByText("boom")).toBeVisible();
  });

  it("操作失败显示错误文案（重置报错）", async () => {
    mockedFetch.mockResolvedValue({ token: null });
    mockedReset.mockRejectedValue(new Error("重置失败"));
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: /生成 Token/ }));
    expect(await screen.findByText("重置失败")).toBeVisible();
  });
});
