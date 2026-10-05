import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LintIssue } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorPanel } from "./ErrorPanel";
import { buildFixPrompt } from "./error-prompt";

/**
 * "复制错误给 AI"面板组件测试（T1.11 验收项；T2A.3 按 D21 更新接线）：
 * - 面板渲染错误列表（行号/code/消息/建议）；
 * - 点击复制：navigator.clipboard.writeText 收到的提示词 = buildFixPrompt 输出
 *   （路径 + 错误列表 + ±3 行片段，不附全文）；
 * - 剪贴板不可用时降级为弹层（textarea 内容即完整提示词，可全选）；
 * - 复制成功显示轻提示。
 */

const ISSUES: LintIssue[] = [
  {
    level: "error",
    line: 6,
    column: 1,
    code: "FILL_NO_BLANK",
    message: "填空题题干没有任何 [[…]] 空",
    fix: "在题干中用 [[答案]] 标记空位",
  },
  {
    level: "warning",
    line: 9,
    column: 3,
    code: "UNKNOWN_DIRECTIVE",
    message: "未注册的指令「:::tipl」",
  },
];

const MD =
  "---\nkind: practice\n---\n\n::::question{type=fill}\n计算：1+1=2。\n::::";

interface WriteTextMock {
  writeText: ReturnType<typeof vi.fn>;
}

function mountClipboard(): WriteTextMock {
  const mock: WriteTextMock = {
    writeText: vi.fn().mockResolvedValue(undefined),
  };
  Object.defineProperty(navigator, "clipboard", {
    value: mock,
    configurable: true,
    writable: true,
  });
  return mock;
}

function removeClipboard(): void {
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

describe("ErrorPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    removeClipboard();
  });

  it("渲染问题列表：计数、行号、code、消息与建议", () => {
    mountClipboard();
    render(<ErrorPanel path="练习四.md" markdown={MD} issues={ISSUES} />);
    expect(
      screen.getByRole("region", { name: /发现 2 个问题（1 错误 \/ 1 警告）/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("第 6 行")).toBeInTheDocument();
    expect(screen.getByText("FILL_NO_BLANK")).toBeInTheDocument();
    expect(screen.getByText("填空题题干没有任何 [[…]] 空")).toBeInTheDocument();
    expect(
      screen.getByText("建议：在题干中用 [[答案]] 标记空位"),
    ).toBeInTheDocument();
  });

  it("点击复制：剪贴板收到 buildFixPrompt 输出（路径 + 错误行 + 片段，不含无关全文），并显示轻提示", async () => {
    const mock = mountClipboard();
    render(<ErrorPanel path="练习四.md" markdown={MD} issues={ISSUES} />);
    fireEvent.click(screen.getByRole("button", { name: "复制错误给 AI" }));

    await waitFor(() => expect(mock.writeText).toHaveBeenCalledTimes(1));
    const prompt = mock.writeText.mock.calls[0]?.[0] as string;
    // 提示词 = buildFixPrompt 的输出（该函数另有专项测试，这里验证接线正确）
    expect(prompt).toBe(
      buildFixPrompt([{ path: "练习四.md", markdown: MD, issues: ISSUES }]),
    );
    // 关键内容抽查：路径、错误行与片段在；不附全文（远离错误行的结尾行不出现）
    expect(prompt).toContain("练习四.md");
    expect(prompt).toContain("第6行");
    expect(prompt).toContain("[FILL_NO_BLANK]");
    expect(prompt).not.toContain(MD);
    expect(await screen.findByText(/已复制提示词/)).toBeInTheDocument();
  });

  it("剪贴板不可用：降级弹层展示完整提示词，可全选、可关闭", async () => {
    removeClipboard();
    render(<ErrorPanel path="练习四.md" markdown={MD} issues={ISSUES} />);
    fireEvent.click(screen.getByRole("button", { name: "复制错误给 AI" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    const textarea = screen.getByLabelText("提示词全文") as HTMLTextAreaElement;
    expect(textarea.value).toBe(
      buildFixPrompt([{ path: "练习四.md", markdown: MD, issues: ISSUES }]),
    );

    // 全选按钮聚焦并选中全文
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(textarea.value.length);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("剪贴板写入被拒绝：同样降级弹层", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    render(<ErrorPanel path="练习四.md" markdown={MD} issues={ISSUES} />);
    fireEvent.click(screen.getByRole("button", { name: "复制错误给 AI" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
