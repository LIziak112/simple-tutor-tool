import {
  type Device,
  type DeviceListData,
  type DeviceMergeIntent,
  deviceListDataSchema,
  deviceSchema,
} from "@tutor/contract";
import type { DeviceOwner } from "@/features/runtime/ports/devices-types";
import { ApiError, callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
export function createDevicesClient(http: HttpRuntime) {
  const { api } = http;
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
  async function listDevicesApi(
    role: DeviceOwner["type"],
    signal?: AbortSignal,
  ): Promise<DeviceListData> {
    return deviceListDataSchema.parse(
      await callApi(() => routes(role).$get({}, options(signal))),
    );
  }
  async function renameDeviceApi(
    role: DeviceOwner["type"],
    id: string,
    name: string | null,
    signal?: AbortSignal,
  ): Promise<Device> {
    return deviceSchema.parse(
      await callApi(() =>
        routes(role)[":id"].$patch(
          { param: { id } },
          options(signal, { name }),
        ),
      ),
    );
  }
  async function mergeDevicesApi(
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
  function revokeDeviceSessionsApi(
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
  function revokeUnassignedSessionsApi(
    role: DeviceOwner["type"],
    signal?: AbortSignal,
  ): Promise<{ revoked: number }> {
    return callApi(() =>
      routes(role)["unassigned-sessions"].revoke.$post({}, options(signal)),
    );
  }
  async function readDeviceSessionOwner(
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
  return {
    listDevicesApi,
    renameDeviceApi,
    mergeDevicesApi,
    revokeDeviceSessionsApi,
    revokeUnassignedSessionsApi,
    readDeviceSessionOwner,
  };
}
