import { fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, useLocation } from "react-router";
import { expect, it, vi } from "vitest";
import {
  SettingsNavigationProvider,
  useSettingsNavigation,
} from "./settings-navigation";

it("未保存时普通离开须确认，分类切换不拦截；取消继续编辑，确认才放弃", async () => {
  const discard = vi.fn();
  function Content() {
    const navigation = useSettingsNavigation();
    return (
      <>
        <button
          type="button"
          onClick={() => navigation?.setDraft({ dirty: true, discard })}
        >
          修改配置
        </button>
        <Link to="/t/settings?section=backup">切换分类</Link>
        <Link to="/t/library">离开设置</Link>
        <output>{useLocation().pathname}</output>
      </>
    );
  }
  render(
    <MemoryRouter initialEntries={["/t/settings"]}>
      <SettingsNavigationProvider>
        <Content />
      </SettingsNavigationProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "修改配置" }));
  fireEvent.click(screen.getByRole("link", { name: "切换分类" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "离开设置" }));
  expect(await screen.findByRole("dialog")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  expect(discard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("link", { name: "离开设置" }));
  fireEvent.click(screen.getByRole("button", { name: "放弃更改并离开" }));
  expect(discard).toHaveBeenCalledOnce();
  expect(screen.getByRole("status")).toHaveTextContent("/t/library");
});
