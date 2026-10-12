import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

function renderSection(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
  teacherId = "current",
) {
  return render(
    <QueryClientProvider client={client}>
      <CapabilityProfileSection teacherId={teacherId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CapabilityProfileSection（T7.7 辅助能力设置区）", () => {
  it("返回页面仍保留草稿，教师之间隔离，草稿不因查询回收而丢失", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockedFetch.mockResolvedValue({ enabledCapabilities: ["steps", "ink"] });
    const first = renderSection(client, "teacher-one");
    fireEvent.click(await screen.findByLabelText("手写辅助"));
    first.unmount();
    const second = renderSection(client, "teacher-two");
    expect(await screen.findByLabelText("手写辅助")).toBeChecked();
    second.unmount();
    renderSection(client, "teacher-one");
    expect(await screen.findByLabelText("手写辅助")).not.toBeChecked();
    expect(
      client.getQueryDefaults(["teacher", "capability-draft", "teacher-one"])
        .gcTime,
    ).toBe(Infinity);
  });
  it("后台重取不得覆盖未保存选择，保存失败后仍可重试", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockedFetch.mockResolvedValue({ enabledCapabilities: ["steps", "ink"] });
    renderSection(client);
    fireEvent.click(await screen.findByLabelText("手写辅助"));
    await act(async () => {
      client.setQueryData(["teacher", "capability-profile"], {
        enabledCapabilities: ["steps"],
      });
    });
    await waitFor(() =>
      expect(screen.getByLabelText("逐步揭晓")).toBeChecked(),
    );
    await act(async () => {
      client.setQueryData(["teacher", "capability-profile"], {
        enabledCapabilities: ["steps", "ink"],
      });
    });
    await waitFor(() =>
      expect(screen.getByLabelText("手写辅助")).not.toBeChecked(),
    );
    mockedSave.mockRejectedValue(new Error("测试保存失败"));
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("手写辅助")).not.toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("有未保存的更改");
  });
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
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await waitFor(() =>
      expect(mockedSave).toHaveBeenCalledWith({
        enabledCapabilities: ["steps", "ink"],
      }),
    );
  });

  it("保存成功后再改动勾选：「已保存」退回「保存」（存在未保存修改时不误导）", async () => {
    mockedFetch.mockResolvedValue({ enabledCapabilities: ["steps", "ink"] });
    renderSection();
    mockedSave.mockResolvedValue({ enabledCapabilities: ["steps", "ink"] });
    fireEvent.click(await screen.findByRole("button", { name: "保存更改" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("更改已保存"),
    );
    // 改动勾选（存在未保存修改）→ 标签退回「保存」
    fireEvent.click(screen.getByLabelText("手写辅助"));
    expect(screen.getByRole("status")).toHaveTextContent("有未保存的更改");
    expect(screen.getByRole("button", { name: "保存更改" })).toBeTruthy();
  });

  it("全部取消后保存：收到空数组（显式全关是合法配置）", async () => {
    mockedFetch.mockResolvedValue({ enabledCapabilities: ["steps", "ink"] });
    renderSection();
    fireEvent.click(await screen.findByLabelText("逐步揭晓"));
    fireEvent.click(screen.getByLabelText("手写辅助"));
    mockedSave.mockResolvedValue({ enabledCapabilities: [] });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await waitFor(() =>
      expect(mockedSave).toHaveBeenCalledWith({ enabledCapabilities: [] }),
    );
  });
});
