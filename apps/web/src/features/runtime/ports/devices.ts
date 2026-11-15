import type {
  Device,
  DeviceListData,
  DeviceMergeIntent,
} from "@tutor/contract";
import type { DeviceOwner } from "./devices-types";
export interface DevicesPorts {
  listDevicesApi(
    role: DeviceOwner["type"],
    signal?: AbortSignal,
  ): Promise<DeviceListData>;
  renameDeviceApi(
    role: DeviceOwner["type"],
    id: string,
    name: string | null,
    signal?: AbortSignal,
  ): Promise<Device>;
  mergeDevicesApi(
    role: DeviceOwner["type"],
    source: string,
    target: string,
    signal?: AbortSignal,
    intent?: DeviceMergeIntent,
  ): Promise<Device>;
  revokeDeviceSessionsApi(
    role: DeviceOwner["type"],
    id: string,
    signal?: AbortSignal,
  ): Promise<{
    revoked: number;
  }>;
  revokeUnassignedSessionsApi(
    role: DeviceOwner["type"],
    signal?: AbortSignal,
  ): Promise<{
    revoked: number;
  }>;
  readDeviceSessionOwner(
    role: DeviceOwner["type"],
    signal?: AbortSignal,
  ): Promise<string | null>;
}
