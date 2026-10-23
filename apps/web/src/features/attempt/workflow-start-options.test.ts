import { beforeEach, expect, it, vi } from "vitest";
import { workflowStartOptions } from "./attempt-queries";
import {
  bindPracticePreferenceAccount,
  getPracticePreference,
  savePracticePreference,
} from "./practice-preference-store";

/**
 * 建卷工作流选项发送链（M5-D2）：workflowVersion=1 恒显式（进入新协议）；
 * feedbackMode 只在偏好**已设置**时携带——未设置（null）整个键不发，
 * 服务端按 学生缺省/文档推荐/教师限制 裁决（总计划 §5.4）。M3 存量全量
 * 形态（带 feedback）视作已设置照发；保存布局不补写 feedback（推荐不被
 * 本地伪造偏好挡死）。
 */

beforeEach(() => {
  localStorage.clear();
  bindPracticePreferenceAccount(null);
  vi.restoreAllMocks();
});

it("未设置偏好：只发 workflowVersion=1，不含 feedbackMode 键", () => {
  bindPracticePreferenceAccount("a");
  const options = workflowStartOptions();
  expect(options).toEqual({ workflowVersion: 1 });
  expect("feedbackMode" in options).toBe(false);
});

it("已设置偏好（含 M3 存量形态）：feedbackMode 随请求携带", () => {
  localStorage.setItem(
    `ownclass:practice-pref:${JSON.stringify([location.origin, "student", "a"])}`,
    JSON.stringify({
      version: 1,
      layout: "list",
      feedback: "after_attempt",
      keyboardShortcuts: true,
    }),
  );
  bindPracticePreferenceAccount("a");
  expect(workflowStartOptions()).toEqual({
    workflowVersion: 1,
    feedbackMode: "after_attempt",
  });
});

it("保存布局后 feedback 仍缺省：发送链保持不带 feedbackMode（推荐不被挡死）", () => {
  bindPracticePreferenceAccount("a");
  savePracticePreference({ layout: "single", keyboardShortcuts: true });
  expect(getPracticePreference().feedback).toBeNull();
  expect(workflowStartOptions()).toEqual({ workflowVersion: 1 });
});
