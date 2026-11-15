import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Device, DeviceListData } from "@tutor/contract";
import { StrictMode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-response";
import {
  listDevicesApi,
  mergeDevicesApi,
  readDeviceSessionOwner,
  renameDeviceApi,
  revokeDeviceSessionsApi,
  revokeUnassignedSessionsApi,
} from "@/lib/device-api";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/test/render-with-portal";
import { DeviceSettingsSection } from "./DeviceSettingsSection";

const cleanup = vi.hoisted(() => ({ student: vi.fn(), teacher: vi.fn() }));
vi.mock("@/features/auth/student-auth", () => ({
  useClearStudentSession: () => cleanup.student,
}));
vi.mock("@/features/auth/teacher-auth", () => ({
  useClearTeacherSession: () => cleanup.teacher,
}));
vi.mock("@/lib/device-api", () => ({
  listDevicesApi: vi.fn(),
  mergeDevicesApi: vi.fn(),
  renameDeviceApi: vi.fn(),
  revokeDeviceSessionsApi: vi.fn(),
  revokeUnassignedSessionsApi: vi.fn(),
  readDeviceSessionOwner: vi.fn(),
}));
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
function device(deviceId = first, patch: Partial<Device> = {}): Device {
  return {
    deviceId,
    type: "desktop",
    os: "Windows",
    browser: "Edge",
    standalone: false,
    automaticName: "Windows · Edge",
    name: "书桌电脑",
    displayName: "书桌电脑",
    firstSeenAt: "2026-11-01T00:00:00Z",
    lastSeenAt: "2026-11-13T00:00:00Z",
    activeSessionCount: 1,
    ...patch,
  };
}
function Location() {
  const location = useLocation();
  return (
    <output aria-label="当前地址">
      {location.pathname + location.search + location.hash}
    </output>
  );
}
function section(
  role: "student" | "teacher" = "student",
  id = "owner",
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/s/settings"]}>
        <DeviceSettingsSection
          key={`${role}:${id}`}
          owner={{ type: role, id }}
          accountKind="personal"
        />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}
beforeEach(() => {
  vi.clearAllMocks();
  cleanup.student.mockImplementation(async (done?: () => void) => done?.());
  cleanup.teacher.mockImplementation(async (done?: () => void) => done?.());
  vi.mocked(listDevicesApi).mockResolvedValue({
    devices: [
      device(),
      device(second, {
        name: null,
        displayName: "旧设备",
        activeSessionCount: 0,
      }),
    ],
    unassignedSessionCount: 3,
    currentDeviceId: first,
  });
  vi.mocked(renameDeviceApi).mockResolvedValue(device());
  vi.mocked(mergeDevicesApi).mockResolvedValue(device());
  vi.mocked(revokeDeviceSessionsApi).mockResolvedValue({ revoked: 2 });
  vi.mocked(revokeUnassignedSessionsApi).mockResolvedValue({ revoked: 5 });
  vi.mocked(readDeviceSessionOwner).mockResolvedValue("owner");
});

describe("我的设备", () => {
  it("服务端拒绝目标变化后保留输入，不自动跟随新目标重试", async () => {
    const source = device(second, {
      displayName: "旧记录",
      activeSessionCount: 0,
    });
    vi.mocked(listDevicesApi)
      .mockResolvedValueOnce({
        devices: [device(), source],
        unassignedSessionCount: 0,
      })
      .mockResolvedValue({ devices: [source], unassignedSessionCount: 0 });
    vi.mocked(mergeDevicesApi).mockRejectedValueOnce(
      new ApiError(
        "DEVICE_MERGE_STALE",
        "设备记录或登录状态已变化，请刷新后重新确认合并",
        409,
      ),
    );
    section();
    fireEvent.click(
      await screen.findByRole("button", { name: "合并到 书桌电脑" }),
    );
    fireEvent.change(screen.getByLabelText("旧设备记录"), {
      target: { value: second },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认合并" }));
    expect(await screen.findByText(/设备记录或登录状态已变化/)).toBeVisible();
    expect(screen.getByLabelText("旧设备记录")).toHaveValue(second);
    expect(screen.getByText(/保留“书桌电脑”/)).toBeVisible();
    expect(screen.getByRole("button", { name: "确认合并" })).toBeDisabled();
    expect(mergeDevicesApi).toHaveBeenCalledExactlyOnceWith(
      "student",
      second,
      first,
      expect.any(AbortSignal),
      {
        sourceDeviceId: second,
        targetDeviceId: first,
        allowActiveSource: false,
      },
    );
  });
  it("来源被另一窗口归并后保留原选择名称，不自动换成刷新后的记录", async () => {
    vi.mocked(listDevicesApi)
      .mockResolvedValueOnce({
        devices: [
          device(),
          device(second, { displayName: "原来源", activeSessionCount: 0 }),
        ],
        unassignedSessionCount: 0,
      })
      .mockResolvedValue({ devices: [device()], unassignedSessionCount: 0 });
    vi.mocked(mergeDevicesApi).mockRejectedValueOnce(
      new ApiError(
        "DEVICE_MERGE_STALE",
        "设备记录或登录状态已变化，请刷新后重新确认合并",
        409,
      ),
    );
    section();
    fireEvent.click(
      await screen.findByRole("button", { name: "合并到 书桌电脑" }),
    );
    fireEvent.change(screen.getByLabelText("旧设备记录"), {
      target: { value: second },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认合并" }));
    expect(await screen.findByText(/设备记录或登录状态已变化/)).toBeVisible();
    expect(screen.getByLabelText("旧设备记录")).toHaveValue(second);
    expect(
      screen.getByRole("option", { name: /原来源（记录已变化/ }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "确认合并" })).toBeDisabled();
    expect(mergeDevicesApi).toHaveBeenCalledTimes(1);
  });
  it("有效未分配登录为零时仍可清理过期记录，按实际回执显示", async () => {
    vi.mocked(listDevicesApi).mockResolvedValue({
      devices: [],
      unassignedSessionCount: 0,
    });
    section();
    fireEvent.click(
      await screen.findByRole("button", { name: "清理未分配的登录记录" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    expect(await screen.findByText("已移除5条浏览器登录记录")).toBeVisible();
  });
  it("撤销已成功但登录核对暂时失败时保留实际移除条数，不伪报未删除", async () => {
    vi.mocked(readDeviceSessionOwner).mockRejectedValueOnce(
      new Error("核对服务暂时不可用"),
    );
    section();
    fireEvent.click(
      await screen.findByRole("button", { name: "移除登录记录 旧设备" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    expect(
      await screen.findByText(/已移除2条浏览器登录记录.*暂时无法确认/),
    ).toBeVisible();
    expect(cleanup.student).not.toHaveBeenCalled();
  });
  it("服务端拒绝新出现有效登录后保持来源，刷新后须明确确认再提交", async () => {
    const inactive = {
      devices: [
        device(),
        device(second, {
          displayName: "刚上线的旧记录",
          activeSessionCount: 0,
        }),
      ],
      unassignedSessionCount: 0,
    };
    const active = {
      ...inactive,
      devices: [
        device(),
        device(second, {
          displayName: "刚上线的旧记录",
          activeSessionCount: 1,
        }),
      ],
    };
    vi.mocked(listDevicesApi)
      .mockResolvedValueOnce(inactive)
      .mockResolvedValue(active);
    vi.mocked(mergeDevicesApi).mockRejectedValueOnce(
      new ApiError(
        "DEVICE_MERGE_STALE",
        "设备记录或登录状态已变化，请刷新后重新确认合并",
        409,
      ),
    );
    section();
    fireEvent.click(
      await screen.findByRole("button", { name: "合并到 书桌电脑" }),
    );
    fireEvent.change(screen.getByLabelText("旧设备记录"), {
      target: { value: second },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认合并" }));
    expect(await screen.findByText(/设备记录或登录状态已变化/)).toBeVisible();
    expect(screen.getByLabelText("旧设备记录")).toHaveValue(second);
    expect(screen.getByRole("button", { name: "确认合并" })).toBeDisabled();
    expect(mergeDevicesApi).toHaveBeenCalledExactlyOnceWith(
      "student",
      second,
      first,
      expect.any(AbortSignal),
      {
        sourceDeviceId: second,
        targetDeviceId: first,
        allowActiveSource: false,
      },
    );
    expect(screen.getByLabelText(/我已了解.*失效/)).not.toBeChecked();
    fireEvent.click(screen.getByLabelText(/我已了解.*失效/));
    fireEvent.click(screen.getByRole("button", { name: "确认合并" }));
    await waitFor(() => expect(mergeDevicesApi).toHaveBeenCalledTimes(2));
    expect(mergeDevicesApi).toHaveBeenLastCalledWith(
      "student",
      second,
      first,
      expect.any(AbortSignal),
      {
        sourceDeviceId: second,
        targetDeviceId: first,
        allowActiveSource: true,
      },
    );
  });
  it("StrictMode重新挂载后操作不复用已中止的请求控制器", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <DeviceSettingsSection
              owner={{ type: "student", id: "owner" }}
              accountKind="class"
            />
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "改名 书桌电脑" }),
    );
    fireEvent.change(screen.getByLabelText("设备名称"), {
      target: { value: "仍可保存" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    expect(await screen.findByText("设备名称已保存")).toBeVisible();
    expect(vi.mocked(renameDeviceApi).mock.calls[0]?.[3]?.aborted).toBe(false);
  });
  it("展示登记名称、当前会话和浏览器登录边界，不按Agent类型给权限", async () => {
    vi.mocked(listDevicesApi).mockResolvedValue({
      devices: [device(first, { type: "agent" })],
      unassignedSessionCount: 0,
      currentDeviceId: first,
    });
    section();
    expect(await screen.findByText("书桌电脑")).toBeVisible();
    expect(screen.getByText("当前浏览器")).toBeVisible();
    expect(screen.getByText(/MCP.*不会/)).toBeVisible();
    expect(screen.getByRole("button", { name: "改名 书桌电脑" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "移除登录记录 书桌电脑" }),
    ).toBeEnabled();
  });
  it("改名失败保留输入，恢复默认发null", async () => {
    vi.mocked(renameDeviceApi).mockRejectedValueOnce(
      new Error("名称暂时未保存"),
    );
    section();
    fireEvent.click(
      await screen.findByRole("button", { name: "改名 书桌电脑" }),
    );
    fireEvent.change(screen.getByLabelText("设备名称"), {
      target: { value: "卧室电脑" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    expect(await screen.findByText("名称暂时未保存")).toBeVisible();
    expect(screen.getByLabelText("设备名称")).toHaveValue("卧室电脑");
    fireEvent.click(screen.getByRole("button", { name: "恢复自动名称" }));
    await waitFor(() =>
      expect(renameDeviceApi).toHaveBeenLastCalledWith(
        "student",
        first,
        null,
        expect.any(AbortSignal),
      ),
    );
  });
  it("合并以此设备为保留目标，默认不选来源，活跃来源需明确确认", async () => {
    vi.mocked(listDevicesApi).mockResolvedValue({
      devices: [
        device(),
        device(second, { displayName: "平板", activeSessionCount: 1 }),
      ],
      unassignedSessionCount: 0,
    });
    section();
    fireEvent.click(
      await screen.findByRole("button", { name: "合并到 书桌电脑" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("旧设备记录")).toHaveValue("");
    expect(
      within(dialog).getByRole("button", { name: "确认合并" }),
    ).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("旧设备记录"), {
      target: { value: second },
    });
    expect(
      within(dialog).getByRole("button", { name: "确认合并" }),
    ).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText(/我已了解.*失效/));
    fireEvent.click(within(dialog).getByRole("button", { name: "确认合并" }));
    await waitFor(() =>
      expect(mergeDevicesApi).toHaveBeenCalledWith(
        "student",
        second,
        first,
        expect.any(AbortSignal),
        {
          sourceDeviceId: second,
          targetDeviceId: first,
          allowActiveSource: true,
        },
      ),
    );
  });
  it("撤当前浏览器只清当前subject并去个人登录，不碰另一侧缓存", async () => {
    const { client } = section();
    client.setQueryData(["teacher", "private", "owner"], { preserved: true });
    fireEvent.click(
      await screen.findByRole("button", { name: "移除登录记录 书桌电脑" }),
    );
    expect(screen.getByText(/本机未同步/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(cleanup.student).toHaveBeenCalledTimes(1));
    expect(cleanup.teacher).not.toHaveBeenCalled();
    expect(screen.getByLabelText("当前地址")).toHaveTextContent(
      "/p/login?returnTo=%2Fs%2Fsettings",
    );
    expect(client.getQueryData(["teacher", "private", "owner"])).toEqual({
      preserved: true,
    });
  });
  it("旧响应未知当前设备时验证真实session，教师只清教师", async () => {
    vi.mocked(listDevicesApi).mockResolvedValue({
      devices: [device()],
      unassignedSessionCount: 0,
    });
    vi.mocked(readDeviceSessionOwner).mockResolvedValue(null);
    section("teacher");
    fireEvent.click(
      await screen.findByRole("button", { name: "移除登录记录 书桌电脑" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(cleanup.teacher).toHaveBeenCalledTimes(1));
    expect(cleanup.student).not.toHaveBeenCalled();
    expect(readDeviceSessionOwner).toHaveBeenCalledWith(
      "teacher",
      expect.any(AbortSignal),
    );
  });
  it("清未分配回显实际删除数，不把有效数当删除数", async () => {
    section();
    fireEvent.click(
      await screen.findByRole("button", { name: "清理未分配的登录记录" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    expect(await screen.findByText("已移除5条浏览器登录记录")).toBeVisible();
    expect(cleanup.student).not.toHaveBeenCalled();
  });
  it("按subject隔离查询，旧账号迟到列表不进新账号", async () => {
    let finish: (data: DeviceListData) => void = () => {};
    vi.mocked(listDevicesApi).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { unmount, client } = section("student", "old");
    unmount();
    section("student", "new", client);
    expect(await screen.findByText("书桌电脑")).toBeVisible();
    finish({
      devices: [device(first, { displayName: "旧账号秘密" })],
      unassignedSessionCount: 0,
    });
    await waitFor(() => expect(listDevicesApi).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("旧账号秘密")).toBeNull();
    expect(client.getQueryData(["student", "devices", "new"])).toEqual(
      expect.objectContaining({ currentDeviceId: first }),
    );
  });
});
