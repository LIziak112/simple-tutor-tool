import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RichMarkdown } from "../RichMarkdown";
import type { DirectiveTelemetryInfo } from "./expand-context";

/**
 * 指令遥测上下文测试（T4.0b，方案 §4.3.3 / §5.0-C11）：
 * - 折叠开/合双向上报（open/close），payload 用文档全局指令序号 docIndex；
 * - steps 容器「显示下一步」报 reveal：{name:"steps", index: 容器 docIndex,
 *   step: 容器内步序号}——两套编号分清（§5.0-B8）；
 * - 行内指令（mark/blank）不占全局序号；
 * - onDirectiveExpand 兼容别名只收 open 方向；
 * - 不提供回调时（教师端预览）行为零变化（点击照常、不崩溃）。
 */

/** 两个 fold + 一个 steps（两步）+ 一个 solution + 行内 mark 的讲义片段 */
const DOC = [
  "# 第1讲 遥测",
  "",
  "## 第一节",
  "",
  ':::fold{title="甲"}',
  "内容甲",
  ":::",
  "",
  ':::fold{title="乙"}',
  "内容乙",
  ":::",
  "",
  "::::steps",
  ':::step{title="第 1 步"}',
  "第一步",
  ":::",
  ':::step{title="第 2 步"}',
  "第二步",
  ":::",
  ':::step{title="第 3 步"}',
  "第三步",
  ":::",
  "::::",
  "",
  ":::solution",
  "详解内容",
  ":::",
  "",
  '一行 :mark[标记]{color="yellow"} 文字',
].join("\n");

describe("DirectiveTelemetryContext（T4.0b）", () => {
  it("fold 开/合双向上报，index 为文档全局指令序号（两个 fold 序号不同）", () => {
    const events: DirectiveTelemetryInfo[] = [];
    render(
      <RichMarkdown
        source={DOC}
        onDirectiveTelemetry={(event) => events.push(event)}
      />,
    );
    // 第一个 fold（标题「甲」）：展开 → 收起
    fireEvent.click(screen.getByRole("button", { name: "甲" }));
    fireEvent.click(screen.getByRole("button", { name: "甲" }));
    // 第二个 fold（标题「乙」）：展开
    fireEvent.click(screen.getByRole("button", { name: "乙" }));
    expect(events).toEqual([
      { name: "fold", index: 1, action: "open" },
      { name: "fold", index: 1, action: "close" },
      { name: "fold", index: 2, action: "open" },
    ]);
  });

  it("steps 揭晓报 reveal：index=容器 docIndex、step=容器内步序号（两套编号分清）", () => {
    const events: DirectiveTelemetryInfo[] = [];
    render(
      <RichMarkdown
        source={DOC}
        onDirectiveTelemetry={(event) => events.push(event)}
      />,
    );
    const next = screen.getByRole("button", { name: /显示下一步/ });
    fireEvent.click(next); // 揭晓第 2 步
    fireEvent.click(next); // 揭晓第 3 步
    // 全局序号：fold=1、fold=2、steps 容器=3、step 指令自身=4/5/6、solution=7
    // （mark 是行内指令不计数）——reveal 用容器自己的 3，不是 step 的全局序号
    expect(events).toEqual([
      { name: "steps", index: 3, step: 2, action: "reveal" },
      { name: "steps", index: 3, step: 3, action: "reveal" },
    ]);
  });

  it("solution 折叠同样开/合双向上报（全局序号排在行内 mark 之外）", () => {
    const events: DirectiveTelemetryInfo[] = [];
    render(
      <RichMarkdown
        source={DOC}
        onDirectiveTelemetry={(event) => events.push(event)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "详解" }));
    expect(events).toEqual([
      // 7 = fold(1) fold(2) steps(3) step(4) step(5) step(6) 之后
      { name: "solution", index: 7, action: "open" },
    ]);
  });

  it("onDirectiveExpand 兼容别名：仅 open 方向触发、映射到遥测回调", () => {
    const seen: Array<{ name: string; index: number }> = [];
    render(
      <RichMarkdown
        source={DOC}
        onDirectiveExpand={(info) => seen.push(info)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "甲" }));
    fireEvent.click(screen.getByRole("button", { name: "甲" })); // close 不进旧回调
    fireEvent.click(screen.getByRole("button", { name: /显示下一步/ })); // reveal 不进旧回调
    expect(seen).toEqual([{ name: "fold", index: 1 }]);
  });

  it("不提供回调时点击照常、不崩溃（教师端预览零变化）", () => {
    render(<RichMarkdown source={DOC} />);
    fireEvent.click(screen.getByRole("button", { name: "甲" }));
    fireEvent.click(screen.getByRole("button", { name: /显示下一步/ }));
    expect(screen.getByText("第二步")).toBeTruthy();
  });
});
