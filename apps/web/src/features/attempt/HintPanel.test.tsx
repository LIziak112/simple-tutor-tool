import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HintOpenedEntry } from "@tutor/contract";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openAttemptHintApi } from "@/lib/api";
import { HintPanel } from "./HintPanel";

/**
 * 分步提示面板组件测试（T2.11）：
 * - 剩余数文案与逐条解锁流（index 从 0 递增、剩余数递减、解锁完按钮消失）；
 * - 已解锁提示常驻列表（序号 + 内容）；
 * - 加载态（pending 禁用防重复点击）与错误态（可指导文案 + 点按钮重试成功）；
 * - 受控数据流：解锁成功经 onUnlocked 上抛，由页面回写 hints。
 */

vi.mock("@/lib/api", () => ({
  openAttemptHintApi: vi.fn(),
}));

const mockedOpen = vi.mocked(openAttemptHintApi);

const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";

function hintData(index: number, overrides: Partial<{ hint: string }> = {}) {
  return {
    questionId: "练习四-8",
    index,
    hint: overrides.hint ?? `第 ${index + 1} 条提示内容`,
    hintCount: 2,
    hintsUsed: index + 1,
    hintsRemaining: 2 - (index + 1),
  };
}

/** 有状态外壳：hints 随 onUnlocked 回写（还原 AnswerView 的受控数据流） */
function renderPanel(
  hintCount: number,
  initial: readonly HintOpenedEntry[] = [],
  questionId = "练习四-8",
) {
  const onUnlocked = vi.fn();
  function Harness() {
    const [hints, setHints] = useState<readonly HintOpenedEntry[]>(initial);
    return (
      <HintPanel
        attemptId={ATTEMPT_ID}
        questionId={questionId}
        hintCount={hintCount}
        hints={hints}
        onUnlocked={(entry) => {
          onUnlocked(entry);
          setHints((prev) => [...prev, entry]);
        }}
      />
    );
  }
  const utils = render(<Harness />);
  return { ...utils, onUnlocked };
}

beforeEach(() => {
  mockedOpen.mockReset();
});

describe("HintPanel：渲染与文案", () => {
  it("hintCount>0 且未解锁：显示「给我一点提示（剩余 n 条）」按钮，无提示列表", () => {
    renderPanel(2);
    expect(
      screen.getByRole("button", { name: "给我一点提示（剩余 2 条）" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/提示 1/)).toBeNull();
  });

  it("初值含已解锁条目（草稿视图回显）：列表常驻展示序号与内容", () => {
    renderPanel(2, [{ index: 0, text: "先回顾异号两数相加的法则。" }]);
    expect(screen.getByText("提示 1")).toBeInTheDocument();
    expect(screen.getByText(/先回顾异号两数相加的法则/)).toBeInTheDocument();
    // 剩余数按 hintCount - 已解锁数 计算
    expect(
      screen.getByRole("button", { name: "给我一点提示（剩余 1 条）" }),
    ).toBeInTheDocument();
  });
});

describe("HintPanel：解锁流", () => {
  it("点击请求 index=已解锁数；成功后上抛条目、剩余数递减；全部解锁后按钮消失", async () => {
    const { onUnlocked } = renderPanel(2);
    mockedOpen.mockResolvedValueOnce(hintData(0));

    fireEvent.click(
      screen.getByRole("button", { name: "给我一点提示（剩余 2 条）" }),
    );
    await waitFor(() => {
      expect(mockedOpen).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-8", 0);
    });
    await waitFor(() => {
      expect(onUnlocked).toHaveBeenCalledWith({
        index: 0,
        text: "第 1 条提示内容",
      });
    });
    expect(screen.getByText("提示 1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "给我一点提示（剩余 1 条）" }),
    ).toBeInTheDocument();

    // 第二次点击 → index=1；解锁完按钮消失，只留列表
    mockedOpen.mockResolvedValueOnce(
      hintData(1, { hint: "第二条：逐项检查。" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "给我一点提示（剩余 1 条）" }),
    );
    await waitFor(() => {
      expect(mockedOpen).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-8", 1);
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /给我一点提示/ })).toBeNull();
    });
    expect(screen.getByText("提示 2")).toBeInTheDocument();
    expect(screen.getByText(/逐项检查/)).toBeInTheDocument();
    // 请求期间按钮禁用（防重复点击）：pending 断言见下
    expect(mockedOpen).toHaveBeenCalledTimes(2);
  });

  it("加载中：按钮禁用且文案变为「正在获取提示…」", async () => {
    let resolveApi: (value: ReturnType<typeof hintData>) => void = () => {};
    mockedOpen.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveApi = resolve;
      }),
    );
    renderPanel(1);
    const button = screen.getByRole("button", {
      name: "给我一点提示（剩余 1 条）",
    });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByText("正在获取提示…")).toBeInTheDocument();
    resolveApi(hintData(0));
    await waitFor(() => {
      expect(screen.queryByText("正在获取提示…")).toBeNull();
    });
  });

  it("失败：显示可指导错误文案；点按钮重试成功", async () => {
    renderPanel(1);
    mockedOpen.mockRejectedValueOnce(new Error("网络开小差了"));
    const button = screen.getByRole("button", {
      name: "给我一点提示（剩余 1 条）",
    });
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "网络开小差了，点按钮重试",
      );
    });
    // 重试成功：错误消失、提示展示
    mockedOpen.mockResolvedValueOnce(hintData(0));
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect(screen.getByText("提示 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /给我一点提示/ })).toBeNull();
  });
});
