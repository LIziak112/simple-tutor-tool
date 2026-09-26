import { describe, expect, it } from "vitest";
import { scanUnclosedContainers } from "./fences";

/**
 * 未闭合容器扫描：逐行冒号栈扫描，语义对齐 micromark-extension-directive 的真实围栏规则
 * （外层容器扫描到「冒号数 ≥ 自身开栏数」的裸围栏即闭合，嵌套容器在父内容结束时隐式闭合；
 * 等价栈语义：裸围栏 N 弹出「自栈底起第一个冒号数 ≤ N 的条目」及其上方全部）。
 */

describe("scanUnclosedContainers", () => {
  it("EOF 仍未闭合：报开栏行", () => {
    expect(scanUnclosedContainers([':::tip{title="a"}', "内容"])).toEqual([
      { name: "tip", colons: 3, line: 1 },
    ]);
  });

  it("嵌套双未闭合：按开栏行各报一条", () => {
    expect(scanUnclosedContainers([":::warning", "a", ":::tip", "b"])).toEqual([
      { name: "warning", colons: 3, line: 1 },
      { name: "tip", colons: 3, line: 3 },
    ]);
  });

  it("正常开闭不报", () => {
    expect(
      scanUnclosedContainers([
        "::::question{type=judge}",
        ":::hint",
        "提示",
        ":::",
        "题干。[[正确]]",
        "::::",
      ]),
    ).toEqual([]);
  });

  it("闭合围栏弹出所有开栏冒号数 ≤ N 的容器（浅容器(4)+深容器(3)，:::: 全闭合）", () => {
    expect(
      scanUnclosedContainers(["::::a", ":::b", "x", "::::", "after"]),
    ).toEqual([]);
  });

  it("等冒号嵌套 :::a > :::b，::: 把两者一起闭合", () => {
    expect(
      scanUnclosedContainers([":::a", ":::b", "x", ":::", "after"]),
    ).toEqual([]);
  });

  it("::: 只闭合深容器(3)，浅容器(4)留到 EOF 才算未闭合", () => {
    expect(
      scanUnclosedContainers(["::::a", ":::b", "B", ":::", "尾部内容"]),
    ).toEqual([{ name: "a", colons: 4, line: 1 }]);
  });

  it("多冒号裸围栏能闭合更浅的容器（::::: 清空整栈）", () => {
    expect(
      scanUnclosedContainers([":::a", "::::b", "x", ":::::", "z"]),
    ).toEqual([]);
  });

  it("代码块围栏内的 ::: 不参与配对", () => {
    expect(
      scanUnclosedContainers([
        "```",
        ":::tip",
        "```",
        ':::fold{title="a"}',
        "x",
        ":::",
      ]),
    ).toEqual([]);
  });

  it("$$ 数学块内的 ::: 不参与配对；单行 $$…$$ 自闭合", () => {
    expect(
      scanUnclosedContainers(["$$", ":::tip", "$$", ':::fold{title="a"}', "x"]),
    ).toEqual([{ name: "fold", colons: 3, line: 4 }]);
    expect(scanUnclosedContainers(["$$x$$", ":::tip", "x", ":::"])).toEqual([]);
  });

  it("frontmatter 围栏跳过，不当作容器", () => {
    expect(
      scanUnclosedContainers([
        "---",
        "kind: practice",
        "---",
        ':::tip{title="a"}',
        "x",
        ":::",
      ]),
    ).toEqual([]);
  });

  it("块指令（::name[…]{…}）不是容器，不进栈", () => {
    expect(scanUnclosedContainers(['::graph{fn="x^2"}'])).toEqual([]);
  });

  it("容器名带 [label] 的开栏也能识别", () => {
    expect(scanUnclosedContainers([":::note[label]", "x", ":::"])).toEqual([]);
  });
});
