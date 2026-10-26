import {
  type StudentAiDisplayLayout,
  studentAiDisplayPreferenceSchema,
} from "@tutor/contract";
import { useSyncExternalStore } from "react";
import { createExternalPrefStore } from "@/lib/create-external-pref-store";

const store = createExternalPrefStore({
  accountId: null as string | null,
  layout: "inline" as StudentAiDisplayLayout,
});
const storageKey = (id: string) =>
  `ownclass:ai-display:${JSON.stringify([location.origin, "student", id])}`;
function read(raw: string | null): StudentAiDisplayLayout {
  try {
    return studentAiDisplayPreferenceSchema.parse(raw ? JSON.parse(raw) : {})
      .layout;
  } catch {
    return "inline";
  }
}
function publish(layout: StudentAiDisplayLayout) {
  if (store.get().layout !== layout) store.set({ ...store.get(), layout });
}

export function bindAiDisplayAccount(accountId: string | null) {
  if (store.get().accountId === accountId) return;
  let layout: StudentAiDisplayLayout = "inline";
  try {
    if (accountId) layout = read(localStorage.getItem(storageKey(accountId)));
  } catch {
    /* 存储不可读时仍可使用题下阅读。 */
  }
  store.set({ accountId, layout });
}
export const getAiDisplayPreference = store.get;
export const subscribeAiDisplayPreference = (cb: () => void) =>
  store.subscribe(cb);
export const useAiDisplayPreference = () =>
  useSyncExternalStore(subscribeAiDisplayPreference, store.get, store.get);

/** 写入成功才发布；捕获账号供设置草稿防止迟到保存串号。 */
export function saveAiDisplayPreference(
  layout: StudentAiDisplayLayout,
  expectedAccountId = store.get().accountId,
) {
  const { accountId } = store.get();
  if (!accountId || expectedAccountId !== accountId)
    throw new Error("账号已变化，请重新打开设置");
  const value = studentAiDisplayPreferenceSchema.parse({ layout });
  localStorage.setItem(storageKey(accountId), JSON.stringify(value));
  publish(value.layout);
}

window.addEventListener("storage", (event) => {
  const { accountId } = store.get();
  if (!accountId || event.storageArea !== localStorage) return;
  if (event.key === storageKey(accountId)) publish(read(event.newValue));
  else if (event.key === null) publish("inline");
});
