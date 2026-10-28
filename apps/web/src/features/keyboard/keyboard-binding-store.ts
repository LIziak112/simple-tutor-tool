import { studentKeyboardBindingsSchema } from "@tutor/contract";
import { useSyncExternalStore } from "react";
import { createExternalPrefStore } from "@/lib/create-external-pref-store";
import {
  PRACTICE_KEYBOARD_COMMANDS,
  type ResolvedKeyBindings,
  resolveBindings,
} from "./command-registry";

/**
 * 键位绑定本设备偏好 store（2026-10-28 快捷键体系升级，仿
 * practice-preference-store 先例：模块级 store + 账号绑定 + 跨标签事件）：
 * - localStorage 仅落契约 strict v1 形态，键按部署来源、student 角色、账号隔离；
 *   键位属个人使用偏好，只存本设备（默认键位全设备一致，自定义不跨设备）；
 * - 损坏 / 未来 version / 存储不可读整体回默认键位（= 空覆盖表），不抛错、
 *   不阻断作答；写入失败抛错由设置区提示；
 * - 冲突校验归设置页 UI（store 只管持久化与发布）；
 * - 生效键位（resolved）在每次发布时计算一次并缓存——useSyncExternalStore
 *   的 getSnapshot 要求引用稳定，不能每次调用重算新对象。
 */

export interface KeyboardBindingState {
  accountId: string | null;
  /** 契约覆盖表原样（形状已由 schema 保证；未知 commandId 由 resolveBindings 丢弃） */
  bindings: Readonly<Record<string, readonly string[]>>;
}

const store = createExternalPrefStore<KeyboardBindingState>({
  accountId: null,
  bindings: {},
});
let resolvedCache: ResolvedKeyBindings = resolveBindings(
  PRACTICE_KEYBOARD_COMMANDS,
  {},
);

const storageKey = (id: string) =>
  `ownclass:keyboard-bindings:${JSON.stringify([location.origin, "student", id])}`;

/** 唯一 schema 解析入口：坏 JSON / 未来 version / 形态不符整体回空覆盖表 */
function read(
  raw: string | null,
): Readonly<Record<string, readonly string[]>> {
  if (raw === null) return {};
  try {
    return studentKeyboardBindingsSchema.parse(JSON.parse(raw)).bindings;
  } catch {
    return {};
  }
}

function commit(state: KeyboardBindingState): void {
  const current = store.get();
  if (
    current.accountId === state.accountId &&
    JSON.stringify(current.bindings) === JSON.stringify(state.bindings)
  )
    return;
  store.set(state);
  resolvedCache = resolveBindings(PRACTICE_KEYBOARD_COMMANDS, state.bindings);
}

/** 登录/身份变化时绑定账号并读取该账号的持久化键位（存储不可用回默认） */
export function bindKeyboardBindingsAccount(accountId: string | null) {
  if (store.get().accountId === accountId) return;
  let bindings: Readonly<Record<string, readonly string[]>> = {};
  try {
    if (accountId) {
      bindings = read(localStorage.getItem(storageKey(accountId)));
    }
  } catch {
    /* 存储不可读时沿用默认键位，不阻断作答 */
  }
  commit({ accountId, bindings });
}

export const getKeyboardBindings = store.get;
export const subscribeKeyboardBindings = (cb: () => void) =>
  store.subscribe(cb);

/** 解析后的生效键位（默认 + 覆盖 + 固定命令；发布时缓存） */
export function getResolvedKeyboardBindings(): ResolvedKeyBindings {
  return resolvedCache;
}

/** 生效键位订阅式读（作答页派发、帮助面板与设置页展示共用） */
export function useKeyboardBindings(): ResolvedKeyBindings {
  return useSyncExternalStore(
    subscribeKeyboardBindings,
    getResolvedKeyboardBindings,
    getResolvedKeyboardBindings,
  );
}

/** 覆盖表原样订阅式读（设置页草稿基底与 dirty/baseChanged 比较用） */
export function useKeyboardBindingState(): KeyboardBindingState {
  return useSyncExternalStore(
    subscribeKeyboardBindings,
    store.get,
    store.get,
  );
}

/**
 * 保存覆盖表（整组替换）：写入成功才发布；expectedAccountId 供设置草稿防
 * 迟到保存串号。冲突检测不在此处（UI 职责），但 schema 仍兜底拒绝非法键位。
 */
export function saveKeyboardBindings(
  bindings: Readonly<Record<string, readonly string[]>>,
  expectedAccountId: string | null = store.get().accountId,
) {
  const { accountId } = store.get();
  if (accountId === null || expectedAccountId !== accountId)
    throw new Error("账号已变化，请重新打开设置");
  const value = studentKeyboardBindingsSchema.parse({
    version: 1,
    bindings,
  });
  localStorage.setItem(storageKey(accountId), JSON.stringify(value));
  commit({ accountId, bindings: value.bindings });
}

window.addEventListener("storage", (event) => {
  const { accountId } = store.get();
  if (accountId === null || event.storageArea !== localStorage) return;
  if (event.key === storageKey(accountId)) {
    commit({ accountId, bindings: read(event.newValue) });
  } else if (event.key === null) {
    commit({ accountId, bindings: {} });
  }
});
