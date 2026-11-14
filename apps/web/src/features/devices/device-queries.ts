import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { captureAccountIdentity } from "@/features/auth/account-identity";
import { AuthCancelledError } from "@/features/auth/auth-operation";
import { usePortalClients } from "@/features/runtime/portal-runtime";
import type { DeviceOwner } from "@/features/runtime/ports/devices-types";

export const deviceListKey = (owner: DeviceOwner) =>
  [owner.type, "devices", owner.id] as const;
export function useDevices(owner: DeviceOwner) {
  const { listDevicesApi } = usePortalClients();

  return useQuery({
    queryKey: deviceListKey(owner),
    queryFn: ({ signal }) => listDevicesApi(owner.type, signal),
    retry: false,
  });
}
export type DeviceAction =
  | { kind: "rename"; id: string; name: string | null }
  | { kind: "merge"; source: string; target: string; allowActive: boolean }
  | { kind: "revoke"; id: string; current: boolean }
  | { kind: "unassigned" };

export function useDeviceActions(
  owner: DeviceOwner,
  onRevoked: (isCurrent: () => boolean) => Promise<void>,
) {
  const {
    renameDeviceApi,
    mergeDevicesApi,
    revokeUnassignedSessionsApi,
    revokeDeviceSessionsApi,
    readDeviceSessionOwner,
  } = usePortalClients();

  const client = useQueryClient();
  type Identity = ReturnType<typeof captureAccountIdentity>;
  type Result = { message: string; revoked: boolean; scope: string };
  const identities = useRef(new WeakMap<Result, Identity>());
  const pendingIdentities = useRef(new Set<Identity>());
  const finishIdentity = (identity: Identity) => {
    identity.finish();
    pendingIdentities.current.delete(identity);
  };
  const pending = useRef(new Set<AbortController>());
  const active = useRef<string | null>(null);
  const { type, id } = owner;
  useEffect(() => {
    active.current = `${type}:${id}`;
    return () => {
      active.current = null;
      for (const controller of pending.current) controller.abort();
      pending.current.clear();
      for (const identity of pendingIdentities.current) identity.finish();
      pendingIdentities.current.clear();
    };
  }, [type, id]);
  return useMutation({
    mutationKey: [...deviceListKey(owner), "write"],
    retry: false,
    mutationFn: async (action: DeviceAction) => {
      const controller = new AbortController();
      pending.current.add(controller);
      const { signal } = controller;
      const scope = `${type}:${id}`;
      const identity = captureAccountIdentity(client, type);
      pendingIdentities.current.add(identity);
      const withIdentity = (value: Result) => {
        identities.current.set(value, identity);
        return value;
      };
      try {
        signal.throwIfAborted();
        let message: string;
        let revoked = false;
        if (action.kind === "rename") {
          await renameDeviceApi(owner.type, action.id, action.name, signal);
          message = action.name === null ? "已恢复自动名称" : "设备名称已保存";
        } else if (action.kind === "merge") {
          await mergeDevicesApi(
            owner.type,
            action.source,
            action.target,
            signal,
            {
              sourceDeviceId: action.source,
              targetDeviceId: action.target,
              allowActiveSource: action.allowActive,
            },
          );
          message = "设备记录已合并，保留设备的名称不变";
        } else {
          const result =
            action.kind === "unassigned"
              ? await revokeUnassignedSessionsApi(owner.type, signal)
              : await revokeDeviceSessionsApi(owner.type, action.id, signal);
          signal.throwIfAborted();
          message = `已移除${result.revoked}条浏览器登录记录`;
          revoked = action.kind === "revoke" && action.current;
          if (!revoked) {
            let actual: string | null;
            try {
              actual = await readDeviceSessionOwner(owner.type, signal);
            } catch (error) {
              signal.throwIfAborted();
              if (error instanceof Error && error.name === "AbortError")
                throw error;
              // 删除已经成功，核对失败不能抹掉实际回执或冒称登录已失效。
              return withIdentity({
                message: `${message}；暂时无法确认当前登录状态，请刷新页面`,
                revoked: false,
                scope,
              });
            }
            signal.throwIfAborted();
            if (actual === null) revoked = true;
            else if (actual !== owner.id)
              throw new Error("账号已变化，请刷新后管理当前账号的设备");
          }
        }
        signal.throwIfAborted();
        return withIdentity({ message, revoked, scope });
      } catch (error) {
        finishIdentity(identity);
        throw error;
      } finally {
        pending.current.delete(controller);
      }
    },
    onSuccess: async (result) => {
      const identity = identities.current.get(result);
      try {
        if (active.current !== result.scope) return;
        if (result.revoked) {
          if (!identity?.isCurrent()) throw new AuthCancelledError();
          await onRevoked(
            () => active.current === result.scope && identity.isCurrent(),
          );
        } else
          await client.invalidateQueries({
            queryKey: deviceListKey(owner),
            exact: true,
          });
      } finally {
        if (identity) finishIdentity(identity);
      }
    },
    onError: async (_error, action) => {
      if (active.current === `${type}:${id}` && action.kind === "merge") {
        await client.invalidateQueries({
          queryKey: deviceListKey(owner),
          exact: true,
        });
      }
    },
  });
}
