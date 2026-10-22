import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindPracticePreferenceAccount,
  getPracticePreference,
} from "./practice-preference-store";
import { StudentPracticePreferenceSection } from "./StudentPracticePreferenceSection";

/**
 * 设置区「做题方式」配置行（M3-D1）：默认布局二选一 + 快捷键开关，暂存-保存
 * 模式（选择暂存、保存生效、后台重取不覆盖本地编辑、重新渲染不清空）；
 * 快捷键开关 D1 仅存储不生效，文案不得谎称已生效。
 */

beforeEach(() => {
  localStorage.clear();
  // 模块级 store 跨用例残留：先解绑再绑定，确保从持久化重新读取
  bindPracticePreferenceAccount(null);
  bindPracticePreferenceAccount("student-1");
});

describe("做题方式设置区（M3-D1）", () => {
  it("默认回显已保存偏好；选择暂存，保存后写入存储", async () => {
    const { unmount } = render(<StudentPracticePreferenceSection />);
    // 默认列表 + 快捷键开
    expect(
      (screen.getByRole("radio", { name: /列表/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByRole("radio", { name: /单题/ }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByRole("checkbox", { name: /键盘快捷键/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);

    // 暂存：切单题、关快捷键；保存按钮从禁用变可用
    const save = screen.getByRole("button", { name: "保存做题方式" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /单题/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /键盘快捷键/ }));
    expect(save).toBeEnabled();

    fireEvent.click(save);
    expect(getPracticePreference().layout).toBe("single");
    expect(getPracticePreference().keyboardShortcuts).toBe(false);
    expect(await screen.findByText("做题方式已保存")).toBeInTheDocument();
    unmount();
    bindPracticePreferenceAccount(null);
    bindPracticePreferenceAccount("student-1");
    expect(getPracticePreference().layout).toBe("single");
  });

  it("后台重取（跨标签保存）不覆盖本地未保存编辑，可显式载入已保存值", () => {
    render(<StudentPracticePreferenceSection />);
    fireEvent.click(screen.getByRole("radio", { name: /单题/ }));
    // 其他标签页保存了「列表 + 关快捷键」：本页草稿保留，提示并可显式载入
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: `ownclass:practice-pref:${JSON.stringify([location.origin, "student", "student-1"])}`,
          newValue:
            '{"version":1,"layout":"list","feedback":"per_question","keyboardShortcuts":false}',
          storageArea: localStorage,
        }),
      );
    });
    expect(
      (screen.getByRole("radio", { name: /单题/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByText(/其他页面已修改做题方式/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "载入已保存值" }));
    expect(
      (screen.getByRole("radio", { name: /列表/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByRole("checkbox", { name: /键盘快捷键/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it("重新渲染与收起再展开不清空未保存草稿；取消恢复已保存值", () => {
    const view = render(<StudentPracticePreferenceSection />);
    fireEvent.click(screen.getByRole("radio", { name: /单题/ }));
    view.rerender(<StudentPracticePreferenceSection />);
    expect(
      (screen.getByRole("radio", { name: /单题/ }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消更改" }));
    expect(
      (screen.getByRole("radio", { name: /列表/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(getPracticePreference().layout).toBe("list");
  });

  it("快捷键开关文案注明后续生效，不谎称已启用", () => {
    render(<StudentPracticePreferenceSection />);
    expect(screen.getByText(/后续更新中启用/)).toBeInTheDocument();
  });

  it("保存失败给出明确提示且草稿保留", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("空间不足");
    });
    render(<StudentPracticePreferenceSection />);
    fireEvent.click(screen.getByRole("radio", { name: /单题/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存做题方式" }));
    expect(
      screen.getByText(/未能保存做题方式，请确认账号和浏览器存储后重试/),
    ).toBeInTheDocument();
    expect(
      (screen.getByRole("radio", { name: /单题/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(getPracticePreference().layout).toBe("list");
    vi.restoreAllMocks();
  });

  it("未绑定账号时提示需要登录状态", () => {
    bindPracticePreferenceAccount(null);
    render(<StudentPracticePreferenceSection />);
    expect(screen.getByText(/登录后可设置/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存做题方式" })).toBeDisabled();
  });
});
