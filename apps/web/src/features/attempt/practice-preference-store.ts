import {
  type PracticeFeedbackMode,
  type PracticeLayout,
  studentPracticePreferenceSchema,
} from "@tutor/contract";
import { useSyncExternalStore } from "react";
import { createExternalPrefStore } from "@/lib/create-external-pref-store";

/**
 * 做题方式本设备偏好（M3-D1，2026-10-22 计划 §7.1；M5-D2 反馈节奏接线）：
 * 默认布局 + 快捷键开关 + 反馈节奏（可未设置）。
 * - feedback: null = 未设置 = localStorage 键缺省（禁伪造默认值）——建卷请求
 *   不携带 feedbackMode，服务端按 学生缺省/文档推荐/教师限制 裁决；保存布局
 *   不补写 feedback，否则首次存布局就把文档推荐挡死（M5-D2 预裁决①）。
 *   存量 M3 偏好文件都带 feedback（保存动作一直写全量形态），天然视作已设置；
 * - localStorage 仅落契约 strict v1 形态，按部署来源、student 角色、账号隔离；
 * - 存储不可读/损坏回默认（列表 + 快捷键开 + 未设置），不抛错、不阻断作答；
 *   写入失败抛错由设置区提示，本次会话内仍可用内存值；
 * - 仿 ai-display-preference-store 先例（模块级 store + 账号绑定 + 跨标签事件）。
 */

const defaultPreference = {
  layout: "list" as PracticeLayout,
  keyboardShortcuts: true,
  feedback: null as PracticeFeedbackMode | null,
};

export interface PracticePreferenceState {
  accountId: string | null;
  layout: PracticeLayout;
  keyboardShortcuts: boolean;
  /** null = 未设置（storage 键缺省）；已设置 = 学生明确保存过的反馈节奏 */
  feedback: PracticeFeedbackMode | null;
}

const store = createExternalPrefStore({
  accountId: null as string | null,
  ...defaultPreference,
});
const storageKey = (id: string) =>
  `ownclass:practice-pref:${JSON.stringify([location.origin, "student", id])}`;

function read(raw: string | null) {
  try {
    return studentPracticePreferenceSchema.parse(raw ? JSON.parse(raw) : {});
  } catch {
    return { version: 1, ...defaultPreference };
  }
}

function publish(value: {
  layout: PracticeLayout;
  keyboardShortcuts: boolean;
  feedback: PracticeFeedbackMode | null;
}) {
  const current = store.get();
  if (
    current.layout === value.layout &&
    current.keyboardShortcuts === value.keyboardShortcuts &&
    current.feedback === value.feedback
  )
    return;
  store.set({ ...current, ...value });
}

/** 登录/身份变化时绑定账号并读取该账号的持久化偏好（存储不可用回默认） */
export function bindPracticePreferenceAccount(accountId: string | null) {
  if (store.get().accountId === accountId) return;
  let value = { ...defaultPreference };
  try {
    if (accountId) {
      const parsed = read(localStorage.getItem(storageKey(accountId)));
      value = {
        layout: parsed.layout,
        keyboardShortcuts: parsed.keyboardShortcuts,
        feedback: parsed.feedback ?? null,
      };
    }
  } catch {
    /* 存储不可读时沿用默认偏好，不阻断作答 */
  }
  store.set({ accountId, ...value });
}

export const getPracticePreference = store.get;
export const subscribePracticePreference = (cb: () => void) =>
  store.subscribe(cb);
export const usePracticePreference = () =>
  useSyncExternalStore(subscribePracticePreference, store.get, store.get);

/**
 * 保存默认偏好：写入成功才发布；expectedAccountId 供设置草稿防迟到保存串号。
 * feedback 保持当前值原样（未设置 = 键缺省不补写；已设置 = 原值保留），契约
 * v1 形态由 schema 校验。
 */
export function savePracticePreference(
  input: { layout: PracticeLayout; keyboardShortcuts: boolean },
  expectedAccountId: string | null = store.get().accountId,
) {
  const { accountId, feedback } = store.get();
  if (accountId === null || expectedAccountId !== accountId)
    throw new Error("账号已变化，请重新打开设置");
  const value = studentPracticePreferenceSchema.parse({
    version: 1,
    layout: input.layout,
    ...(feedback !== null ? { feedback } : {}),
    keyboardShortcuts: input.keyboardShortcuts,
  });
  localStorage.setItem(storageKey(accountId), JSON.stringify(value));
  publish({
    layout: value.layout,
    keyboardShortcuts: value.keyboardShortcuts,
    feedback: value.feedback ?? null,
  });
}

window.addEventListener("storage", (event) => {
  const { accountId } = store.get();
  if (accountId === null || event.storageArea !== localStorage) return;
  if (event.key === storageKey(accountId)) {
    const parsed = read(event.newValue);
    publish({
      layout: parsed.layout,
      keyboardShortcuts: parsed.keyboardShortcuts,
      feedback: parsed.feedback ?? null,
    });
  } else if (event.key === null) {
    publish({ ...defaultPreference });
  }
});
