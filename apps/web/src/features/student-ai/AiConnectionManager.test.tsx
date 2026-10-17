import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  type AiConnectionListData,
  aiConnectionPatchRequestSchema,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createStudentAiConnectionApi,
  fetchStudentAiConnectionsApi,
  patchStudentAiConnectionApi,
  testStudentAiConnectionApi,
} from "@/lib/api";
import { copyText } from "@/lib/copy";
import { AiConnectionManager } from "./AiConnectionManager";

/**
 * SAI-18 学生连接设置管理组件测试(B09「先测」5 条的组件层):
 * - 新账号默认未连接,知情确认默认不勾选、不默认同意向任何目的地发送;
 * - 首次设置失败 / 测试失败保留输入与可操作错误;Key 字段只显示安全状态
 *   (输入 type=password、列表只回指纹,永不回显旧明文);
 * - 后台 refetch 不覆盖脏编辑;409 同通道冲突不吞改动;换账号缓存立即隔离
 *   (查询键挂 ["student"],登出 removeQueries 一并带走);
 * - 配置成功且带来源题时提供「返回原题」入口,绝不自动发半成品任务;
 *   有未保存编辑时普通导航离开先确认,取消留在页面;
 * - MCP Token 持续展示：复制成功 / 失败都有真实反馈，失败可手动复制，
 *   不虚报成功。
 * API 层 mock;真实路由往返(get/save/test 落库)见
 * ai-connection-route-integration.test.tsx。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentAiConnectionsApi: vi.fn(),
    createStudentAiConnectionApi: vi.fn(),
    patchStudentAiConnectionApi: vi.fn(),
    testStudentAiConnectionApi: vi.fn(),
  };
});

vi.mock("@/lib/copy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copy")>();
  return { ...actual, copyText: vi.fn() };
});

const mockedFetch = vi.mocked(fetchStudentAiConnectionsApi);
const mockedCreate = vi.mocked(createStudentAiConnectionApi);
const mockedPatch = vi.mocked(patchStudentAiConnectionApi);
const mockedTest = vi.mocked(testStudentAiConnectionApi);
const mockedCopy = vi.mocked(copyText);

/** 已配置的页内连接(未验证) */
const INAPP_UNVERIFIED = {
  id: "11111111-1111-4111-8111-111111111111",
  channel: "inapp" as const,
  baseUrl: "https://api.example.com/v1",
  model: "glm-4",
  keyFingerprint: "ab12cd34",
  imageCapability: "unknown" as const,
  isDefault: true,
  verifyStatus: "unverified" as const,
  verifiedAt: null,
  createdAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:00:00.000Z",
};

function listData(
  connections: AiConnectionListData["connections"],
): AiConnectionListData {
  return { connections };
}

function renderManager(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
  options: { from?: string } = {},
) {
  const search =
    options.from === undefined
      ? ""
      : `?from=${encodeURIComponent(options.from)}`;
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/s/settings/ai${search}`]}>
        {/* 路由表还原真实挂载:「返回设置」的导航拦截按路由变化断言 */}
        <Routes>
          <Route path="/s/settings/ai" element={<AiConnectionManager />} />
          <Route path="/s/settings" element={<p>设置主页占位</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, ...view };
}

/** 填写页内(inapp)新建表单(知情确认按需勾选) */
function fillInappForm(values?: Partial<Record<string, string>>): void {
  fireEvent.change(screen.getByLabelText("接口地址"), {
    target: { value: values?.baseUrl ?? "https://api.example.com/v1" },
  });
  fireEvent.change(screen.getByLabelText("模型名称"), {
    target: { value: values?.model ?? "glm-4" },
  });
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: values?.apiKey ?? "sk-plain-test-key" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue(listData([]));
  mockedCopy.mockResolvedValue(true);
});

describe("AiConnectionManager(SAI-18 学生连接设置)", () => {
  describe("连接信息结构", () => {
    it("总览只呈现已保存连接，新增与查看分别进入独立视图", async () => {
      mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED]));
      renderManager();
      await screen.findByText(/api\.example\.com/u);
      expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "保存连接" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "新增连接" }));
      expect(
        screen.getByRole("heading", { name: "新增连接" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("region", { name: "我的连接" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "页内 AI" })).toBeDisabled();
      expect(screen.getByRole("radio", { name: "MCP 工具" })).toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: "取消新增" }));
      fireEvent.click(screen.getByRole("button", { name: "查看配置" }));
      expect(
        screen.getByRole("heading", { name: "页内 AI 配置" }),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    });

    it("取消编辑有未保存确认，取消放弃时保留输入", async () => {
      mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED]));
      renderManager();
      fireEvent.click(await screen.findByRole("button", { name: "修改配置" }));
      fireEvent.change(screen.getByLabelText("模型名称"), {
        target: { value: "未保存模型" },
      });
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      fireEvent.click(screen.getByRole("button", { name: "取消修改" }));
      expect(screen.getByLabelText("模型名称")).toHaveValue("未保存模型");
      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "取消修改" }));
      expect(
        screen.getByRole("region", { name: "我的连接" }),
      ).toBeInTheDocument();
      expect(mockedPatch).not.toHaveBeenCalled();
      confirm.mockRestore();
    });

    it("读取失败只展示恢复入口，不展示新建表单", async () => {
      mockedFetch.mockRejectedValue(new Error("网络中断"));
      renderManager();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "无法加载连接",
      );
      expect(
        screen.getByRole("button", { name: "重新加载" }),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "新增连接" }),
      ).not.toBeInTheDocument();
    });
  });
  const mcp = (token: string | null = "mcp-token-current") => ({
    id: "44444444-4444-4444-8444-444444444444",
    channel: "mcp" as const,
    tokenFingerprint: "mcp12345",
    token,
    isDefault: false,
    verifyStatus: "unverified" as const,
    verifiedAt: null,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
  });
  async function createView() {
    fireEvent.click(await screen.findByRole("button", { name: "新增连接" }));
  }
  async function detailView() {
    fireEvent.click(await screen.findByRole("button", { name: "查看配置" }));
  }

  it("新账号总览为空，进入新增后才展示首次知情说明且默认不勾选", async () => {
    renderManager();
    await screen.findByText(/尚未配置 AI 连接/u);
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    await createView();
    expect(screen.getByText(/发送到你配置的 AI 服务/u)).toBeInTheDocument();
    expect(screen.getByText(/答案解析/u)).toBeInTheDocument();
    expect(screen.getByText(/姓名/u)).toBeInTheDocument();
    expect(screen.getAllByText(/费用/u).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
    ).not.toBeChecked();
    fillInappForm();
    expect(screen.getByRole("button", { name: "保存连接" })).toBeDisabled();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("已有连接修改无需再次知情，API Key 不回显且保持 password 输入", async () => {
    mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED]));
    renderManager();
    await detailView();
    expect(screen.getByText(/ab12cd34/u)).toBeInTheDocument();
    expect(screen.queryByText(/sk-/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "修改配置" }));
    expect(screen.getByLabelText("API Key")).toHaveAttribute(
      "type",
      "password",
    );
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(
      screen.queryByRole("checkbox", { name: "我已了解数据外发说明" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存连接" })).toBeEnabled();
  });

  it.each([
    ["AI_CONNECTION_INVALID", "接口地址不可达，请检查后重试", 400],
    ["AI_STATE_CONFLICT", "已配置同类连接，请先删除或修改", 409],
  ] as const)(
    "保存失败 %s 保留所有输入与确认",
    async (code, message, status) => {
      renderManager();
      await createView();
      fireEvent.click(
        screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
      );
      fillInappForm();
      mockedCreate.mockRejectedValue(new ApiError(code, message, status));
      fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(screen.getByLabelText("接口地址")).toHaveValue(
        "https://api.example.com/v1",
      );
      expect(screen.getByLabelText("模型名称")).toHaveValue("glm-4");
      expect(screen.getByLabelText("API Key")).toHaveValue("sk-plain-test-key");
      expect(
        screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
      ).toBeChecked();
    },
  );

  it("测试失败展示可恢复错误，连接仍在详情中", async () => {
    mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED]));
    renderManager();
    await detailView();
    mockedTest.mockRejectedValue(
      new ApiError(
        "AI_OUTBOUND_FAILED",
        "无法连接到 AI 服务，请检查网络后重试",
        502,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法连接到 AI 服务",
    );
    expect(screen.getByText(/api\.example\.com/u)).toBeInTheDocument();
  });

  it("总览区分测试状态，MCP 保存不表示已连接", async () => {
    mockedFetch.mockResolvedValue(
      listData([
        INAPP_UNVERIFIED,
        {
          ...INAPP_UNVERIFIED,
          id: "verified",
          isDefault: false,
          verifyStatus: "verified",
        },
        {
          ...INAPP_UNVERIFIED,
          id: "rekey",
          isDefault: false,
          verifyStatus: "needs_rekey",
        },
        mcp(),
      ]),
    );
    renderManager();
    await screen.findByText("已保存,未测试");
    expect(screen.getByText("验证成功")).toBeInTheDocument();
    expect(screen.getByText("需重新填写 Key")).toBeInTheDocument();
    expect(screen.getByText("配置已保存")).toBeInTheDocument();
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
  });

  it("后台重取不覆盖修改草稿，重挂继续修改且走 PATCH 保存", async () => {
    mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED]));
    const { client, unmount } = renderManager();
    fireEvent.click(await screen.findByRole("button", { name: "修改配置" }));
    fireEvent.change(screen.getByLabelText("模型名称"), {
      target: { value: "保留模型" },
    });
    mockedFetch.mockResolvedValue(
      listData([{ ...INAPP_UNVERIFIED, model: "后台模型" }]),
    );
    await client.invalidateQueries({ queryKey: ["student", "ai-connections"] });
    expect(screen.getByLabelText("模型名称")).toHaveValue("保留模型");
    unmount();
    renderManager(client);
    expect(
      screen.getByRole("heading", { name: "修改连接" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("模型名称")).toHaveValue("保留模型");
    mockedPatch.mockResolvedValue({
      connection: INAPP_UNVERIFIED,
      credential: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await waitFor(() => expect(mockedPatch).toHaveBeenCalledTimes(1));
    expect(mockedPatch.mock.calls[0]?.[1]).toMatchObject({ model: "保留模型" });
    expect(mockedCreate).not.toHaveBeenCalled();
    await screen.findByRole("region", { name: "我的连接" });
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
  });

  it("编辑目标被后台移除后不能退化为新建请求", async () => {
    mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED]));
    const { client } = renderManager();
    fireEvent.click(await screen.findByRole("button", { name: "修改配置" }));
    fillInappForm();
    mockedFetch.mockResolvedValue(listData([]));
    await client.invalidateQueries({ queryKey: ["student", "ai-connections"] });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "此连接已不存在",
    );
    expect(screen.getByRole("button", { name: "保存连接" })).toBeDisabled();
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedPatch).not.toHaveBeenCalled();
    expect(screen.getByLabelText("模型名称")).toHaveValue("glm-4");
  });

  it("新建草稿重挂读回，清账号缓存后草稿与编辑视图归零", async () => {
    const { client, unmount } = renderManager();
    await createView();
    fillInappForm({ baseUrl: "https://keep.example.com/v1" });
    unmount();
    const second = renderManager(client);
    expect(screen.getByLabelText("接口地址")).toHaveValue(
      "https://keep.example.com/v1",
    );
    second.unmount();
    client.removeQueries({ queryKey: ["student"] });
    renderManager(client);
    await screen.findByText(/尚未配置 AI 连接/u);
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    await createView();
    expect(screen.getByLabelText("接口地址")).toHaveValue("");
    expect(screen.getByLabelText("API Key")).toHaveValue("");
  });

  it("普通返回有未保存确认，拒绝后留在编辑状态", async () => {
    renderManager();
    await createView();
    fillInappForm();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("link", { name: "返回设置" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/尚未保存/u));
    expect(screen.getByLabelText("API Key")).toHaveValue("sk-plain-test-key");
    expect(screen.queryByText("设置主页占位")).not.toBeInTheDocument();
    confirm.mockRestore();
  });

  it.each([
    ["/s/assignments/a1?question=q1", true],
    ["//evil.example", false],
    ["https://evil.example/x", false],
  ])("保存后来源地址 %s 按学生域过滤，不自动求助", async (from, valid) => {
    renderManager(undefined, { from });
    await createView();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
    );
    fillInappForm();
    mockedCreate.mockResolvedValue({
      connection: INAPP_UNVERIFIED,
      credential: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await screen.findByText("连接已保存。");
    if (valid)
      expect(screen.getByRole("link", { name: "返回原题" })).toHaveAttribute(
        "href",
        from,
      );
    else
      expect(
        screen.queryByRole("link", { name: "返回原题" }),
      ).not.toBeInTheDocument();
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it("修改通道固定，取消后可以新增其他方式", async () => {
    mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED]));
    renderManager();
    fireEvent.click(await screen.findByRole("button", { name: "修改配置" }));
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消修改" }));
    await createView();
    expect(screen.getByRole("radio", { name: "页内 AI" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "MCP 工具" })).toBeEnabled();
  });

  it("所有方式已添加时不再展示新增入口", async () => {
    mockedFetch.mockResolvedValue(
      listData([
        INAPP_UNVERIFIED,
        mcp(),
        {
          id: "link",
          channel: "link",
          defaultValidHours: 24,
          isDefault: false,
          createdAt: INAPP_UNVERIFIED.createdAt,
          updatedAt: INAPP_UNVERIFIED.updatedAt,
        },
      ]),
    );
    renderManager();
    await screen.findByText(/三种使用方式均已添加/u);
    expect(
      screen.queryByRole("button", { name: "新增连接" }),
    ).not.toBeInTheDocument();
  });

  it("MCP 详情展示完整配置，重新进入仍可查看复制", async () => {
    mockedFetch.mockResolvedValue(listData([mcp()]));
    const first = renderManager();
    await detailView();
    expect(screen.getAllByText(/mcp-token-current/u)).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", { name: "复制完整 MCP 配置 JSON" }),
    );
    await waitFor(() =>
      expect(mockedCopy).toHaveBeenCalledWith(
        expect.stringContaining("Bearer mcp-token-current"),
      ),
    );
    first.unmount();
    renderManager();
    await detailView();
    expect(screen.getAllByText(/mcp-token-current/u)).toHaveLength(2);
    expect(screen.queryByText(/只显示这一次/u)).not.toBeInTheDocument();
  });

  it("MCP 复制失败给出手动复制恢复入口", async () => {
    mockedFetch.mockResolvedValue(listData([mcp()]));
    mockedCopy.mockResolvedValue(false);
    renderManager();
    await detailView();
    fireEvent.click(screen.getByRole("button", { name: "复制 Token" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /复制失败，请选中内容手动复制/u,
    );
    expect(screen.queryAllByText("已复制")).toHaveLength(0);
  });

  it("旧 MCP 连接不给伪造凭据，不自动重置", async () => {
    mockedFetch.mockResolvedValue(listData([mcp(null)]));
    renderManager();
    await detailView();
    expect(screen.getByText(/旧连接仍可使用/u)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "复制完整 MCP 配置 JSON" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制端点" }));
    await waitFor(() =>
      expect(mockedCopy).toHaveBeenCalledWith(
        `${window.location.origin}/mcp/student`,
      ),
    );
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it("重置确认后替换配置，不残留旧 Token", async () => {
    mockedFetch.mockResolvedValue(listData([mcp("old-token")]));
    renderManager();
    await detailView();
    mockedPatch.mockResolvedValue({
      connection: mcp("new-token"),
      credential: { token: "new-token" },
    });
    mockedFetch.mockResolvedValue(listData([mcp("new-token")]));
    fireEvent.click(screen.getByRole("button", { name: "重置 Token" }));
    expect(mockedPatch).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      /旧 Token 将立即失效/u,
    );
    fireEvent.click(screen.getByRole("button", { name: "重新生成 Token" }));
    expect(await screen.findAllByText(/new-token/u)).toHaveLength(2);
    expect(screen.queryAllByText(/old-token/u)).toHaveLength(0);
  });

  it("修改 MCP 仅发送通道允许的字段，保存回到总览后可查看凭据", async () => {
    const connection = mcp();
    mockedFetch.mockResolvedValue(listData([connection]));
    mockedPatch.mockResolvedValue({ connection, credential: null });
    renderManager();
    fireEvent.click(await screen.findByRole("button", { name: "修改配置" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "设为默认连接" }));
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await waitFor(() => expect(mockedPatch).toHaveBeenCalled());
    expect(
      aiConnectionPatchRequestSchema.safeParse(mockedPatch.mock.calls[0]?.[1])
        .success,
    ).toBe(true);
    expect(mockedPatch.mock.calls[0]?.[1]).toEqual({
      channel: "mcp",
      isDefault: true,
    });
    await detailView();
    expect(screen.getAllByText(/mcp-token-current/u)).toHaveLength(2);
  });

  it("创建 MCP 保存后回总览，凭据集中在详情", async () => {
    renderManager();
    await createView();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "MCP 工具" }));
    mockedCreate.mockResolvedValue({
      connection: mcp(),
      credential: { token: "mcp-token-current" },
    });
    mockedFetch.mockResolvedValue(listData([mcp()]));
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await screen.findByRole("region", { name: "我的连接" });
    expect(
      screen.queryByRole("button", { name: "复制 Token" }),
    ).not.toBeInTheDocument();
    await detailView();
    expect(screen.getAllByText(/mcp-token-current/u)).toHaveLength(2);
  });

  it("设为默认保留其他连接，并显示明确反馈", async () => {
    mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED, mcp()]));
    mockedPatch.mockResolvedValue({
      connection: { ...mcp(), isDefault: true },
      credential: null,
    });
    renderManager();
    fireEvent.click(await screen.findByRole("button", { name: "设为默认" }));
    await screen.findByText("默认连接已更新。");
    expect(
      within(screen.getByRole("region", { name: "我的连接" })).getByText(
        /api\.example\.com/u,
      ),
    ).toBeInTheDocument();
    expect(mockedPatch.mock.calls[0]?.[1]).toEqual({
      channel: "mcp",
      isDefault: true,
    });
  });
});
