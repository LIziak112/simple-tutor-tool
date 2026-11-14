import type { PersonalSessionData, PersonalSessionRole } from "@tutor/contract";
import { useEffect, useRef, useState } from "react";
import { usePortalClients } from "@/features/runtime/portal-runtime";
import type { ApiServices } from "@/features/runtime/ports/api-services";
import { ApiError } from "@/lib/api-response";

type Status = "pending" | "verified" | "login" | "error";
interface Verification {
  clients: ApiServices;
  id: string;
  role: PersonalSessionRole;
  revision: number;
  status: Status;
  error?: Error;
}
/** 核验结果只属于捕获的客户端租约；不建立第三份身份缓存。 */
export function usePersonalPair(
  role: PersonalSessionRole,
  id: string | null,
  onVerified: (pair: PersonalSessionData) => Promise<void> | void,
) {
  const clients = usePortalClients();
  const callback = useRef(onVerified);
  callback.current = onVerified;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Verification | null>(null);
  useEffect(() => {
    if (id === null) return;
    let active = true;
    const identity = { clients, id, role, revision };
    void clients
      .checkPersonalSessionApi(role)
      .then(async (pair) => {
        if (!active) return;
        if (pair === null) {
          setResult({ ...identity, status: "login" });
          return;
        }
        if (pair[role].id !== id) throw new Error("账号已变化，请重新登录");
        await callback.current(pair);
        if (active) setResult({ ...identity, status: "verified" });
      })
      .catch((error: unknown) => {
        if (active)
          setResult({
            ...identity,
            status:
              error instanceof ApiError && error.status === 401
                ? "login"
                : "error",
            error:
              error instanceof Error
                ? error
                : new Error("会话核验失败，请重试"),
          });
      });
    return () => {
      active = false;
    };
  }, [clients, id, role, revision]);
  const current =
    result?.clients === clients &&
    result.id === id &&
    result.role === role &&
    result.revision === revision
      ? result
      : null;
  return {
    status: current?.status ?? "pending",
    error: current?.error,
    retry: () => setRevision((n) => n + 1),
  };
}
