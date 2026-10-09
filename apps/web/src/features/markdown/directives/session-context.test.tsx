import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BlankAnswersProvider } from "../BlankAnswersContext";
import { RichMarkdown } from "../RichMarkdown";
import { renderMd } from "../test-support/render-md";
// 旧导入路径（兼容层）：探针刻意经 shim 取 useDirectiveTelemetry，
// 与 canonical 会话值比对同一引用——锁定 re-export 不是平行副本
import { useDirectiveTelemetry } from "./expand-context";
import {
  DirectiveSessionProvider,
  type DirectiveTelemetryInfo,
  useDirectiveFill,
  useDirectiveSession,
} from "./session-context";

/**
 * 指令会话上下文测试（T7.3 / 方案 §4.2）：
 * - 无 Provider：填空仍显示下划线空框，折叠/逐步揭晓照常可操作（遥测静默）；
 * - 填空 Provider 包 RichMarkdown（题卡外层 → RichMarkdown 内层的真实嵌套）：
 *   输入回显与 onChange 正常，内层遥测设置不覆盖外层填空状态；
 * - 填空与遥测同时工作，事件字段与 T4.0b 形态逐字段一致；
 * - 只读态（结果视图契约）：disabled=true 时输入禁用；
 * - 嵌套 Provider 继承外层、仅覆盖显式提供的字段（含显式 null 遮蔽）。
 */

/** 会话状态探针：把两个子命名空间的可见形态渲染成属性供断言 */
function SessionProbe() {
  const session = useDirectiveSession();
  const legacyReport = useDirectiveTelemetry(); // 旧导入路径读同一会话
  return (
    <output
      data-testid="probe"
      data-fill={session.fill?.values[0] ?? "none"}
      data-telemetry={
        session.telemetry === null
          ? "null"
          : session.telemetry === legacyReport
            ? "same"
            : "diff"
      }
    />
  );
}

const fillState = (
  overrides?: Partial<{ values: readonly string[]; disabled: boolean }>,
) => ({
  values: overrides?.values ?? [],
  onChange: vi.fn(),
  disabled: overrides?.disabled ?? false,
});

describe("DirectiveSessionContext（T7.3）", () => {
  it("无 Provider：填空仍是展示空框（下划线），不渲染输入框", () => {
    renderMd("计算：$1+1=$ [[2]]。");
    expect(screen.getByTestId("blank")).toBeTruthy();
    expect(screen.queryByTestId("blank-1")).toBeNull();
  });

  it("无 Provider：折叠与逐步揭晓照常可操作（无遥测静默 no-op）", () => {
    renderMd([':::fold{title="看细节"}', "折叠内容", ":::"].join("\n"));
    expect(screen.queryByText("折叠内容")).toBeNull(); // 默认收起
    fireEvent.click(screen.getByRole("button", { name: "看细节" }));
    expect(screen.getByText("折叠内容")).toBeTruthy();

    renderMd(
      [
        "::::steps",
        ":::step",
        "第一步",
        ":::",
        ":::step",
        "第二步",
        ":::",
        "::::",
      ].join("\n"),
    );
    expect(screen.queryByText("第二步")).toBeNull(); // 仅第一步可见
    fireEvent.click(screen.getByRole("button", { name: /显示下一步/ }));
    expect(screen.getByText("第二步")).toBeTruthy();
  });

  it("填空 Provider 包 RichMarkdown：输入回显 values[i]，onChange 按空序上报", () => {
    const state = fillState({ values: ["42"] });
    render(
      <BlankAnswersProvider state={state}>
        <RichMarkdown source="计算：$40+2=$ [[42]]。" />
      </BlankAnswersProvider>,
    );
    const input = screen.getByTestId("blank-1");
    expect((input as HTMLInputElement).value).toBe("42");
    fireEvent.change(input, { target: { value: "43" } });
    expect(state.onChange).toHaveBeenCalledWith(0, "43");
  });

  it("内层遥测 Provider 不覆盖外层填空状态（题卡外层 → RichMarkdown 内层嵌套）", () => {
    const events: DirectiveTelemetryInfo[] = [];
    render(
      <BlankAnswersProvider state={fillState({ values: ["7"] })}>
        <RichMarkdown
          source={
            ':::fold{title="看细节"}\n说明文字\n:::\n\n计算：$3+4=$ [[7]]。'
          }
          onDirectiveTelemetry={(event) => events.push(event)}
        />
      </BlankAnswersProvider>,
    );
    // 外层 fill 穿透内层遥测 Provider：输入框仍在且显示外层值
    expect((screen.getByTestId("blank-1") as HTMLInputElement).value).toBe("7");
    // 内层遥测正常工作
    fireEvent.click(screen.getByRole("button", { name: "看细节" }));
    expect(events).toEqual([{ name: "fold", index: 1, action: "open" }]);
  });

  it("填空与遥测同时工作：事件字段与 T4.0b 形态逐字段一致（含 reveal 的 step）", () => {
    const events: DirectiveTelemetryInfo[] = [];
    render(
      <BlankAnswersProvider state={fillState({ values: ["7"] })}>
        <RichMarkdown
          source={[
            ':::fold{title="看细节"}',
            "说明文字",
            ":::",
            "",
            "::::steps",
            ":::step",
            "第一步",
            ":::",
            ":::step",
            "第二步",
            ":::",
            "::::",
            "",
            "计算：$3+4=$ [[7]]。",
          ].join("\n")}
          onDirectiveTelemetry={(event) => events.push(event)}
        />
      </BlankAnswersProvider>,
    );
    expect((screen.getByTestId("blank-1") as HTMLInputElement).value).toBe("7");
    fireEvent.click(screen.getByRole("button", { name: "看细节" }));
    fireEvent.click(screen.getByRole("button", { name: /显示下一步/ }));
    // 全局序号：fold=1、steps 容器=2（step 指令不计入 reveal 的 index，step 是容器内序号）
    expect(events).toEqual([
      { name: "fold", index: 1, action: "open" },
      { name: "steps", index: 2, step: 2, action: "reveal" },
    ]);
  });

  it("只读态（结果视图契约）：disabled=true 时填空输入禁用", () => {
    render(
      <BlankAnswersProvider state={fillState({ disabled: true })}>
        <RichMarkdown source="填空：[[答案]]。" />
      </BlankAnswersProvider>,
    );
    expect((screen.getByTestId("blank-1") as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  it("嵌套 Provider 继承外层命名空间，只覆盖显式提供的字段", () => {
    const outerTelemetry = (): void => {};
    render(
      <DirectiveSessionProvider telemetry={outerTelemetry}>
        <DirectiveSessionProvider fill={fillState({ values: ["x"] })}>
          <SessionProbe />
        </DirectiveSessionProvider>
      </DirectiveSessionProvider>,
    );
    const probe = screen.getByTestId("probe");
    expect(probe.getAttribute("data-fill")).toBe("x"); // 内层 fill 生效
    expect(probe.getAttribute("data-telemetry")).toBe("same"); // 外层 telemetry 继承（旧路径读到同一引用）
  });

  it("显式传 null 视为覆盖：内层 telemetry=null 遮蔽外层回调（RichMarkdown 遮蔽语义）", () => {
    render(
      <DirectiveSessionProvider telemetry={() => {}}>
        <DirectiveSessionProvider telemetry={null}>
          <SessionProbe />
        </DirectiveSessionProvider>
      </DirectiveSessionProvider>,
    );
    expect(screen.getByTestId("probe").getAttribute("data-telemetry")).toBe(
      "null",
    );
  });

  it("无任何 Provider：两个子命名空间均为缺省（fill=null、telemetry=null）", () => {
    render(<SessionProbe />);
    const probe = screen.getByTestId("probe");
    expect(probe.getAttribute("data-fill")).toBe("none");
    expect(probe.getAttribute("data-telemetry")).toBe("null"); // null === null → "null"
  });

  it("useDirectiveFill 与会话 fill 子命名空间同源", () => {
    const state = fillState({ values: ["y"] });
    function FillProbe() {
      const fill = useDirectiveFill();
      return (
        <output
          data-testid="fill-probe"
          data-value={fill?.values[0] ?? "none"}
        />
      );
    }
    render(
      <DirectiveSessionProvider fill={state}>
        <FillProbe />
      </DirectiveSessionProvider>,
    );
    expect(screen.getByTestId("fill-probe").getAttribute("data-value")).toBe(
      "y",
    );
  });
});
