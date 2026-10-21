import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import {
  bindAiDisplayAccount,
  getAiDisplayPreference,
  saveAiDisplayPreference,
} from "./ai-display-preference-store";
import { StudentAiDisplaySection } from "./StudentAiDisplaySection";

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  bindAiDisplayAccount(null);
  bindAiDisplayAccount("a");
});
const show = () =>
  render(
    <MemoryRouter>
      <StudentAiDisplaySection />
    </MemoryRouter>,
  );

it("三种选项暂存，取消与保存语义分离", () => {
  show();
  expect(screen.getByRole("radio", { name: /题下阅读/ })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: /侧边对照/ }));
  expect(getAiDisplayPreference().layout).toBe("inline");
  fireEvent.click(screen.getByRole("button", { name: "取消更改" }));
  expect(screen.getByRole("radio", { name: /题下阅读/ })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: /独立弹窗/ }));
  fireEvent.click(screen.getByRole("button", { name: "保存显示方式" }));
  expect(getAiDisplayPreference().layout).toBe("dialog");
  expect(screen.getByRole("status")).toHaveTextContent("已保存");
});

it("保存失败保留编辑并说明重试", () => {
  show();
  fireEvent.click(screen.getByRole("radio", { name: /侧边对照/ }));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("拒绝");
  });
  fireEvent.click(screen.getByRole("button", { name: "保存显示方式" }));
  expect(screen.getByRole("alert")).toHaveTextContent("重试");
  expect(screen.getByRole("radio", { name: /侧边对照/ })).toBeChecked();
  expect(getAiDisplayPreference().layout).toBe("inline");
});

it("其他标签保存不覆盖当前未保存编辑", async () => {
  show();
  fireEvent.click(screen.getByRole("radio", { name: /侧边对照/ }));
  const { act } = await import("@testing-library/react");
  act(() => saveAiDisplayPreference("dialog"));
  expect(screen.getByRole("radio", { name: /侧边对照/ })).toBeChecked();
  expect(screen.getByText(/其他页面/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "载入已保存值" }));
  expect(screen.getByRole("radio", { name: /独立弹窗/ })).toBeChecked();
});
