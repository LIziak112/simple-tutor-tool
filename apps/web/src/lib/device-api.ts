import { defaultClientServices } from "@/portals/clients/default-services";

export type * from "@/features/runtime/ports/devices-types";
export const listDevicesApi = defaultClientServices.listDevicesApi;
export const renameDeviceApi = defaultClientServices.renameDeviceApi;
export const mergeDevicesApi = defaultClientServices.mergeDevicesApi;
export const revokeDeviceSessionsApi =
  defaultClientServices.revokeDeviceSessionsApi;
export const revokeUnassignedSessionsApi =
  defaultClientServices.revokeUnassignedSessionsApi;
export const readDeviceSessionOwner =
  defaultClientServices.readDeviceSessionOwner;
