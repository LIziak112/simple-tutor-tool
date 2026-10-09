import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCapabilityProfile, saveCapabilityProfile } from "@/lib/api";
import { CapabilityProfileSection } from "./CapabilityProfileSection";

/**
 * T7.7 设置页「辅助能力」区测试：
 * - 回显：未配置（全启用）两勾选框都选中；单项配置只勾对应项；
 * - 保存：取消勾选后点保存 → saveCapabilityProfile 收到剩余子集；
 * - 勾选不直接保存（显式「保存」按钮一次提交）。
 */

vi.mock("@/lib/api", () => ({
  fetchCapabilityProfile: vi.fn(),
  saveCapabilityProfile: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchCapabilityProfile);
const mockedSave = vi.mocked(saveCapabilityProfile);

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CapabilityProfileSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CapabilityProfileSection（T7.7 辅助能力设置区）", () => {
  it("未配置（全启用）：两个勾选框都选中", async () => {
    mockedFetch.mockResolvedValue({ enabledCapabilities: ["steps", "ink"] });
    renderSection();
    expect(await screen.findByLabelText("逐步揭晓")).toBeChecked();
    expect(screen.getByLabelText("手写辅助")).toBeChecked();
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("单项配置回显：只有手写辅助选中；重新勾选并保存收到完整子集", async () => {
    mockedFetch.mockResolvedValue({ enabledCapabilities: ["ink"] });
    renderSection();
    const steps = await screen.findByLabelText("逐步揭晓");
    expect(steps).not.toBeChecked();
    expect(screen.getByLabelText("手写辅助")).toBeChecked();

    // 重新勾上 steps 后保存：收到 steps+ink
    mockedSave.mockResolvedValue({ enabledCapabilities: ["steps", "ink"] });
    fireEvent.click(steps);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mockedSave).toHaveBeenCalledWith({
        enabledCapabilities: ["steps", "ink"],
      }),
    );
  });

  it("全部取消后保存：收到空数组（显式全关是合法配置）", async () => {
    mockedFetch.mockResolvedValue({ enabledCapabilities: ["steps", "ink"] });
    renderSection();
    fireEvent.click(await screen.findByLabelText("逐步揭晓"));
    fireEvent.click(screen.getByLabelText("手写辅助"));
    mockedSave.mockResolvedValue({ enabledCapabilities: [] });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mockedSave).toHaveBeenCalledWith({ enabledCapabilities: [] }),
    );
  });
});
