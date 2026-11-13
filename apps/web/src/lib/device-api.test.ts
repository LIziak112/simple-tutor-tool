import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listDevicesApi,
  mergeDevicesApi,
  readDeviceSessionOwner,
  renameDeviceApi,
  revokeDeviceSessionsApi,
  revokeUnassignedSessionsApi,
} from "./device-api";

const fetcher = vi.fn<typeof fetch>();
const id = "11111111-1111-4111-8111-111111111111";
const record = {
  deviceId: id,
  type: "desktop",
  os: "Windows",
  browser: "Edge",
  standalone: false,
  automaticName: "Windows · Edge",
  name: null,
  displayName: "Windows · Edge",
  firstSeenAt: "2026-11-01T00:00:00Z",
  lastSeenAt: "2026-11-13T00:00:00Z",
  activeSessionCount: 1,
};
const shell = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), {
    headers: { "content-type": "application/json" },
  });
beforeEach(() => {
  fetcher.mockReset();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());
function called(index: number) {
  const entry = fetcher.mock.calls[index];
  if (entry === undefined) throw new Error(`缺少第${index + 1}次HTTP请求`);
  return entry;
}
const pathOf = (input: RequestInfo | URL) =>
  new URL(
    input instanceof Request ? input.url : String(input),
    "http://localhost",
  ).pathname;

describe("设备公共客户端", () => {
  it("同源设备请求保留角色、取消信号且不新增登记等待", async () => {
    fetcher.mockResolvedValue(
      shell({ devices: [], unassignedSessionCount: 0 }),
    );
    const signal = new AbortController().signal;
    expect(await listDevicesApi("teacher", signal)).toEqual({
      devices: [],
      unassignedSessionCount: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = called(0);
    expect(pathOf(input)).toBe("/api/teacher/devices");
    expect(init?.signal).toBe(signal);
    expect(new Headers(init?.headers).get("x-tutor-device-id")).toBeTruthy();
  });
  it("改名NULL、合并方向与两种撤销使用真实角色路径", async () => {
    fetcher.mockImplementation(async (input) =>
      shell(
        pathOf(input).endsWith("revoke") ||
          pathOf(input).endsWith("revoke-sessions")
          ? { revoked: 3 }
          : record,
      ),
    );
    await renameDeviceApi("student", id, null);
    expect(JSON.parse(String(called(0)[1]?.body))).toEqual({
      name: null,
    });
    await mergeDevicesApi(
      "teacher",
      id,
      "22222222-2222-4222-8222-222222222222",
    );
    expect(pathOf(called(1)[0])).toBe(`/api/teacher/devices/${id}/merge`);
    expect(JSON.parse(String(called(1)[1]?.body))).toEqual({
      targetDeviceId: "22222222-2222-4222-8222-222222222222",
    });
    expect(await revokeDeviceSessionsApi("student", id)).toEqual({
      revoked: 3,
    });
    expect(await revokeUnassignedSessionsApi("teacher")).toEqual({
      revoked: 3,
    });
    expect(pathOf(called(2)[0])).toBe(
      `/api/student/devices/${id}/revoke-sessions`,
    );
    expect(pathOf(called(3)[0])).toBe(
      "/api/teacher/devices/unassigned-sessions/revoke",
    );
  });
  it("新UI请求原样发送确认身份、活跃意图和取消信号，旧调用保持原body", async () => {
    fetcher.mockResolvedValue(shell(record));
    const targetDeviceId = "22222222-2222-4222-8222-222222222222";
    const intent = {
      sourceDeviceId: id,
      targetDeviceId,
      allowActiveSource: false,
    };
    const signal = new AbortController().signal;
    await mergeDevicesApi("student", id, targetDeviceId, signal, intent);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(called(0)[1]?.body))).toEqual({
      targetDeviceId,
      intent,
    });
    expect(called(0)[1]?.signal).toBe(signal);
  });
  it("撤销后的角色验证仅401视为退出，500/网络错误不伪报下线", async () => {
    fetcher.mockResolvedValueOnce(shell({ id: "owner" }));
    expect(await readDeviceSessionOwner("student")).toBe("owner");
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, error: "UNAUTHORIZED", message: "未登录" }),
        { status: 401 },
      ),
    );
    expect(await readDeviceSessionOwner("teacher")).toBeNull();
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, error: "INTERNAL", message: "暂时不可用" }),
        { status: 500 },
      ),
    );
    await expect(readDeviceSessionOwner("student")).rejects.toThrow(
      "暂时不可用",
    );
  });
});
