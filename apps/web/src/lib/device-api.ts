import {
  type Device,
  type DeviceListData,
  type DeviceMergeIntent,
  deviceListDataSchema,
  deviceSchema,
} from "@tutor/contract";
import { api } from "./api-client";
import { ApiError, callApi } from "./api-response";

export interface DeviceOwner {
  readonly type: "student" | "teacher";
  readonly id: string;
}
const routes = (role: DeviceOwner["type"]) => api.api[role].devices;
const options = (signal?: AbortSignal, json?: unknown) => ({
  init: {
    ...(signal === undefined ? {} : { signal }),
    ...(json === undefined
      ? {}
      : {
          body: JSON.stringify(json),
          headers: { "content-type": "application/json" },
        }),
  },
});

/** 不等待额外登记；同源公共客户端负责请求设备元信息。 */
export async function listDevicesApi(
  role: DeviceOwner["type"],
  signal?: AbortSignal,
): Promise<DeviceListData> {
  return deviceListDataSchema.parse(
    await callApi(() => routes(role).$get({}, options(signal))),
  );
}
export async function renameDeviceApi(
  role: DeviceOwner["type"],
  id: string,
  name: string | null,
  signal?: AbortSignal,
): Promise<Device> {
  return deviceSchema.parse(
    await callApi(() =>
      routes(role)[":id"].$patch({ param: { id } }, options(signal, { name })),
    ),
  );
}
export async function mergeDevicesApi(
  role: DeviceOwner["type"],
  source: string,
  target: string,
  signal?: AbortSignal,
  intent?: DeviceMergeIntent,
): Promise<Device> {
  return deviceSchema.parse(
    await callApi(() =>
      routes(role)[":id"].merge.$post(
        { param: { id: source } },
        options(signal, {
          targetDeviceId: target,
          ...(intent === undefined ? {} : { intent }),
        }),
      ),
    ),
  );
}
export function revokeDeviceSessionsApi(
  role: DeviceOwner["type"],
  id: string,
  signal?: AbortSignal,
): Promise<{ revoked: number }> {
  return callApi(() =>
    routes(role)[":id"]["revoke-sessions"].$post(
      { param: { id } },
      options(signal),
    ),
  );
}
export function revokeUnassignedSessionsApi(
  role: DeviceOwner["type"],
  signal?: AbortSignal,
): Promise<{ revoked: number }> {
  return callApi(() =>
    routes(role)["unassigned-sessions"].revoke.$post({}, options(signal)),
  );
}
/** 旧列表没有当前设备时，撤销后以真正的角色会话核对，401才认定已退出。 */
export async function readDeviceSessionOwner(
  role: DeviceOwner["type"],
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    return (
      await callApi<{ id: string }>(() =>
        api.api[role].me.$get({}, options(signal)),
      )
    ).id;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}
