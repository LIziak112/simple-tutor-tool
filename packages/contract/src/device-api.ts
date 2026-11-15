import { z } from "zod";

/** 本机随机 UUID，不采集硬件标识或浏览器指纹。 */
export const DEVICE_ID_HEADER = "x-tutor-device-id";
export const DEVICE_INFO_HEADER = "x-tutor-device-info";
export const deviceTypeSchema = z.enum([
  "phone",
  "tablet",
  "desktop",
  "agent",
  "other",
]);
export const deviceRegisterSchema = z.object({
  deviceId: z.uuid(),
  type: deviceTypeSchema,
  os: z.string().trim().min(1).max(80).nullable().optional(),
  browser: z.string().trim().min(1).max(80).nullable().optional(),
  standalone: z.boolean().optional(),
});
export type DeviceRegister = z.infer<typeof deviceRegisterSchema>;
export const deviceRenameSchema = z.object({
  name: z.string().trim().min(1).max(80).nullable(),
});
/** 新 UI 的确认前提只约束合并意图，不代替 owner/session 鉴权。 */
export const deviceMergeIntentSchema = z.object({
  sourceDeviceId: z.uuid(),
  targetDeviceId: z.uuid(),
  allowActiveSource: z.boolean(),
});
export type DeviceMergeIntent = z.infer<typeof deviceMergeIntentSchema>;
export const DEVICE_MERGE_STALE = "DEVICE_MERGE_STALE";
export const deviceMergeSchema = z.object({
  targetDeviceId: z.uuid(),
  /** 旧调用可省略，保持历史别名语义；新 UI 必须发送实际确认的规范身份。 */
  intent: deviceMergeIntentSchema.optional(),
});
export const deviceSchema = z.object({
  deviceId: z.uuid(),
  type: deviceTypeSchema,
  os: z.string().nullable(),
  browser: z.string().nullable(),
  standalone: z.boolean(),
  automaticName: z.string(),
  name: z.string().nullable(),
  displayName: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  activeSessionCount: z.number().int().nonnegative(),
});
export type Device = z.infer<typeof deviceSchema>;
export const deviceListDataSchema = z.object({
  devices: z.array(deviceSchema),
  unassignedSessionCount: z.number().int().nonnegative(),
  /** 当前认证会话对应的本人规范设备；旧响应可缺，来源未知为 null。 */
  currentDeviceId: z.uuid().nullable().optional(),
});
export type DeviceListData = z.infer<typeof deviceListDataSchema>;
