import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BlankAnswersProvider } from "../BlankAnswersContext";
import { RichMarkdown } from "../RichMarkdown";
import { renderMd } from "../test-support/render-md";
// 旧导入路径（兼容层）：探针刻意经 shim 取 useDirectiveTelemetry，
// 与 canonical 导入比对同一引用——锁定 re-export 不是平行副本
import { useDirectiveTelemetry as useLegacyTelemetry } from "./expand-context";
import {
  blankSlotIdOf,
  DirectiveSessionProvider,
  type DirectiveSlotsState,
  type DirectiveTelemetryInfo,
  neutralSlotBinding,
  useDirectiveFill,
  useDirectiveSlots,
  useDirectiveTelemetry,
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

/** 会话状态探针：经两个子命名空间 hook 读会话，旧路径与 canonical 比对同一引用 */
function SessionProbe() {
  const fill = useDirectiveFill();
  const canonical = useDirectiveTelemetry();
  const legacy = useLegacyTelemetry(); // 旧导入路径读同一会话
  return (
    <output
      data-testid="probe"
      data-fill={fill?.values[0] ?? "none"}
      data-telemetry={
        legacy === null ? "null" : legacy === canonical ? "same" : "diff"
      }
    />
  );
}

/** 折叠块夹具：标题「看细节」、内容「说明文字」（默认收起） */
const FOLD_MD = [':::fold{title="看细节"}', "说明文字", ":::"].join("\n");

/** 两步逐步揭晓夹具：第一步默认可见，第二步待揭晓 */
const STEPS_MD = [
  "::::steps",
  ":::step",
  "第一步",
  ":::",
  ":::step",
  "第二步",
  ":::",
  "::::",
].join("\n");

const fillState = (
  overrides?: Partial<{
    values: readonly string[];
    onChange: (index: number, value: string) => void;
    disabled: boolean;
  }>,
) => ({
  values: overrides?.values ?? [],
  onChange: overrides?.onChange ?? vi.fn(),
  disabled: overrides?.disabled ?? false,
});

describe("DirectiveSessionContext（T7.3）", () => {
  it("无 Provider：填空仍是展示空框（下划线），不渲染输入框", () => {
    renderMd("计算：$1+1=$ [[2]]。");
    expect(screen.getByTestId("blank")).toBeTruthy();
    expect(screen.queryByTestId("blank-1")).toBeNull();
  });

  it("无 Provider：折叠与逐步揭晓照常可操作（无遥测静默 no-op）", () => {
    renderMd(FOLD_MD);
    expect(screen.queryByText("说明文字")).toBeNull(); // 默认收起
    fireEvent.click(screen.getByRole("button", { name: "看细节" }));
    expect(screen.getByText("说明文字")).toBeTruthy();

    renderMd(STEPS_MD);
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
          source={`${FOLD_MD}\n\n计算：$3+4=$ [[7]]。`}
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
          source={[FOLD_MD, "", STEPS_MD, "", "计算：$3+4=$ [[7]]。"].join(
            "\n",
          )}
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

  it("显式传 fill=null 同样视为覆盖：内层明确取消作答态（对称分支）", () => {
    render(
      <DirectiveSessionProvider fill={fillState({ values: ["x"] })}>
        <DirectiveSessionProvider fill={null}>
          <SessionProbe />
        </DirectiveSessionProvider>
      </DirectiveSessionProvider>,
    );
    expect(screen.getByTestId("probe").getAttribute("data-fill")).toBe("none");
  });

  it("无任何 Provider：两个子命名空间均为缺省（fill=null、telemetry=null）", () => {
    render(<SessionProbe />);
    const probe = screen.getByTestId("probe");
    expect(probe.getAttribute("data-fill")).toBe("none");
    expect(probe.getAttribute("data-telemetry")).toBe("null"); // null === null → "null"
  });
});

// ---------- slots 子命名空间（UA-02 / 方案 §8.2） ----------
//
// 必测清单（jsdom DOM/class/data-testid 层面；浏览器几何属 TT-04）：
// 两题同名槽位独立、材料与题干跨根编号、不同题提交锁定、外层真实答案与
// 内层公开副本隔离、显式 null 遮蔽、旧 fill Provider 兼容、中性输入 DOM 等价。
// 槽位身份为 (scopeId, slotId)；Provider 未传字段继承外层；冲突时 slots 优先。

/** 双命名空间探针：fill/slots 同时可读（锁委托后的兼容语义） */
function SlotsProbe() {
  const fill = useDirectiveFill();
  const slots = useDirectiveSlots();
  return (
    <output
      data-testid="slots-probe"
      data-fill={fill === null ? "null" : "fill"}
      data-slots={slots === null ? "null" : slots.scopeId}
    />
  );
}

/** 构造 slots 状态：按 slotId（slot-N，N 从 1 起）解析 order=N-1 直通绑定 */
function slotsState(
  scopeId: string,
  values: readonly string[],
  onChange: (order: number, value: string) => void,
  disabled = false,
): DirectiveSlotsState {
  return {
    scopeId,
    disabled,
    get: (slotId) => {
      const order = Number(slotId.slice("slot-".length)) - 1;
      return {
        value: values[order] ?? "",
        onChange: (value) => onChange(order, value),
        disabled,
      };
    },
  };
}

describe("DirectiveSessionContext slots 子命名空间（UA-02，§8.2）", () => {
  it("BlankAnswersProvider 内部委托 slots：slots 命名空间可读、fill 不再由其提供", () => {
    render(
      <BlankAnswersProvider state={fillState({ values: ["甲"] })}>
        <SlotsProbe />
      </BlankAnswersProvider>,
    );
    // 委托后：slots 命名空间可读（scopeId 缺省 "fill"），fill 不再提供——
    // 避免 fill/slots 双供冲突诊断；fill 的直接提供方不受影响（见下例）
    expect(screen.getByTestId("slots-probe").getAttribute("data-slots")).toBe(
      "fill",
    );
    expect(screen.getByTestId("slots-probe").getAttribute("data-fill")).toBe(
      "null",
    );
  });

  it("两题同名槽位独立：slot-1 在两个作用域各自绑定、互不串答", () => {
    const onChangeA = vi.fn();
    const onChangeB = vi.fn();
    render(
      <>
        <DirectiveSessionProvider slots={slotsState("q-1", [], onChangeA)}>
          <RichMarkdown source="题一：[[ ]]" />
        </DirectiveSessionProvider>
        <DirectiveSessionProvider
          slots={slotsState("q-2", ["题二已答"], onChangeB)}
        >
          <RichMarkdown source="题二：[[ ]]" />
        </DirectiveSessionProvider>
      </>,
    );
    const inputs = screen.getAllByTestId("blank-1");
    expect(inputs).toHaveLength(2);
    fireEvent.change(inputs[0] as HTMLInputElement, {
      target: { value: "题一的答案" },
    });
    expect(onChangeA).toHaveBeenCalledWith(0, "题一的答案");
    expect(onChangeB).not.toHaveBeenCalled();
    expect((inputs[1] as HTMLInputElement).value).toBe("题二已答");
  });

  it("材料与题干跨根编号：两个 Markdown 根各在自身作用域内编号，同名槽位不跨根串值", () => {
    // 材料（外层子树）与题干（内层子树）是两个独立 RichMarkdown 根——
    // 各根 blank 都从 slot-1 编号；由各自 Provider 的作用域隔离绑定（§8.2：
    // 跨根顺序由公开结构确定，不能由挂载顺序生成）
    const materialChange = vi.fn();
    const stemChange = vi.fn();
    render(
      <DirectiveSessionProvider
        slots={slotsState("material", [], materialChange)}
      >
        <RichMarkdown source="材料句：[[ ]]" />
        <DirectiveSessionProvider slots={slotsState("stem-q1", [], stemChange)}>
          <RichMarkdown source="题干句：[[ ]]" />
        </DirectiveSessionProvider>
      </DirectiveSessionProvider>,
    );
    const materialInput = screen.getAllByTestId("blank-1")[0];
    const stemInput = screen.getAllByTestId("blank-1")[1];
    fireEvent.change(materialInput as HTMLInputElement, {
      target: { value: "材料侧" },
    });
    expect(materialChange).toHaveBeenCalledWith(0, "材料侧");
    expect(stemChange).not.toHaveBeenCalled();
    expect((stemInput as HTMLInputElement).value).toBe("");
  });

  it("不同题提交锁定：一题 disabled 不影响另一题（独立锁定）", () => {
    render(
      <>
        <DirectiveSessionProvider
          slots={slotsState("q-1", ["甲"], () => {}, true)}
        >
          <RichMarkdown source="已提交题：[[ ]]" />
        </DirectiveSessionProvider>
        <DirectiveSessionProvider slots={slotsState("q-2", [], () => {})}>
          <RichMarkdown source="作答中题：[[ ]]" />
        </DirectiveSessionProvider>
      </>,
    );
    const inputs = screen.getAllByTestId("blank-1");
    expect((inputs[0] as HTMLInputElement).disabled).toBe(true);
    expect((inputs[1] as HTMLInputElement).disabled).toBe(false);
  });

  it("外层真实答案与内层公开副本隔离：内层中性绑定遮蔽外层、不继承真实答案", () => {
    // 外层是真实作答（BlankAnswersProvider 委托产生 slots），内层显式提供
    // 中性 slots（公开底图语义）——就近 Provider 优先，内层输入为空且阻断更新
    const outerChange = vi.fn();
    render(
      <BlankAnswersProvider
        state={fillState({ values: ["真实答案"], onChange: outerChange })}
      >
        <RichMarkdown source="外层真实题：[[ ]]" />
        <DirectiveSessionProvider
          slots={{
            scopeId: "public-copy",
            disabled: true,
            get: () => neutralSlotBinding(),
          }}
        >
          <RichMarkdown source="内层公开副本：[[ ]]" />
        </DirectiveSessionProvider>
      </BlankAnswersProvider>,
    );
    const inputs = screen.getAllByTestId("blank-1");
    expect((inputs[0] as HTMLInputElement).value).toBe("真实答案");
    const copy = inputs[1] as HTMLInputElement;
    expect(copy.value).toBe(""); // 不继承外层真实答案
    expect(copy.disabled).toBe(true); // 无副作用更新
    fireEvent.change(copy, { target: { value: "尝试填写" } });
    expect(outerChange).not.toHaveBeenCalled();
  });

  it("显式 slots=null 同时遮蔽外层 slots 与旧 fill 兼容读取：内层渲染展示空框", () => {
    const outerFill = fillState({ values: ["fill 外层值"] });
    render(
      // 外层同时提供旧 fill（兼容路径）与委托 slots 的真实作答层，
      // 内层显式 slots=null → 两个命名空间都被遮蔽，blank 回落展示空框
      <>
        <DirectiveSessionProvider fill={outerFill}>
          <RichMarkdown source="fill 外层：[[ ]]" />
          <DirectiveSessionProvider slots={null}>
            <RichMarkdown source="内层：[[ ]]" />
          </DirectiveSessionProvider>
        </DirectiveSessionProvider>
        <BlankAnswersProvider state={fillState({ values: ["slots 外层值"] })}>
          <RichMarkdown source="slots 外层：[[ ]]" />
          <DirectiveSessionProvider slots={null}>
            <RichMarkdown source="内层二：[[ ]]" />
          </DirectiveSessionProvider>
        </BlankAnswersProvider>
      </>,
    );
    expect(
      (screen.getAllByTestId("blank-1")[0] as HTMLInputElement).value,
    ).toBe("fill 外层值"); // 外层 fill 提供方照常作答
    expect(
      (screen.getAllByTestId("blank-1")[1] as HTMLInputElement).value,
    ).toBe("slots 外层值"); // 外层 slots 提供方照常作答
    const spans = screen.getAllByTestId("blank");
    expect(spans).toHaveLength(2);
    for (const span of spans) expect(span.tagName).toBe("SPAN");
  });

  it("旧 fill Provider 兼容：直接以 DirectiveSessionProvider fill= 提供仍可作答（回退路径）", () => {
    const onChange = vi.fn();
    render(
      <DirectiveSessionProvider
        fill={fillState({ values: ["旧值"], onChange })}
      >
        <RichMarkdown source="旧路径：[[ ]]" />
      </DirectiveSessionProvider>,
    );
    const input = screen.getByTestId("blank-1") as HTMLInputElement;
    expect(input.value).toBe("旧值");
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "新值" } });
    expect(onChange).toHaveBeenCalledWith(0, "新值");
  });

  it("中性输入 DOM 等价：与真实输入同结构同 class 同 data-testid，仅无答案值", () => {
    render(
      <>
        <DirectiveSessionProvider
          slots={slotsState("live", ["真实值"], () => {})}
        >
          <RichMarkdown source="真实：[[ ]]" />
        </DirectiveSessionProvider>
        <DirectiveSessionProvider
          slots={{
            scopeId: "public",
            disabled: true,
            get: () => neutralSlotBinding(),
          }}
        >
          <RichMarkdown source="公开：[[ ]]" />
        </DirectiveSessionProvider>
      </>,
    );
    const [live, neutral] = screen.getAllByTestId("blank-1");
    if (live === undefined || neutral === undefined) {
      throw new Error("中性 DOM 等价测试应渲染两个第 1 空输入");
    }
    expect(neutral.tagName).toBe("INPUT");
    expect(neutral.getAttribute("class")).toBe(live.getAttribute("class"));
    expect(neutral.getAttribute("aria-label")).toBe(
      live.getAttribute("aria-label"),
    );
    expect((neutral as HTMLInputElement).value).toBe("");
  });

  it("fill 与 slots 双供冲突：开发诊断一次性提示，且 slots 优先", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fillChange = vi.fn();
    const slotsChange = vi.fn();
    // 外层提供 slots，内层提供 fill（继承后两会话字段同时非 null）
    render(
      <DirectiveSessionProvider
        slots={slotsState("outer-slots", ["slots 值"], slotsChange)}
      >
        <DirectiveSessionProvider
          fill={fillState({ values: ["fill 值"], onChange: fillChange })}
        >
          <RichMarkdown source="冲突：[[ ]]" />
        </DirectiveSessionProvider>
      </DirectiveSessionProvider>,
    );
    const input = screen.getByTestId("blank-1") as HTMLInputElement;
    expect(input.value).toBe("slots 值"); // 单一优先级：新 slots 优先
    fireEvent.change(input, { target: { value: "改" } });
    expect(slotsChange).toHaveBeenCalledWith(0, "改");
    expect(fillChange).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1); // 开发诊断一次性
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/slots/u);
    warn.mockRestore();
  });

  it("blankSlotIdOf：order 0 起 → slot-1（与 analyzeSlots 同一派生规则）", () => {
    expect(blankSlotIdOf(0)).toBe("slot-1");
    expect(blankSlotIdOf(2)).toBe("slot-3");
  });
});
