import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PreparedOf } from "../types";
import { matchingView } from "./matching";

/**
 * matching 视图测试（QM-13 细项 2/5）：槽位行 + 原生 select、不可重复约束的
 * 客户端面（被占选项禁用）、部分配对草稿合法、只读/参考/对照/完成度。
 * 防泄露：视图不渲染参考答案（Reference/Comparison 只消费宿主授权材料）；
 * 2026-10-25 审查 P1 收紧起模型选项不含 distractor 标记（池内一律可选）。
 */

const baseModel: PreparedOf<"matching"> = {
  kind: "matching",
  scopeId: "scope-m",
  stemMd: "从选项中为空白处选择内容。",
  options: [
    { key: "opt-1", text: "选项甲" },
    { key: "opt-2", text: "选项乙" },
    { key: "opt-8", text: "干扰项" },
  ],
  slotIds: ["slot-1", "slot-2"],
  allowRepeat: false,
};

function modelOf(model: PreparedOf<"matching"> = baseModel) {
  return model;
}

describe("matching Input", () => {
  it("每槽位一行原生 select（键盘/触摸原生语义）；选择即时回调不 defer", () => {
    const update = vi.fn();
    render(matchingView.Input({ model: modelOf(), answer: undefined, update }));
    const first = screen.getByLabelText("第 1 空的选项");
    expect(first).toBeInTheDocument();
    expect(screen.getByLabelText("第 2 空的选项")).toBeInTheDocument();
    fireEvent.change(first, { target: { value: "opt-1" } });
    expect(update).toHaveBeenCalledWith(
      { kind: "matching", pairs: { "slot-1": "opt-1" } },
      undefined,
    );
  });

  it("不可重复：已占选项在其他槽位下拉中禁用；选回空值清除该槽（部分草稿合法）", () => {
    const update = vi.fn();
    render(
      matchingView.Input({
        model: modelOf(),
        answer: { kind: "matching", pairs: { "slot-1": "opt-1" } },
        update,
      }),
    );
    const second = screen.getByLabelText("第 2 空的选项");
    const secondOptions = within(second);
    expect(
      (
        secondOptions.getByRole("option", {
          name: "选项甲",
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    // 干扰项在池内可选（§6.1 调整 6：选错是答案错误而非形状错误）
    expect(
      (
        secondOptions.getByRole("option", {
          name: "干扰项",
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(false);
    // 选回空值清除该槽（部分配对 → 清除 → 空 pairs = 未作答清除态，保存合法）
    fireEvent.change(screen.getByLabelText("第 1 空的选项"), {
      target: { value: "" },
    });
    expect(update).toHaveBeenCalledWith(
      { kind: "matching", pairs: {} },
      undefined,
    );
  });

  it("disabled 透传禁用；结构不可用显式报错不静默降级", () => {
    const { unmount } = render(
      matchingView.Input({
        model: modelOf(),
        answer: undefined,
        update: () => {},
        disabled: true,
      }),
    );
    expect(
      (screen.getByLabelText("第 1 空的选项") as HTMLSelectElement).disabled,
    ).toBe(true);
    unmount();
    render(
      matchingView.Input({
        model: modelOf({ ...baseModel, slotIds: [] }),
        answer: undefined,
        update: () => {},
      }),
    );
    expect(screen.getByRole("alert").textContent).toContain("不完整");
  });
});

describe("matching ReadOnly / Reference / Comparison", () => {
  it("ReadOnly：按槽位序逐行；未作答与部分作答各自如实呈现", () => {
    const model = modelOf();
    const { container, rerender } = render(
      matchingView.ReadOnly({ model, answer: undefined }),
    );
    expect(container.textContent).toContain("未作答");
    rerender(
      matchingView.ReadOnly({
        model,
        answer: { kind: "matching", pairs: { "slot-2": "opt-8" } },
      }),
    );
    expect(container.textContent).toContain("第 2 空：干扰项");
    expect(container.textContent).toContain("第 1 空：未选择");
  });

  it("Comparison：两栏对照（本人行 vs 参考行），公布三态由宿主携带", () => {
    const model = modelOf();
    const { container } = render(
      matchingView.Comparison({
        model,
        answer: { kind: "matching", pairs: { "slot-1": "opt-1" } },
        reference: {
          status: "available",
          reference: { kind: "matching", pairs: { "slot-1": "opt-2" } },
        },
      }),
    );
    expect(container.textContent).toContain("你的答案：");
    expect(container.textContent).toContain("第 1 空：选项甲");
    expect(container.textContent).toContain("参考答案：");
    expect(container.textContent).toContain("第 1 空：选项乙");
  });
});

describe("matching completion", () => {
  it("分项未填=partial 草稿合法；全部槽位配对=filled；无配对=empty", () => {
    const model = modelOf();
    expect(matchingView.completion(model, undefined, false)).toEqual({
      state: "empty",
      filledSlots: 0,
      expectedSlots: 2,
    });
    expect(
      matchingView.completion(
        model,
        { kind: "matching", pairs: { "slot-1": "opt-1" } },
        false,
      ),
    ).toEqual({ state: "partial", filledSlots: 1, expectedSlots: 2 });
    expect(
      matchingView.completion(
        model,
        { kind: "matching", pairs: { "slot-1": "opt-1", "slot-2": "opt-2" } },
        false,
      ),
    ).toEqual({ state: "filled", filledSlots: 2, expectedSlots: 2 });
  });
});
