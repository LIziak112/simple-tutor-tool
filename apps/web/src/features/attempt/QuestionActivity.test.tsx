import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  formatActivitySec,
  QuestionActivityBadge,
  questionActivityLabel,
  ResultActivityLine,
} from "./QuestionActivity";

describe("题内活动用时呈现（口径 v1）", () => {
  it("formatActivitySec：秒 / 分秒 / 整分", () => {
    expect(formatActivitySec(0)).toBe("0 秒");
    expect(formatActivitySec(45)).toBe("45 秒");
    expect(formatActivitySec(90)).toBe("1 分 30 秒");
    expect(formatActivitySec(600)).toBe("10 分钟");
  });

  it("题级文案四态：活动 / 只看过 / 看到过无记录 / 无可用记录", () => {
    expect(
      questionActivityLabel({
        activeSec: 95,
        observedSec: 10,
        actions: 3,
        viewed: true,
      }),
    ).toBe("活动用时 1 分 35 秒");
    expect(
      questionActivityLabel({
        activeSec: 0,
        observedSec: 20,
        actions: 0,
        viewed: true,
      }),
    ).toBe("看过 20 秒（无作答动作）");
    expect(
      questionActivityLabel({
        activeSec: 0,
        observedSec: 0,
        actions: 0,
        viewed: true,
      }),
    ).toBe("看到过，无作答记录");
    expect(
      questionActivityLabel({
        activeSec: 0,
        observedSec: 0,
        actions: 0,
        viewed: false,
      }),
    ).toBe("无可用记录");
    expect(questionActivityLabel(undefined)).toBe("无可用记录");
  });

  it("题级徽标渲染文案并带口径提示", () => {
    render(
      <QuestionActivityBadge
        activity={{ activeSec: 61, observedSec: 0, actions: 1, viewed: true }}
      />,
    );
    const badge = screen.getByText("活动用时 1 分 1 秒");
    expect(badge.getAttribute("title")).toContain("口径 v1");
  });

  it("卷级一行：合计 / 只看过 / 未归属（多端）；无事件卷标无可用记录", () => {
    const { rerender } = render(
      <ResultActivityLine
        activity={{
          version: 1,
          byQuestion: {},
          activeSecTotal: 300,
          observedSecTotal: 40,
          unattributedSec: 25,
          sessions: 2,
        }}
      />,
    );
    expect(screen.getByTestId("result-activity").textContent).toBe(
      "题内活动合计 5 分钟 · 只看过 40 秒 · 未归属 25 秒（2 端同开）（口径 v1）",
    );
    rerender(
      <ResultActivityLine
        activity={{
          version: 1,
          byQuestion: {},
          activeSecTotal: 120,
          observedSecTotal: 0,
          unattributedSec: 0,
          sessions: 1,
        }}
      />,
    );
    expect(screen.getByTestId("result-activity").textContent).toBe(
      "题内活动合计 2 分钟（口径 v1）",
    );
    rerender(<ResultActivityLine activity={undefined} />);
    expect(screen.getByTestId("result-activity").textContent).toBe(
      "题内活动用时：无可用记录",
    );
  });
});
