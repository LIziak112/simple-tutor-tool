import { fireEvent, render, screen } from "@testing-library/react";
import { Library, Settings } from "lucide-react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { TeacherQuickJump } from "./TeacherQuickJump";

const ITEMS = [
  { to: "/t/library", label: "资源库", group: "教学", icon: Library },
  {
    to: "/t/settings",
    label: "设置",
    group: "系统",
    icon: Settings,
    keywords: "sz",
  },
];

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function setup() {
  render(
    <MemoryRouter initialEntries={["/t"]}>
      <TeacherQuickJump items={ITEMS} />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TeacherQuickJump", () => {
  it("Ctrl+K 打开面板，筛选后回车跳转并关闭", async () => {
    setup();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox", { name: "搜索页面" });
    fireEvent.change(input, { target: { value: "sz" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("where")).toHaveTextContent("/t/settings");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("点击按钮打开，无匹配时给出提示", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "快速跳转" }));
    const input = await screen.findByRole("combobox", { name: "搜索页面" });
    fireEvent.change(input, { target: { value: "不存在" } });
    expect(screen.getByText("没有匹配「不存在」的页面")).toBeInTheDocument();
  });
});
