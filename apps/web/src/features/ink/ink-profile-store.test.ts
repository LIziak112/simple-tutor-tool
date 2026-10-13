import { DEFAULT_INK_PROFILE_CONFIG } from "@tutor/contract";
import { expect, it } from "vitest";
import {
  bindInkProfileAccount,
  clearInkProfileSelection,
  getInkProfileSelection,
  selectInkProfile,
} from "./ink-profile-store";

it("设备选择按账号隔离并刷新恢复，删除回落默认", () => {
  localStorage.clear();
  const profile = {
    id: crypto.randomUUID(),
    name: "平板",
    revision: 1,
    updatedAt: "now",
    config: { ...DEFAULT_INK_PROFILE_CONFIG, smoothing: 0.2 },
  };
  bindInkProfileAccount({ role: "student", id: "a" });
  selectInkProfile(profile);
  bindInkProfileAccount({ role: "student", id: "b" });
  expect(getInkProfileSelection().profileId).toBeNull();
  bindInkProfileAccount({ role: "student", id: "a" });
  expect(getInkProfileSelection().config.smoothing).toBe(0.2);
  clearInkProfileSelection();
  expect(getInkProfileSelection().profileId).toBeNull();
});
