import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AiConnectionListData } from "@tutor/contract";
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
 * - MCP token 一次性展示:复制成功 / 失败都有真实反馈,失败可手动复制,
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
  describe("先测 1:新账号默认未连接,不默认已同意发送", () => {
    it("空列表显示未配置;知情四要素常驻且确认默认未勾选,未勾选时不能保存", async () => {
      renderManager();
      expect(await screen.findByText(/尚未配置 AI 连接/u)).toBeInTheDocument();
      // 首次说明四要素:目的地 / 答案解析 / 姓名 / 费用
      expect(screen.getByText(/发送到你配置的 AI 服务/u)).toBeInTheDocument();
      expect(screen.getByText(/答案解析/u)).toBeInTheDocument();
      expect(screen.getByText(/姓名/u)).toBeInTheDocument();
      expect(screen.getByText(/费用/u)).toBeInTheDocument();
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
      await screen.findByText(/api\.example\.com/u);
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
      expect(await screen.findByText(/api\.example\.com/u)).toBeInTheDocument();
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
      // mcp / link:功能建设中,不显示「已连接」
      expect(screen.getAllByText(/建设中/u).length).toBeGreaterThan(0);
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
      expect(await screen.findByText(/api\.example\.com/u)).toBeInTheDocument();
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
      await screen.findByText(/api\.example\.com/u);
      fireEvent.click(screen.getByRole("button", { name: "修改配置" }));
      fireEvent.change(screen.getByLabelText("模型名称"), {
        target: { value: "glm-5" },
      });
      first.unmount();
      renderManager(client);
      // 重挂后仍是「修改连接」:保存走 patch 而非 create
      expect(await screen.findByText(/修改连接/u)).toBeInTheDocument();
      expect(screen.getByLabelText("模型名称")).toHaveValue("glm-5");
      await screen.findByText(/api\.example\.com/u);
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

  describe("先测 5:MCP token 一次性展示与复制反馈", () => {
    it("创建 MCP 连接后一次性展示 token;复制成功显示已复制", async () => {
      renderManager();
      fireEvent.click(
        screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
      );
      fireEvent.click(screen.getByRole("radio", { name: "MCP 工具" }));
      mockedCreate.mockResolvedValue({
        connection: {
          id: "44444444-4444-4444-8444-444444444444",
          channel: "mcp",
          tokenFingerprint: "mcp12345",
          isDefault: false,
          verifyStatus: "unverified",
          verifiedAt: null,
          createdAt: "2026-10-16T00:00:00.000Z",
          updatedAt: "2026-10-16T00:00:00.000Z",
        },
        credential: { token: "tok-once-abc123" },
      });
      fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
      expect(await screen.findByText(/tok-once-abc123/u)).toBeInTheDocument();
      mockedCopy.mockResolvedValue(true);
      fireEvent.click(screen.getByRole("button", { name: "复制 Token" }));
      await waitFor(() =>
        expect(screen.getByText(/已复制/u)).toBeInTheDocument(),
      );
    });

    it("复制失败有反馈且可手动处理,不虚报成功", async () => {
      renderManager();
      fireEvent.click(
        screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
      );
      fireEvent.click(screen.getByRole("radio", { name: "MCP 工具" }));
      mockedCreate.mockResolvedValue({
        connection: {
          id: "44444444-4444-4444-8444-444444444444",
          channel: "mcp",
          tokenFingerprint: "mcp12345",
          isDefault: false,
          verifyStatus: "unverified",
          verifiedAt: null,
          createdAt: "2026-10-16T00:00:00.000Z",
          updatedAt: "2026-10-16T00:00:00.000Z",
        },
        credential: { token: "tok-once-abc123" },
      });
      fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
      expect(await screen.findByText(/tok-once-abc123/u)).toBeInTheDocument();
      mockedCopy.mockResolvedValue(false);
      fireEvent.click(screen.getByRole("button", { name: "复制 Token" }));
      await waitFor(() =>
        expect(screen.getByText(/复制失败,请手动复制/u)).toBeInTheDocument(),
      );
      // 明文仍在页面,可手动选择复制;没有虚报「已复制」
      expect(screen.queryByText(/已复制/u)).not.toBeInTheDocument();
      expect(screen.getByText(/tok-once-abc123/u)).toBeInTheDocument();
    });
  });

  describe("SAI-27:MCP 端点展示与客户端兼容说明", () => {
    /** 已配置的 mcp 连接(掩码口径,无明文) */
    const MCP_CONNECTION = {
      id: "44444444-4444-4444-8444-444444444444",
      channel: "mcp" as const,
      tokenFingerprint: "mcp12345",
      isDefault: false,
      verifyStatus: "unverified" as const,
      verifiedAt: null,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };

    it("mcp 连接行显示端点与认证方式,不再标「功能建设中」;复制端点成功有反馈", async () => {
      mockedFetch.mockResolvedValue(listData([MCP_CONNECTION]));
      renderManager();
      expect(
        await screen.findByText(/Token 指纹 mcp12345/u),
      ).toBeInTheDocument();
      // 端点(SAI-25 独立学生端点)与认证方式常驻展示,普通查询只有掩码
      expect(screen.getByText(/\/mcp\/student/u)).toBeInTheDocument();
      expect(screen.getByText(/认证方式 Bearer Token/u)).toBeInTheDocument();
      // SAI-26 后 mcp 通道已闭环,连接行不再标「功能建设中」
      // (页脚对上下文链接通道的建设中说明是真实状态,不在此断言范围)
      expect(
        screen.queryByText(/功能建设中,可先保存偏好/u),
      ).not.toBeInTheDocument();
      // 等待状态真实:入队后由外部客户端领取,未写回不虚报
      expect(screen.getByText(/未写回前保持等待/u)).toBeInTheDocument();
      mockedCopy.mockResolvedValue(true);
      fireEvent.click(screen.getByRole("button", { name: "复制端点" }));
      await waitFor(() =>
        expect(screen.getByText(/已复制/u)).toBeInTheDocument(),
      );
    });

    it("复制端点失败有反馈,不虚报成功", async () => {
      mockedFetch.mockResolvedValue(listData([MCP_CONNECTION]));
      renderManager();
      await screen.findByText(/Token 指纹 mcp12345/u);
      mockedCopy.mockResolvedValue(false);
      fireEvent.click(screen.getByRole("button", { name: "复制端点" }));
      await waitFor(() =>
        expect(screen.getByText(/复制失败,请手动复制/u)).toBeInTheDocument(),
      );
      expect(screen.queryByText(/^已复制$/u)).not.toBeInTheDocument();
    });

    it("mcp 表单说明客户端要求:不能附 Bearer 或仅支持 OAuth 的客户端当前不兼容", async () => {
      renderManager();
      fireEvent.click(screen.getByRole("radio", { name: "MCP 工具" }));
      expect(
        screen.getByText(/不能附加 Bearer Token 或仅支持 OAuth/u),
      ).toBeInTheDocument();
      // 不改用长效 URL 密钥绕过兼容问题
      expect(screen.queryByText(/URL 密钥/u)).not.toBeInTheDocument();
    });
  });
});
