import {
  DEFAULT_INK_PROFILE_CONFIG,
  type InkProfile,
  type InkProfileConfig,
  inkProfileConfigSchema,
} from "@tutor/contract";
import { useSyncExternalStore } from "react";
import { z } from "zod";
import { createExternalPrefStore } from "@/lib/create-external-pref-store";
import { setSessionInputPreference } from "./input-preference";
export interface InkProfileAccount {
  role: "student" | "teacher";
  id: string;
}
const selectionSchema = z.object({
  profileId: z.string().nullable(),
  name: z.string(),
  config: inkProfileConfigSchema,
});
type Selection = z.infer<typeof selectionSchema>;
const defaultSelection = (): Selection => ({
  profileId: null,
  name: "默认手感",
  config: DEFAULT_INK_PROFILE_CONFIG,
});
const store = createExternalPrefStore<Selection>(defaultSelection());
let account: InkProfileAccount | null = null;
const key = () =>
  account
    ? `ownclass:ink-profile:${JSON.stringify([location.origin, account.role, account.id])}`
    : null;
export function bindInkProfileAccount(next: InkProfileAccount | null) {
  if (account?.id === next?.id && account?.role === next?.role) return;
  account = next;
  try {
    const raw = key() ? localStorage.getItem(key() ?? "") : null;
    store.set(
      raw ? selectionSchema.parse(JSON.parse(raw)) : defaultSelection(),
    );
  } catch {
    store.set(defaultSelection());
  }
  setSessionInputPreference(store.get().config.inputMode);
}
export const getInkProfileSelection = () => store.get();
export const subscribeInkProfileSelection = (cb: () => void) =>
  store.subscribe(cb);
export const useInkProfileSelection = () =>
  useSyncExternalStore(
    subscribeInkProfileSelection,
    getInkProfileSelection,
    getInkProfileSelection,
  );
function write(next: Selection) {
  const storageKey = key();
  if (!storageKey) throw new Error("请登录后选用配置");
  localStorage.setItem(storageKey, JSON.stringify(next));
  store.set(next);
  setSessionInputPreference(next.config.inputMode);
}
export function selectInkProfile(profile: InkProfile) {
  write({ profileId: profile.id, name: profile.name, config: profile.config });
}
export function clearInkProfileSelection() {
  if (key()) write(defaultSelection());
  else store.set(defaultSelection());
}
/** 后台只更新设备已选配置；配置删除回默认，不替用户选择另一份。 */
export function reconcileInkProfiles(profiles: InkProfile[]) {
  const current = store.get();
  if (current.profileId === null) return;
  const matching = profiles.find((p) => p.id === current.profileId);
  if (!matching) clearInkProfileSelection();
  else if (
    JSON.stringify(matching.config) !== JSON.stringify(current.config) ||
    matching.name !== current.name
  )
    selectInkProfile(matching);
}
export function profileToolDefaults(): {
  color: InkProfileConfig["color"];
  size: InkProfileConfig["size"];
} {
  return getInkProfileSelection().config;
}
