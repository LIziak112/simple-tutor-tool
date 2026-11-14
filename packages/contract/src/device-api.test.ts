import { describe, expect, it } from "vitest";
import { deviceListDataSchema, deviceMergeSchema } from "./device-api.ts";

describe("设备列表当前会话兼容", () => {
  it("旧服务端列表不需要当前设备", () => {
    expect(
      deviceListDataSchema.parse({ devices: [], unassignedSessionCount: 0 }),
    ).toEqual({ devices: [], unassignedSessionCount: 0 });
  });
  it("保留真实当前设备并允许未知", () => {
    const deviceId = "11111111-1111-4111-8111-111111111111";
    expect(
      deviceListDataSchema.parse({
        devices: [],
        unassignedSessionCount: 0,
        currentDeviceId: deviceId,
      }).currentDeviceId,
    ).toBe(deviceId);
    expect(
      deviceListDataSchema.parse({
        devices: [],
        unassignedSessionCount: 0,
        currentDeviceId: null,
      }).currentDeviceId,
    ).toBeNull();
  });
});

describe("设备合并确认契约", () => {
  const sourceDeviceId = "11111111-1111-4111-8111-111111111111";
  const targetDeviceId = "22222222-2222-4222-8222-222222222222";
  it("保留旧请求，同时完整保留新 UI 确认身份和活跃意图", () => {
    expect(deviceMergeSchema.parse({ targetDeviceId })).toEqual({
      targetDeviceId,
    });
    const input = {
      targetDeviceId,
      intent: { sourceDeviceId, targetDeviceId, allowActiveSource: false },
    };
    expect(deviceMergeSchema.parse(input)).toEqual(input);
  });
  it("新确认不能省略活跃意图或使用非 UUID 身份", () => {
    expect(
      deviceMergeSchema.safeParse({
        targetDeviceId,
        intent: { sourceDeviceId, targetDeviceId },
      }).success,
    ).toBe(false);
    expect(
      deviceMergeSchema.safeParse({
        targetDeviceId,
        intent: {
          sourceDeviceId: "伪造身份",
          targetDeviceId,
          allowActiveSource: true,
        },
      }).success,
    ).toBe(false);
  });
});
