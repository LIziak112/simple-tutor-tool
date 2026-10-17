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
  it("重新进入页面仍展示完整 MCP Token 与可直接复制的配置", async () => {
    const connection = {
      ...INAPP_UNVERIFIED,
      channel: "mcp" as const,
      tokenFingerprint: "aabbccdd",
      token: "persistent-mcp-token",
    };
    mockedFetch.mockResolvedValue(listData([connection]));
    const view = renderManager();
    await screen.findAllByText(/persistent-mcp-token/u);
    fireEvent.click(
      screen.getByRole("button", { name: "复制完整 MCP 配置 JSON" }),
    );
    await waitFor(() =>
      expect(mockedCopy).toHaveBeenCalledWith(
        expect.stringContaining("Bearer persistent-mcp-token"),
      ),
    );
    expect(screen.queryByText(/只显示这一次/u)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /复制示例/u }),
    ).not.toBeInTheDocument();
    view.unmount();
    renderManager();
    expect(await screen.findAllByText(/persistent-mcp-token/u)).toHaveLength(2);
  });
  describe("先测 1:新账号默认未连接,不默认已同意发送", () => {
    it("空列表显示未配置;知情四要素常驻且确认默认未勾选,未勾选时不能保存", async () => {
      renderManager();
      expect(await screen.findByText(/尚未配置 AI 连接/u)).toBeInTheDocument();
      // 首次说明四要素:目的地 / 答案解析 / 姓名 / 费用
      expect(screen.getByText(/发送到你配置的 AI 服务/u)).toBeInTheDocument();
      expect(screen.getByText(/答案解析/u)).toBeInTheDocument();
      expect(screen.getByText(/姓名/u)).toBeInTheDocument();
      expect(screen.getAllByText(/费用/u)[0]).toBeInTheDocument();
      const consent = screen.getByRole("checkbox", {
        name: "我已了解数据外发说明",
      });
      expect(consent).not.toBeChecked();
      // 填满表单但未确认知情:保存不可用,不发出任何创建请求
      fillInappForm();
      expect(screen.getByRole("button", { name: "保存连接" })).toBeDisabled();
      expect(mockedCreate).not.toHaveBeenCalled();
    });

    it("已有连接即视为已知情:不再要求重复勾选即可直接编辑保存", async () => {
      mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED]));
      renderManager();
      await within(screen.getByRole("region", { name: "我的连接" })).findByText(
        /api\.example\.com/u,
      );
      fillInappForm({ baseUrl: "https://api2.example.com/v1" });
      expect(screen.getByRole("button", { name: "保存连接" })).toBeEnabled();
    });
  });

  describe("先测 2:失败保留输入与可操作错误;Key 只显示安全状态", () => {
    it("保存失败:输入与知情确认保留,显示服务端中文错误", async () => {
      renderManager();
      fireEvent.click(
        screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
      );
      fillInappForm();
      mockedCreate.mockRejectedValue(
        new ApiError(
          "AI_CONNECTION_INVALID",
          "接口地址不可达,请检查后重试",
          400,
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/接口地址不可达/u);
      expect(screen.getByLabelText("接口地址")).toHaveValue(
        "https://api.example.com/v1",
      );
      expect(screen.getByLabelText("模型名称")).toHaveValue("glm-4");
      expect(screen.getByLabelText("API Key")).toHaveValue("sk-plain-test-key");
      expect(
        screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
      ).toBeChecked();
    });

    it("Key 字段只显示安全状态:输入为 password,列表只回指纹不回显明文", async () => {
      mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED]));
      renderManager();
      expect(await screen.findByText(/ab12cd34/u)).toBeInTheDocument();
      expect(screen.queryByText(/sk-/u)).not.toBeInTheDocument();
      expect(screen.getByLabelText("API Key")).toHaveAttribute(
        "type",
        "password",
      );
    });

    it("连接测试失败:显示失败结果与说明,连接仍留在列表", async () => {
      mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED]));
      renderManager();
      expect(await screen.findByText(/已保存,未测试/u)).toBeInTheDocument();
      mockedTest.mockRejectedValue(
        new ApiError("AI_OUTBOUND_FAILED", "无法连接到 AI 服务", 502),
      );
      fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/无法连接到 AI 服务/u);
      expect(
        await within(
          screen.getByRole("region", { name: "我的连接" }),
        ).findByText(/api\.example\.com/u),
      ).toBeInTheDocument();
    });

    it("已配置 / 验证成功 / 暂不可用分开显示;mcp 与 link 不显示已连接", async () => {
      mockedFetch.mockResolvedValue(
        listData([
          INAPP_UNVERIFIED,
          {
            ...INAPP_UNVERIFIED,
            id: "22222222-2222-4222-8222-222222222222",
            baseUrl: "https://api2.example.com/v1",
            isDefault: false,
            verifyStatus: "verified",
            verifiedAt: "2026-10-16T01:00:00.000Z",
          },
          {
            ...INAPP_UNVERIFIED,
            id: "33333333-3333-4333-8333-333333333333",
            baseUrl: "https://api3.example.com/v1",
            isDefault: false,
            verifyStatus: "needs_rekey",
          },
          {
            id: "44444444-4444-4444-8444-444444444444",
            channel: "mcp",
            tokenFingerprint: "mcp12345",
            isDefault: false,
            verifyStatus: "unverified",
            verifiedAt: null,
            createdAt: "2026-10-16T00:00:00.000Z",
            updatedAt: "2026-10-16T00:00:00.000Z",
          },
          {
            id: "55555555-5555-4555-8555-555555555555",
            channel: "link",
            defaultValidHours: 24,
            isDefault: false,
            createdAt: "2026-10-16T00:00:00.000Z",
            updatedAt: "2026-10-16T00:00:00.000Z",
          },
        ]),
      );
      renderManager();
      expect(await screen.findByText(/已保存,未测试/u)).toBeInTheDocument();
      expect(screen.getByText(/验证成功/u)).toBeInTheDocument();
      expect(screen.getAllByText(/需重新填写 Key/u).length).toBeGreaterThan(0);
      // 配置保存不代表外部客户端在线，也不将已实现的功能标为建设中。
      expect(screen.queryAllByText(/建设中/u)).toHaveLength(0);
      expect(screen.queryByText(/已连接/u)).not.toBeInTheDocument();
    });
  });

  describe("先测 3:refetch 不覆盖脏编辑;冲突不吞改动;换账号隔离", () => {
    it("后台 refetch 不覆盖正在编辑的表单草稿", async () => {
      const { client } = renderManager();
      fillInappForm();
      mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED]));
      await client.invalidateQueries({
        queryKey: ["student", "ai-connections"],
      });
      await waitFor(() =>
        expect(screen.getByLabelText("接口地址")).toHaveValue(
          "https://api.example.com/v1",
        ),
      );
      expect(screen.getByLabelText("API Key")).toHaveValue("sk-plain-test-key");
    });

    it("同通道重复(409 AI_STATE_CONFLICT)不吞改动,显示冲突提示", async () => {
      renderManager();
      fireEvent.click(
        screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
      );
      fillInappForm();
      mockedCreate.mockRejectedValue(
        new ApiError("AI_STATE_CONFLICT", "已配置同类连接,请先删除或修改", 409),
      );
      fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/已配置同类连接/u);
      expect(screen.getByLabelText("接口地址")).toHaveValue(
        "https://api.example.com/v1",
      );
      expect(screen.getByLabelText("API Key")).toHaveValue("sk-plain-test-key");
    });

    it("换账号缓存立即隔离:登出清 student 键后不再显示旧账号连接", async () => {
      mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED]));
      const { client } = renderManager();
      expect(
        await within(
          screen.getByRole("region", { name: "我的连接" }),
        ).findByText(/api\.example\.com/u),
      ).toBeInTheDocument();
      // 登出行为(useLogoutStudent 同款):removeQueries(["student"])
      client.removeQueries({ queryKey: ["student"] });
      expect(
        client.getQueryData(["student", "ai-connections"]),
      ).toBeUndefined();
      // 新账号登录后重新渲染:重新拉取,显示新账号的空列表
      mockedFetch.mockResolvedValue(listData([]));
      renderManager();
      expect(await screen.findByText(/尚未配置 AI 连接/u)).toBeInTheDocument();
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("先测 4:配置成功返回原题不自动发;导航放弃确认", () => {
    it("保存成功且带来源题时提供「返回原题」入口;不自动创建求助任务", async () => {
      const from = "/s/assignments/a1?question=q1";
      renderManager(undefined, { from });
      fireEvent.click(
        screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
      );
      fillInappForm();
      mockedCreate.mockResolvedValue({
        connection: INAPP_UNVERIFIED,
        credential: null,
      });
      fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
      const back = await screen.findByRole("link", { name: "返回原题" });
      expect(back).toHaveAttribute(
        "href",
        `/s/assignments/a1?question=${encodeURIComponent("q1")}`,
      );
      // 只有创建连接这一次写请求,未自动发任何求助任务
      expect(mockedCreate).toHaveBeenCalledTimes(1);
      expect(mockedPatch).not.toHaveBeenCalled();
    });

    it("有未保存编辑时普通导航离开先确认:取消留在页面,无编辑直接离开", async () => {
      const first = renderManager();
      await screen.findByText(/尚未配置 AI 连接/u);
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      // 无编辑:点击返回不弹确认,直接离开本页
      fireEvent.click(screen.getByRole("link", { name: "返回设置" }));
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(await screen.findByText("设置主页占位")).toBeInTheDocument();
      first.unmount();
      // 有编辑:弹确认,取消 → 留在连接页继续编辑
      renderManager();
      await screen.findByText(/尚未配置 AI 连接/u);
      fillInappForm();
      fireEvent.click(screen.getByRole("link", { name: "返回设置" }));
      expect(confirmSpy).toHaveBeenCalledWith(
        expect.stringMatching(/尚未保存/u),
      );
      expect(
        screen.getByRole("button", { name: "保存连接" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("设置主页占位")).not.toBeInTheDocument();
      confirmSpy.mockRestore();
    });
  });

  describe("闸门补测:草稿缓存真实读回与来源地址过滤", () => {
    it("表单草稿与编辑态切页重挂不丢;登出清 student 键后归零", async () => {
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const first = renderManager(client);
      await screen.findByText(/尚未配置 AI 连接/u);
      fillInappForm({ baseUrl: "https://keep.example.com/v1" });
      // 切页(卸载)后重挂:草稿从 queryClient 读回,输入不丢
      first.unmount();
      renderManager(client);
      expect(await screen.findByLabelText("接口地址")).toHaveValue(
        "https://keep.example.com/v1",
      );
      expect(screen.getByLabelText("API Key")).toHaveValue("sk-plain-test-key");
      expect(screen.getByText(/有未保存的更改/u)).toBeInTheDocument();
      // 登出(移除 student 键)后重挂:草稿随账号缓存隔离归零
      client.removeQueries({ queryKey: ["student"] });
      const third = renderManager(client);
      await screen.findByText(/尚未配置 AI 连接/u);
      expect(third.container.querySelector("input[type=url]")).toHaveValue("");
      expect(screen.getByText(/表单无未保存更改/u)).toBeInTheDocument();
    });

    it("编辑态经缓存恢复:重挂后仍按修改而非新建保存", async () => {
      mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED]));
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const first = renderManager(client);
      await within(screen.getByRole("region", { name: "我的连接" })).findByText(
        /api\.example\.com/u,
      );
      fireEvent.click(screen.getByRole("button", { name: "修改配置" }));
      fireEvent.change(screen.getByLabelText("模型名称"), {
        target: { value: "glm-5" },
      });
      first.unmount();
      renderManager(client);
      // 重挂后仍是「修改连接」:保存走 patch 而非 create
      expect(await screen.findByText(/修改连接/u)).toBeInTheDocument();
      expect(screen.getByLabelText("模型名称")).toHaveValue("glm-5");
      await within(screen.getByRole("region", { name: "我的连接" })).findByText(
        /api\.example\.com/u,
      );
      mockedPatch.mockResolvedValue({
        connection: INAPP_UNVERIFIED,
        credential: null,
      });
      fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
      await waitFor(() => expect(mockedPatch).toHaveBeenCalledTimes(1));
      expect(mockedCreate).not.toHaveBeenCalled();
    });

    it("from 只接受学生域内部路径:外站与协议相对地址过滤后无回跳入口", async () => {
      for (const bad of ["//evil.example", "https://evil.example/x"]) {
        const view = renderManager(undefined, { from: bad });
        fireEvent.click(
          screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
        );
        fillInappForm();
        mockedCreate.mockResolvedValue({
          connection: INAPP_UNVERIFIED,
          credential: null,
        });
        fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
        await screen.findByText(/连接已保存/u);
        expect(
          screen.queryByRole("link", { name: "返回原题" }),
        ).not.toBeInTheDocument();
        view.unmount();
      }
    });
  });

  describe("MCP 完整凭据与复制", () => {
    it("编辑连接时不能切换为其他通道，取消后恢复选择", async () => {
      mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED]));
      renderManager();
      await within(screen.getByRole("region", { name: "我的连接" })).findByText(
        /api\.example\.com/u,
      );
      fireEvent.click(screen.getByRole("button", { name: "修改配置" }));
      expect(screen.getByRole("radio", { name: "MCP 工具" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "取消修改" }));
      expect(screen.getByRole("radio", { name: "MCP 工具" })).toBeEnabled();
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

    it("修改 MCP 默认配置只发送该通道允许的字段", async () => {
      const connection = mcp();
      mockedFetch.mockResolvedValue(listData([connection]));
      mockedPatch.mockResolvedValue({ connection, credential: null });
      renderManager();
      await screen.findAllByText(/mcp-token-current/u);
      fireEvent.click(screen.getByRole("button", { name: "修改配置" }));
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
    });

    it("创建后直接在我的连接展示 Token 和完整配置，不保留一次性区域", async () => {
      renderManager();
      await screen.findByText(/尚未配置 AI 连接/u);
      fireEvent.click(
        screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
      );
      fireEvent.click(screen.getByRole("radio", { name: "MCP 工具" }));
      const connection = mcp();
      mockedCreate.mockResolvedValue({
        connection,
        credential: { token: connection.token ?? "" },
      });
      mockedFetch.mockResolvedValue(listData([connection]));
      fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
      expect(await screen.findAllByText(/mcp-token-current/u)).toHaveLength(2);
      expect(screen.queryByText(/只显示这一次/u)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "复制 Token" }));
      await waitFor(() =>
        expect(mockedCopy).toHaveBeenCalledWith("mcp-token-current"),
      );
    });

    it("Token 复制失败提供手动复制反馈，不虚报成功", async () => {
      mockedFetch.mockResolvedValue(listData([mcp()]));
      mockedCopy.mockResolvedValue(false);
      renderManager();
      await screen.findAllByText(/mcp-token-current/u);
      fireEvent.click(screen.getByRole("button", { name: "复制 Token" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/复制失败/u);
      expect(screen.queryAllByText("已复制")).toHaveLength(0);
      expect(screen.getAllByText(/mcp-token-current/u)).toHaveLength(2);
    });

    it("旧连接不给占位配置，保持连接并说明重新生成一次即可查看", async () => {
      mockedFetch.mockResolvedValue(listData([mcp(null)]));
      renderManager();
      expect(await screen.findByText(/旧连接仍可使用/u)).toBeInTheDocument();
      expect(mockedPatch).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("button", { name: "复制完整 MCP 配置 JSON" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByText("端点与认证方式"));
      fireEvent.click(screen.getByRole("button", { name: "复制端点" }));
      await waitFor(() =>
        expect(mockedCopy).toHaveBeenCalledWith(
          `${window.location.origin}/mcp/student`,
        ),
      );
    });

    it("重置成功后立即替换 Token 与配置，旧值不残留", async () => {
      mockedFetch.mockResolvedValue(listData([mcp("old-token")]));
      renderManager();
      await screen.findAllByText(/old-token/u);
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
      fireEvent.click(
        screen.getByRole("button", { name: "复制完整 MCP 配置 JSON" }),
      );
      await waitFor(() =>
        expect(mockedCopy).toHaveBeenCalledWith(
          expect.stringContaining("Bearer new-token"),
        ),
      );
    });

    it("设置新默认时保留原连接，并且后台刷新不覆盖编辑草稿", async () => {
      mockedFetch.mockResolvedValue(listData([INAPP_UNVERIFIED, mcp()]));
      renderManager();
      await screen.findAllByText(/mcp-token-current/u);
      fillInappForm({ model: "未保存模型" });
      mockedPatch.mockResolvedValue({
        connection: { ...mcp(), isDefault: true },
        credential: null,
      });
      mockedFetch.mockImplementation(() => new Promise(() => {}));
      fireEvent.click(screen.getByRole("button", { name: "设为默认" }));
      await waitFor(() => expect(mockedPatch).toHaveBeenCalled());
      expect(
        within(screen.getByRole("region", { name: "我的连接" })).getByText(
          /api\.example\.com/u,
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "模型名称" })).toHaveValue(
        "未保存模型",
      );
    });
  });
});
