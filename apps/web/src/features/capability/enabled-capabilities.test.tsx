import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { InkDoc } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installDraftBackend,
  memoryBackend,
} from "@/features/attempt/draft-store";
import {
  HandwrittenControls,
  type HandwrittenControlsProps,
} from "@/features/attempt/HandwrittenControls";
import {
  EnabledCapabilitiesProvider,
  toEnabledCapabilities,
} from "@/features/capability/enabled-capabilities";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { renderMd } from "@/features/markdown/test-support/render-md";

/**
 * T7.7 辅助能力启用集前端测试（方案 §4.5）：
 * - Context：无 Provider 全启用（教师预览/旧载荷/既有测试零改动）；Provider 值生效；
 *   toEnabledCapabilities 归一（未提供=全启用、空数组=全关）；
 * - steps 关：全部步骤完整可见、无「显示下一步」按钮（不伪造 reveal）；
 * - ink 关：手写/全屏入口隐藏，最终答案输入保留。
 */

vi.mock("@/lib/api", () => ({
  fetchAttemptInkApi: vi.fn(async () => null as InkDoc | null),
  putAttemptInkApi: vi.fn(async () => ({
    questionId: "q1",
    inkId: "ink-1",
    strokeCount: 0,
    width: 0,
    height: 0,
    updatedAt: "2026-09-27T00:00:00.000Z",
  })),
  studentInkPngUrl: (attemptId: string, questionId: string) =>
    `/api/student/attempts/${attemptId}/ink/${questionId}.png`,
}));

vi.mock("mathlive", () => {
  class FakeMathfield extends HTMLElement {
    static fontsDirectory: string | null = null;
    static soundsDirectory: string | null = null;
    getValue(): string {
      return this.getAttribute("value") ?? "";
    }
  }
  return { MathfieldElement: FakeMathfield };
});
vi.mock("mathlive/fonts.css", () => ({}));

vi.mock("@/features/ink/InkPad", () => ({
  InkPad: () => <div data-slot="ink-pad" data-engine="atrament" />,
}));

const STEPS_MD = `::::steps
:::step{title="第一步"}
先看条件。
:::
:::step{title="第二步"}
再代公式。
:::
:::step{title="第三步"}
得出结论。
:::
::::
`;

beforeEach(() => {
  installDraftBackend(memoryBackend());
});

describe("enabled-capabilities Context", () => {
  it("toEnabledCapabilities：未提供/null 全启用；空数组全关；单项归一", () => {
    expect(toEnabledCapabilities(undefined)).toEqual({
      steps: true,
      ink: true,
    });
    expect(toEnabledCapabilities(null)).toEqual({ steps: true, ink: true });
    expect(toEnabledCapabilities([])).toEqual({ steps: false, ink: false });
    expect(toEnabledCapabilities(["steps"])).toEqual({
      steps: true,
      ink: false,
    });
    expect(toEnabledCapabilities(["ink"])).toEqual({
      steps: false,
      ink: true,
    });
  });

  it("无 Provider：steps 逐步揭晓照常（按钮在、逐个展开）——教师预览与旧载荷缺省", () => {
    renderMd(STEPS_MD);
    expect(screen.getByRole("button", { name: /显示下一步/ })).toBeTruthy();
    // 第一步可见、第二步隐藏（逐步揭晓默认语义不变）
    expect(screen.getByText("先看条件。")).toBeTruthy();
    expect(screen.queryByText("再代公式。")).toBeNull();
  });

  it("steps 关闭：全部步骤完整可见、无「显示下一步」按钮（不伪造 reveal）", () => {
    render(
      <EnabledCapabilitiesProvider value={{ steps: false, ink: true }}>
        <RichMarkdown source={STEPS_MD} />
      </EnabledCapabilitiesProvider>,
    );
    // 三步全部直接可见
    expect(screen.getByText("先看条件。")).toBeTruthy();
    expect(screen.getByText("再代公式。")).toBeTruthy();
    expect(screen.getByText("得出结论。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /显示下一步/ })).toBeNull();
  });
});

describe("HandwrittenControls 的 ink 回退", () => {
  /** 渲染手写控件（可包 Provider） */
  function renderControls(
    enabled?: { steps: boolean; ink: boolean },
    onAnswer: HandwrittenControlsProps["onAnswer"] = () => {},
  ) {
    const controls = (
      <HandwrittenControls
        attemptId="attempt-1"
        questionId="q-solve"
        stemMd="计算题"
        answer={undefined}
        onAnswer={onAnswer}
      />
    );
    return render(
      enabled === undefined ? (
        controls
      ) : (
        <EnabledCapabilitiesProvider value={enabled}>
          {controls}
        </EnabledCapabilitiesProvider>
      ),
    );
  }

  it("无 Provider：手写入口照常（展开/全屏按钮在）", async () => {
    renderControls();
    expect(
      await screen.findByRole("button", { name: /展开手写区/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /全屏作答/ })).toBeTruthy();
  });

  it("ink 关闭：两个手写入口隐藏；最终答案输入保留可填写", async () => {
    const onAnswer = vi.fn();
    renderControls({ steps: true, ink: false }, onAnswer);
    // 挂载期笔迹拉取（fetch mock null）完成后入口判定稳定
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /展开手写区/ })).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: /全屏作答/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /收起手写区/ })).toBeNull();
    // 正式作答不受影响：最终答案输入在且可填写（onAnswer 收到 final 形态）
    const input = screen.getByLabelText(/最终答案/);
    expect((input as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(input, { target: { value: "42" } });
    expect(onAnswer).toHaveBeenCalledWith(
      { kind: "final", finalAnswer: "42" },
      true,
    );
  });
});
