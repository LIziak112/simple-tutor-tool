import { useEffect } from "react";
import { ApiError } from "@/lib/api";
import { fetchInkProfiles } from "./ink-profile-api";
import {
  bindInkProfileAccount,
  type InkProfileAccount,
  reconcileInkProfiles,
} from "./ink-profile-store";
/** 账号接线置于布局，离线保留设备选择；旧账号迟到响应不得修改新账号。 */
export function useBindInkProfiles(
  role: InkProfileAccount["role"],
  id: string | undefined,
) {
  useEffect(() => {
    let active = true;
    if (!id) {
      bindInkProfileAccount(null);
      return;
    }
    const account = { role, id };
    bindInkProfileAccount(account);
    void fetchInkProfiles(account)
      .then((profiles) => {
        if (active) reconcileInkProfiles(profiles);
      })
      .catch((error) => {
        if (
          active &&
          error instanceof ApiError &&
          error.code === "UNAUTHORIZED"
        )
          bindInkProfileAccount(null);
      });
    return () => {
      active = false;
      bindInkProfileAccount(null);
    };
  }, [role, id]);
}
