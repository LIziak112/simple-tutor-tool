import { useSyncExternalStore } from "react";
import { createExternalPrefStore } from "@/lib/create-external-pref-store";

/**
 * 题组材料排版偏好（左右分栏 split / 列表形式 stack）：
 * - 按部署来源、student 角色、账号隔离持久化到 localStorage（仿
 *   practice-preference-store 先例——公用设备上不跨账号泄漏布局偏好）；
 * - 账号变化经 bindGroupMaterialLayoutAccount 统一重读；跨标签页经 storage
 *   事件同步（校验 storageArea）；
 * - 存储不可读/写入失败不抛错，本次会话内仍以内存值生效；默认 split。
 */
export type GroupMaterialLayout = "split" | "stack";

const DEFAULT_LAYOUT: GroupMaterialLayout = "split";

const storageKey = (id: string) =>
  `ownclass:group-material-layout:${JSON.stringify([location.origin, "student", id])}`;

interface GroupMaterialLayoutState {
  accountId: string | null;
  layout: GroupMaterialLayout;
}

const store = createExternalPrefStore<GroupMaterialLayoutState>({
  accountId: null,
  layout: DEFAULT_LAYOUT,
});

function readStoredLayout(accountId: string): GroupMaterialLayout {
  try {
    const val = window.localStorage?.getItem(storageKey(accountId));
    if (val === "stack" || val === "split") return val;
  } catch {
    /* 存储不可读（禁用第三方 Cookie/沙箱）回默认，不阻断渲染 */
  }
  return DEFAULT_LAYOUT;
}

/** 登录/身份变化时绑定账号并读取该账号的持久化布局（存储不可用回默认） */
export function bindGroupMaterialLayoutAccount(accountId: string | null): void {
  if (store.get().accountId === accountId) return;
  store.set({
    accountId,
    layout: accountId === null ? DEFAULT_LAYOUT : readStoredLayout(accountId),
  });
}

export function getGroupMaterialLayout(): GroupMaterialLayout {
  return store.get().layout;
}

export function setGroupMaterialLayout(layout: GroupMaterialLayout): void {
  const { accountId } = store.get();
  if (accountId !== null) {
    try {
      window.localStorage?.setItem(storageKey(accountId), layout);
    } catch {
      /* 写入失败不抛错，本次会话内仍更新内存 store */
    }
  }
  store.set({ accountId, layout });
}

export function useGroupMaterialLayout(): [
  GroupMaterialLayout,
  (layout: GroupMaterialLayout) => void,
] {
  const layout = useSyncExternalStore(
    store.subscribe,
    () => store.get().layout,
    () => DEFAULT_LAYOUT,
  );
  return [layout, setGroupMaterialLayout];
}

/** 仅供单元测试重置 store 状态 */
export function _resetGroupMaterialLayoutStoreForTest(): void {
  store.set({ accountId: null, layout: DEFAULT_LAYOUT });
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    try {
      if (event.storageArea !== window.localStorage) return;
      const { accountId } = store.get();
      if (accountId === null) return;
      if (event.key === storageKey(accountId)) {
        const val = event.newValue;
        store.set({
          accountId,
          layout: val === "stack" || val === "split" ? val : DEFAULT_LAYOUT,
        });
      } else if (event.key === null) {
        store.set({ accountId, layout: DEFAULT_LAYOUT });
      }
    } catch {
      /* 事件处理异常静默防御 */
    }
  });
}
