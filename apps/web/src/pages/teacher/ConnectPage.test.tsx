import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchApiToken, fetchPublicConfig, resetApiToken } from "@/lib/api";
import ConnectPage from "./ConnectPage";

/**
 * /t/connect「连接 AI」页组件测试（T4.7 D26）：
 * - 三步结构：Token（未生成可就地生成 / 已生成明文 + 复制）、MCP 地址
 *   （PUBLIC_URL + /mcp）、配置示例（通用 + Claude Desktop，均代入真实
 *   地址与 token）；
 * - token 未生成时配置片段用占位符并提示先生成；
 * - 一键复制（地址 / 配置 JSON，clipboard mock 断言写入内容）；
 * - 配置加载 / token 加载三态。
 * API 层 mock（服务端流转由路由测试覆盖；MCP 协议冒烟在 E2E）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchPublicConfig: vi.fn(),
    fetchApiToken: vi.fn(),
    resetApiToken: vi.fn(),
  };
});

const mockedConfig = vi.mocked(fetchPublicConfig);
const mockedFetchToken = vi.mocked(fetchApiToken);
const mockedReset = vi.mocked(resetApiToken);

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ConnectPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 真实 URL 下预期的 mcpServers JSON 片段（页面生成逻辑的期望输出） */
function expectedConfig(serverUrl: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        tutor: {
          type: "http",
          url: serverUrl,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedConfig.mockResolvedValue({
    pwaEnabled: false,
    publicUrl: "http://192.168.1.10:8787",
  });
  mockedFetchToken.mockResolvedValue({ token: null });
});

describe("ConnectPage（T4.7 D26）", () => {
  it("没有凭据时复制明确标注为示例，生成凭据不能冒充已连接", async () => {
    renderPage();
    const copy = await screen.findByRole("button", {
      name: "复制通用 MCP 配置 JSON",
    });
    expect(copy).toHaveTextContent("复制示例");
    expect(screen.getByText("尚未生成凭据")).toBeVisible();
    expect(screen.queryByText("已连接 AI")).toBeNull();
  });
  it("客户端切换只保留一份配置，并提供对应说明", async () => {
    renderPage();
    await screen.findByRole("button", { name: "复制通用 MCP 配置 JSON" });
    fireEvent.click(screen.getByRole("radio", { name: "Claude Desktop" }));
    expect(
      screen.getByRole("button", { name: "复制 Claude Desktop 配置 JSON" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "复制通用 MCP 配置 JSON" }),
    ).toBeNull();
    expect(screen.getAllByText(/你的API_TOKEN/)).toHaveLength(1);
  });

  it("复制失败提示手动复制", async () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error("拒绝访问")),
      },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "复制 MCP 服务器地址" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "复制失败，请选中内容手动复制",
    );
  });

  it("部署配置失败提供重试入口，而非持续加载", async () => {
    mockedConfig.mockRejectedValue(new Error("地址不可用"));
    renderPage();
    expect(
      await screen.findByRole("button", { name: "重新获取地址" }),
    ).toBeVisible();
    expect(screen.queryByText("正在获取部署地址…")).toBeNull();
  });

  it("MCP 地址 = PUBLIC_URL + /mcp，一键复制写入剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPage();

    expect(
      await screen.findByText("http://192.168.1.10:8787/mcp"),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "复制 MCP 服务器地址" }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("http://192.168.1.10:8787/mcp");
    });
  });

  it("未生成 token：提示生成 + 配置片段用占位符并注明", async () => {
    renderPage();

    expect(await screen.findByText(/尚未生成 Token。生成后/)).toBeVisible();
    // 当前配置片段含占位符
    const blocks = await screen.findAllByText(/你的API_TOKEN/);
    expect(blocks.length).toBe(1);
    expect(
      await screen.findByText(/尚未生成 Token，片段中为占位符/),
    ).toBeVisible();
  });

  it("生成 token 后：明文展示 + 一份配置 JSON 代入真实地址与 token，可复制", async () => {
    mockedReset.mockResolvedValue({ token: "t47-real-token" });
    // 调用队列：首次查询 null、invalidate 后的第二次调用给新值
    // （在 click 前排好队，避免 mock 改值晚于重取的竞态）
    mockedFetchToken
      .mockResolvedValueOnce({ token: null })
      .mockResolvedValueOnce({ token: "t47-real-token" });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPage();

    // 未生成 → 点击生成（首次生成无确认弹层）
    fireEvent.click(await screen.findByRole("button", { name: /生成 Token/ }));
    await waitFor(() => {
      expect(mockedReset).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(await screen.findByRole("button", { name: "查看凭据" }));
    // mutation onSuccess invalidate → 同 key 重取拿到新 token 并展示
    await waitFor(() => {
      expect(screen.getByText("t47-real-token")).toBeVisible();
    });

    const expected = expectedConfig(
      "http://192.168.1.10:8787/mcp",
      "t47-real-token",
    );
    // 当前配置块代入真实地址与凭据
    const blocks = screen.getAllByText(
      (_, element) => element?.textContent === expected,
    );
    expect(blocks.length).toBe(1);

    fireEvent.click(
      screen.getByRole("button", { name: "复制通用 MCP 配置 JSON" }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expected);
    });
  });

  it("已生成 token（直接查询返回）：无占位符，配置直接可用", async () => {
    mockedFetchToken.mockResolvedValue({ token: "existing-token-xyz" });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "查看凭据" }));
    expect(await screen.findByText("existing-token-xyz")).toBeVisible();
    expect(screen.queryByText(/你的API_TOKEN/)).toBeNull();
    expect(
      screen.getAllByText(/"Authorization": "Bearer existing-token-xyz"/)
        .length,
    ).toBe(1);
  });

  it("token 加载失败显示错误文案", async () => {
    mockedFetchToken.mockRejectedValue(new Error("token 接口挂了"));
    renderPage();
    expect(await screen.findByText("token 接口挂了")).toBeVisible();
  });

  it("部署配置加载中不渲染地址（加载态）", () => {
    mockedConfig.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("正在获取部署地址…")).toBeVisible();
    expect(screen.queryByText(/\/mcp$/)).toBeNull();
  });
});
