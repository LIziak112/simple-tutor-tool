import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeyboardBindingsSection } from "./KeyboardBindingsSection";
import {
  bindKeyboardBindingsAccount,
  saveKeyboardBindings,
} from "./keyboard-binding-store";
import {
  detectKeyboardDeviceForTest,
  resetKeyboardDeviceForTest,
} from "./keyboard-device";

/**
 * 设置页「自定义键位」分区（2026-10-28 快捷键体系）：仅键盘设备渲染；录制式
 * 改键（Esc 取消、Ctrl/Alt/Cmd 拒绝并给原因）；冲突（含撞固定键 1–9）标红并
 * 禁存；暂存-保存与恢复默认；未绑定账号提示登录。jsdom 恒走懒探测分支，
 * detectKeyboardDeviceForTest 模拟键盘设备接入。
 */

const storageKeyOf = (id: string) =>
  `ownclass:keyboard-bindings:${JSON.stringify([location.origin, "student", id])}`;

function openEditor() {
  render(<KeyboardBindingsSection />);
  const summary = screen.getByText("自定义键位").closest("summary");
  if (!summary) throw new Error("缺少展开入口");
  fireEvent.click(summary);
  return summary;
}

/** 展开并进入某命令的录制态，返回该命令行 */
function startRecording(label: string): HTMLElement {
  const row = screen.getByText(label).closest("li");
  if (!row) throw new Error(`缺少命令行：${label}`);
  fireEvent.click(within(row).getByRole("button", { name: "修改" }));
  return row;
}

beforeEach(() => {
  localStorage.clear();
  resetKeyboardDeviceForTest();
  bindKeyboardBindingsAccount(null);
  vi.restoreAllMocks();
});

describe("自定义键位分区", () => {
  it("纯触屏设备（未探测键盘）不渲染分区", () => {
    render(<KeyboardBindingsSection />);
    expect(screen.queryByText("自定义键位")).toBeNull();
  });

  it("键盘设备展开可见全部命令：默认键位展示、固定项标注", () => {
    detectKeyboardDeviceForTest();
    bindKeyboardBindingsAccount("kbd-section");
    openEditor();
    expect(screen.getByText("提交本题 / 下一题")).toBeInTheDocument();
    expect(screen.getByText("上一题")).toBeInTheDocument();
    expect(screen.getByText("下一题")).toBeInTheDocument();
    expect(screen.getByText("快捷键帮助")).toBeInTheDocument();
    expect(screen.getByText("选择第 1–9 个选项")).toBeInTheDocument();
    expect(screen.getByText("退出 / 关闭")).toBeInTheDocument();
    expect(screen.getByText("Enter")).toBeInTheDocument();
    expect(screen.getByText("?")).toBeInTheDocument();
    expect(screen.getByText("1–9")).toBeInTheDocument();
    expect(screen.getByText("Esc")).toBeInTheDocument();
    expect(screen.getAllByText("固定")).toHaveLength(2);
  });

  it("录制改键并保存：行内键位更新、写入契约 v1 形态、提示已保存", () => {
    detectKeyboardDeviceForTest();
    bindKeyboardBindingsAccount("kbd-section");
    openEditor();
    const row = startRecording("下一题");
    expect(screen.getByText(/按下新快捷键，Esc 取消/)).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "j" });
    expect(within(row).getByText("j")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "保存键位" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(screen.getByText("键位已保存")).toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(storageKeyOf("kbd-section")) ?? "{}"),
    ).toEqual({
      version: 1,
      bindings: { "practice.next-question": ["j"] },
    });
  });

  it("Esc 取消录制；Ctrl 组合与不可绑定键给拒绝文案且不退出录制", () => {
    detectKeyboardDeviceForTest();
    bindKeyboardBindingsAccount("kbd-section");
    openEditor();
    const row = startRecording("下一题");
    fireEvent.keyDown(document.body, { key: "x", ctrlKey: true });
    expect(
      screen.getByText(/不支持含 Ctrl \/ Alt \/ Cmd 的组合/),
    ).toBeInTheDocument();
    expect(screen.getByText(/按下新快捷键/)).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(screen.getByText(/该键不可绑定/)).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByText(/按下新快捷键/)).toBeNull();
    expect(within(row).getByText("→")).toBeInTheDocument();
  });

  it("两个命令改到同键：后到者标红冲突并禁存；撞固定键（1–9）同样拒绝", () => {
    detectKeyboardDeviceForTest();
    bindKeyboardBindingsAccount("kbd-section");
    openEditor();
    startRecording("上一题");
    fireEvent.keyDown(document.body, { key: "j" });
    startRecording("下一题");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(screen.getByText(/与『上一题』冲突/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存键位" })).toBeDisabled();
    // 撞固定键：快捷键帮助改到 2（选项数字）
    startRecording("快捷键帮助");
    fireEvent.keyDown(document.body, { key: "2" });
    expect(screen.getByText(/与『选择第 1–9 个选项』冲突/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存键位" })).toBeDisabled();
  });

  it("恢复默认键位：草稿置空并保存后 storage 留痕空覆盖表", () => {
    detectKeyboardDeviceForTest();
    bindKeyboardBindingsAccount("kbd-section");
    saveKeyboardBindings({ "practice.next-question": ["j"] });
    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "恢复默认键位" }));
    // 摘要徽标与底部提示两处都会出现「有未保存更改」
    expect(screen.getAllByText("有未保存更改").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "保存键位" }));
    expect(localStorage.getItem(storageKeyOf("kbd-section"))).toBe(
      '{"version":1,"bindings":{}}',
    );
  });

  it("未绑定账号提示需要登录状态", () => {
    detectKeyboardDeviceForTest();
    openEditor();
    expect(screen.getByText(/登录后可修改键位/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存键位" })).toBeNull();
  });

  it("跨标签保存后提示并可显式载入已保存值（本地草稿保留）", () => {
    detectKeyboardDeviceForTest();
    bindKeyboardBindingsAccount("kbd-section");
    openEditor();
    const row = startRecording("下一题");
    fireEvent.keyDown(document.body, { key: "j" });
    // 其他标签页保存了 open-help=h
    fireEvent(
      window,
      new StorageEvent("storage", {
        key: storageKeyOf("kbd-section"),
        newValue: '{"version":1,"bindings":{"practice.open-help":["h"]}}',
        storageArea: localStorage,
      }),
    );
    expect(screen.getByText(/其他页面已修改键位/)).toBeInTheDocument();
    expect(within(row).getByText("j")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "载入已保存值" }));
    expect(within(row).getByText("→")).toBeInTheDocument();
    expect(screen.getByText("h")).toBeInTheDocument();
  });
});
