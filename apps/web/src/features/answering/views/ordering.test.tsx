import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PreparedOf } from "../types";
import { orderingView } from "./ordering";

/**
 * ordering 视图测试（QM-13 细项 3/5）：固定项锁定不可移、可动项加入/上移/
 * 下移/移除（原生按钮键盘可达）、部分序列草稿合法、固定项锚定入序口径、
 * 只读/参考/对照/完成度。干扰项在池内不加标记（§6.1 调整 6；2026-10-25
 * 审查 P1 收紧起学生面不含逐项 distractor 标记，板行数/完成度由 sortableCount
 * 计数派生——本夹具 2 可排 + 1 固定 = 板 3 行，it-6 为干扰项不计数）。
 */

const baseModel: PreparedOf<"ordering"> = {
  kind: "ordering",
  scopeId: "scope-o",
  stemMd: "将下列段落排成连贯文字。",
  sortableCount: 2,
  items: [
    { key: "it-1", text: "甲：也就是说", fixedPosition: null },
    { key: "it-2", text: "乙：如何评价", fixedPosition: 3 },
    { key: "it-3", text: "丙：不以人废言", fixedPosition: null },
    { key: "it-6", text: "己：豆浆油条", fixedPosition: null },
  ],
};

function modelOf(model: PreparedOf<"ordering"> = baseModel) {
  return model;
}

describe("ordering Input", () => {
  it("固定项预置在声明位并锁定（无移除/移动按钮，徽标可见）；待排序项含干扰项但不加标记", () => {
    render(
      orderingView.Input({
        model: modelOf(),
        answer: undefined,
        update: () => {},
      }),
    );
    // 固定项 it-2 在第 3 位（3 个非干扰项 → 板 3 行）
    expect(screen.getByText("已固定，不可移动")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "第 3 位移除" })).toBeNull();
    // 池：全部 4 项（固定项除外）——it-1/it-3/it-6（干扰项 it-6 无特殊标记）
    // 池内每项一个「加入排序」按钮（固定项不在池）
    expect(screen.getAllByRole("button", { name: "加入排序" })).toHaveLength(3);
    const poolText = screen.getByText("待排序项").parentElement?.textContent;
    expect(poolText).toContain("甲：也就是说");
    expect(poolText).toContain("己：豆浆油条");
    expect(poolText).not.toContain("干扰");
  });

  it("加入排序放入首个空行；序列派生固定项仅锚定入序（前序未满不入）", async () => {
    const update = vi.fn();
    render(orderingView.Input({ model: modelOf(), answer: undefined, update }));
    // 加入甲 → 板 [甲, _, 乙(固定)]；乙未锚定（第 2 行空）→ 序列 [it-1]
    const joinFirst = screen.getAllByRole("button", { name: "加入排序" })[0];
    if (joinFirst === undefined) throw new Error("未找到加入排序按钮");
    fireEvent.click(joinFirst);
    expect(update).toHaveBeenLastCalledWith(
      { kind: "ordering", sequence: ["it-1"] },
      undefined,
    );
  });

  it("锚定入序：前序全满时固定项随序保存；移除前序项后固定项退出序列", async () => {
    const update = vi.fn();
    // 已有 [it-1, it-3]（板 [甲, 丙, 乙(固定)]——乙锚定于第 3 位）
    render(
      orderingView.Input({
        model: modelOf(),
        answer: { kind: "ordering", sequence: ["it-1", "it-3", "it-2"] },
        update,
      }),
    );
    // 恢复后板：it-1→行1、it-3→行2、it-2 固定→行3；序列重派生保持原序
    // 移除第 1 位（it-1）→ 板 [空, 丙, 乙]；乙不再锚定 → 序列 [it-3]
    fireEvent.click(screen.getByRole("button", { name: "第 1 位移除" }));
    expect(update).toHaveBeenLastCalledWith(
      { kind: "ordering", sequence: ["it-3"] },
      undefined,
    );
  });

  it("上移/下移跳过固定行；disabled 时无操作按钮", async () => {
    const update = vi.fn();
    // 板 [甲, 丙, 乙(固定)]；it-3（第 2 位）下移 → 目标行 3 是固定行，跳过 → 无目标（禁用）
    const { unmount } = render(
      orderingView.Input({
        model: modelOf(),
        answer: { kind: "ordering", sequence: ["it-1", "it-3", "it-2"] },
        update,
      }),
    );
    expect(screen.getByRole("button", { name: "第 2 位下移" })).toBeDisabled();
    // it-3 上移 → 与第 1 位交换 → 序列 [it-3, it-1, it-2]
    fireEvent.click(screen.getByRole("button", { name: "第 2 位上移" }));
    expect(update).toHaveBeenLastCalledWith(
      { kind: "ordering", sequence: ["it-3", "it-1", "it-2"] },
      undefined,
    );
    unmount();
    // disabled 形态：不渲染操作按钮（锁定由数据流控制）
    render(
      orderingView.Input({
        model: modelOf(),
        answer: { kind: "ordering", sequence: ["it-1", "it-3", "it-2"] },
        update,
        disabled: true,
      }),
    );
    expect(screen.queryByRole("button", { name: "第 1 位移除" })).toBeNull();
  });

  it("固定项不能错移：固定行无移动按钮（UI 面口径；服务端保存校验兜底）", () => {
    render(
      orderingView.Input({
        model: modelOf(),
        answer: { kind: "ordering", sequence: ["it-1", "it-3", "it-2"] },
        update: () => {},
      }),
    );
    expect(screen.queryByRole("button", { name: "第 3 位上移" })).toBeNull();
    expect(screen.queryByRole("button", { name: "第 3 位下移" })).toBeNull();
    expect(screen.queryByRole("button", { name: "第 3 位移除" })).toBeNull();
  });

  it("结构不可用显式报错不静默降级", () => {
    render(
      orderingView.Input({
        model: modelOf({ ...baseModel, items: [] }),
        answer: undefined,
        update: () => {},
      }),
    );
    expect(screen.getByRole("alert").textContent).toContain("不完整");
  });
});

describe("ordering ReadOnly / Reference / Comparison", () => {
  it("ReadOnly：按序第 N 位呈现；未作答如实显示", () => {
    const model = modelOf();
    const { container, rerender } = render(
      orderingView.ReadOnly({ model, answer: undefined }),
    );
    expect(container.textContent).toContain("未作答");
    rerender(
      orderingView.ReadOnly({
        model,
        answer: { kind: "ordering", sequence: ["it-1", "it-3"] },
      }),
    );
    expect(container.textContent).toContain("第 1 位：甲：也就是说");
    expect(container.textContent).toContain("第 2 位：丙：不以人废言");
  });

  it("Comparison：两栏对照；参考序含固定项标注（已固定）", () => {
    const model = modelOf();
    const { container } = render(
      orderingView.Comparison({
        model,
        answer: { kind: "ordering", sequence: ["it-1"] },
        reference: {
          status: "available",
          reference: {
            kind: "ordering",
            sequence: ["it-1", "it-3", "it-2"],
          },
        },
      }),
    );
    expect(container.textContent).toContain("你的答案：");
    expect(container.textContent).toContain("参考答案：");
    expect(container.textContent).toContain("已固定");
    // 固定项 it-2 在参考第 3 位
    expect(container.textContent).toContain("第 3 位：乙：如何评价");
  });
});

describe("ordering completion", () => {
  it("完成度按已放非干扰项计（干扰项与固定项不计入应放数）", () => {
    const model = modelOf();
    // 应放 = it-1/it-3（非干扰、非固定）= 2
    expect(orderingView.completion(model, undefined, false)).toEqual({
      state: "empty",
      filledSlots: 0,
      expectedSlots: 2,
    });
    expect(
      orderingView.completion(
        model,
        { kind: "ordering", sequence: ["it-1"] },
        false,
      ),
    ).toEqual({ state: "partial", filledSlots: 1, expectedSlots: 2 });
    expect(
      orderingView.completion(
        model,
        { kind: "ordering", sequence: ["it-1", "it-3", "it-2"] },
        false,
      ),
    ).toEqual({ state: "filled", filledSlots: 2, expectedSlots: 2 });
  });
});
