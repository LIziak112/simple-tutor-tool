import { useQueryClient } from "@tanstack/react-query";
import type { PersonalSessionData, PersonalSessionRole } from "@tutor/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePortalClients } from "@/features/runtime/portal-runtime";
import type { ApiServices } from "@/features/runtime/ports/api-services";
import { ApiError } from "@/lib/api-response";
import {
  AuthCancelledError,
  type AuthOperation,
  createAuthOperation,
} from "./auth-operation";

type Status = "pending" | "verified" | "login" | "error";
interface Verification {
  clients: ApiServices;
  id: string;
  role: PersonalSessionRole;
  revision: number;
  status: Status;
  error?: Error;
  operation: AuthOperation;
}
/** 核验结果只属于捕获的客户端租约；不建立第三份身份缓存。 */
export function usePersonalPair(
  role: PersonalSessionRole,
  id: string | null,
  onVerified: (
    pair: PersonalSessionData,
    operation: AuthOperation,
  ) => Promise<void> | void,
) {
  const clients = usePortalClients();
  const cache = useQueryClient();
  const primaryId = cache.getQueryData<{ id: string }>([role, "me"])?.id;
  const peerId = cache.getQueryData<{ id: string }>([
    role === "student" ? "teacher" : "student",
    "me",
  ])?.id;
  const callback = useRef(onVerified);
  callback.current = onVerified;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Verification | null>(null);
  useEffect(() => {
    if (id === null || primaryId !== id) return;
    let active = true;
    const operation = createAuthOperation(cache);
    const expectedPeer = peerId;
    const identity = { clients, id, role, revision, operation };
    void clients
      .checkPersonalSessionApi(role)
      .then(async (pair) => {
        if (!active) return;
        operation.assertCurrent();
        if (
          cache.getQueryData<{ id: string }>([
            role === "student" ? "teacher" : "student",
            "me",
          ])?.id !== expectedPeer
        )
          throw new Error("账号状态已变化，请重试");
        if (pair === null) {
          setResult({ ...identity, status: "login" });
          return;
        }
        if (pair[role].id !== id) throw new Error("账号已变化，请重新登录");
        await callback.current(pair, operation);
        operation.assertCurrent();
        if (active) setResult({ ...identity, status: "verified" });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const current = operation.isCurrent();
        const failure = current
          ? error instanceof Error
            ? error
            : new Error("会话核验失败，请重试")
          : new AuthCancelledError();
        const status =
          current && error instanceof ApiError && error.status === 401
            ? "login"
            : "error";
        // 登录结果留门到实际导航消费；普通错误不再使用本次凭据。
        if (status === "error") operation.finish();
        setResult({ ...identity, status, error: failure });
      });
    return () => {
      active = false;
      operation.finish();
    };
  }, [clients, id, role, revision, cache, primaryId, peerId]);
  const current =
    result?.clients === clients &&
    result.id === id &&
    result.role === role &&
    result.revision === revision
      ? result
      : null;
  const consumeLogin = useCallback(
    (navigate: () => void) => {
      if (current?.status !== "login") return;
      try {
        current.operation.consume(navigate);
      } catch (error) {
        if (!(error instanceof AuthCancelledError)) throw error;
        setResult({ ...current, status: "error", error });
      } finally {
        current.operation.finish();
      }
    },
    [current],
  );
  return {
    status:
      (current?.status === "verified" || current?.status === "login") &&
      !current.operation.isCurrent()
        ? "error"
        : (current?.status ?? "pending"),
    error:
      current &&
      (current.status === "verified" || current.status === "login") &&
      !current.operation.isCurrent()
        ? new AuthCancelledError()
        : current?.error,
    consumeLogin,
    retry: () => setRevision((n) => n + 1),
  };
}
