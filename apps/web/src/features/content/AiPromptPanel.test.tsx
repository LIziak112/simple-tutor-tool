import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSpecFile } from "@/lib/api";
import { AiPromptPanel } from "./AiPromptPanel";

/**
 * "AI 出题助手"面板组件测试（T1.13 验收项）：
 * - 默认收起不发请求，展开后经 /api/public/spec 拉取三份文档；
 * - 复制按钮把拼装提示词写入 navigator.clipboard（开头角色/主题、三段全文、结尾输出要求）；
 * - kind 切换与空主题回退「教师自定」；
 * - 剪贴板不可用时降级为手动复制文本框；
 * - 加载失败显示中文原因 + 重试后恢复。
 * fetchSpecFile 打桩（真实接口链路在 spec.test.ts / 自验脚本覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSpecFile: vi.fn(),
  };
});

const mockedFetchSpecFile = vi.mocked(fetchSpecFile);

const RULES = "# 内容 DSL v2 规范（测试）\n\n## 指令清单\n| 指令 | 用途 |\n";
const EXAMPLE =
  "# 完整样例（测试）\n\n```markdown\n::::question{type=judge}\n判断。\n::::\n```\n";
const TEMPLATE = "# 出题提示词模板（测试）\n\n- {{学科/年级}}";

/** 控制打桩行为：fail 时抛错（模拟后端未启动），成功时按文件返回夹具 */
let shouldFail = false;
beforeEach(() => {
  shouldFail = false;
  mockedFetchSpecFile.mockImplementation(async (file) => {
    if (shouldFail) {
      throw new Error("连不上服务器，请确认后端已启动后重试");
    }
    if (file === "rules.md") return RULES;
    if (file === "example.md") return EXAMPLE;
    return TEMPLATE;
  });
  mountClipboard();
});

interface WriteTextMock {
  writeText: ReturnType<typeof vi.fn>;
}

function mountClipboard(resolve = true): WriteTextMock {
  const mock: WriteTextMock = {
    writeText: resolve
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error("denied")),
  };
  Object.defineProperty(navigator, "clipboard", {
    value: mock,
    configurable: true,
    writable: true,
  });
  return mock;
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <AiPromptPanel />
    </QueryClientProvider>,
  );
}

/** 展开面板并等三份文档就绪（复制按钮变为可用） */
async function openAndWait(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /AI 出题助手/ }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: /一键复制给 AI/ })).toBeEnabled();
  });
}

describe("AiPromptPanel（T1.13 AI 出题助手）", () => {
  it("默认收起且不发请求；展开后加载三份规范文档", async () => {
    renderPanel();
    expect(mockedFetchSpecFile).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "练习" }),
    ).not.toBeInTheDocument();

    await openAndWait();

    expect(mockedFetchSpecFile).toHaveBeenCalledTimes(3);
    expect(mockedFetchSpecFile).toHaveBeenCalledWith("rules.md");
    expect(mockedFetchSpecFile).toHaveBeenCalledWith("example.md");
    expect(mockedFetchSpecFile).toHaveBeenCalledWith("prompt.md");
  });

  it("复制按钮写入剪贴板：开头角色+主题、三段全文、结尾输出要求齐全", async () => {
    const clipboard = mountClipboard();
    renderPanel();
    await openAndWait();

    fireEvent.change(screen.getByLabelText("主题 / 考点（可选）"), {
      target: { value: "一元一次方程" },
    });
    fireEvent.click(screen.getByRole("button", { name: "练习" }));
    fireEvent.click(screen.getByRole("button", { name: /一键复制给 AI/ }));

    await waitFor(() => {
      expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    });
    const prompt = clipboard.writeText.mock.calls[0]?.[0] ?? "";
    expect(prompt.startsWith("你是一对一辅导老师的内容助手")).toBe(true);
    expect(prompt).toContain("生成一份练习");
    expect(prompt).toContain("主题：一元一次方程");
    expect(prompt).toContain(RULES.trim());
    expect(prompt).toContain(EXAMPLE.trim());
    expect(prompt).toContain(TEMPLATE.trim());
    expect(prompt).toContain("## 出题提示词模板");
    expect(prompt.slice(-120)).toContain("输出一个 markdown 代码块");
    expect(screen.getByText("已复制，粘贴给你的 AI 即可。")).toBeInTheDocument();
  });

  it("切换 kind 到「混合」并留空主题：开头随之变化、主题回退「教师自定」", async () => {
    const clipboard = mountClipboard();
    renderPanel();
    await openAndWait();

    fireEvent.click(screen.getByRole("button", { name: "混合" }));
    fireEvent.click(screen.getByRole("button", { name: /一键复制给 AI/ }));

    await waitFor(() => {
      expect(clipboard.writeText).toHaveBeenCalled();
    });
    const prompt = clipboard.writeText.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("生成一份混合");
    expect(prompt).toContain("主题：教师自定");
  });

  it("剪贴板不可用时降级为手动复制文本框（内容即完整提示词）", async () => {
    mountClipboard(false);
    renderPanel();
    await openAndWait();

    fireEvent.click(screen.getByRole("button", { name: /一键复制给 AI/ }));

    const textarea = await screen.findByLabelText("提示词全文");
    const value = (textarea as HTMLTextAreaElement).value;
    expect(value).toContain("你是一对一辅导老师的内容助手");
    expect(value).toContain(RULES.trim());
    expect(
      screen.getByText(/当前环境不允许直接写剪贴板/),
    ).toBeInTheDocument();
  });

  it("加载失败显示中文原因与重试；重试成功后恢复可用", async () => {
    shouldFail = true;
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /AI 出题助手/ }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "规范文档加载失败：连不上服务器",
      );
    });
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();

    shouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /一键复制给 AI/ })).toBeEnabled();
    });
  });
});
