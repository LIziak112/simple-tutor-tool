import { useCallback, useEffect, useRef, useState } from "react";
import {
  usePortalClients,
  usePortalRuntime,
} from "@/features/runtime/portal-runtime";

import { useApplyStudentAuthed } from "./student-auth";

type EntryResult = {
  readonly token: string;
  readonly attempt: number;
} & (
  | { readonly status: "pending" | "success" }
  | { readonly status: "error"; readonly error: unknown }
);

/** 一次页面入口拥有兑换和身份应用；结果不跨卸载缓存，也不以设备id提供认证。 */
export function useStudentLinkEntry(token: string) {
  const { loginStudentByLinkApi } = usePortalClients();

  const applyAuthed = useApplyStudentAuthed();
  const { signal } = usePortalRuntime();
  // 每次入口setup只捕获当时的操作；自身写入me导致Host换租约不重做兑换。
  // ref只供下一次token/重试setup取快照，在途exchange不读取后来的端口。
  const operations = useRef({ loginStudentByLinkApi, applyAuthed, signal });
  operations.current = { loginStudentByLinkApi, applyAuthed, signal };
  const generation = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<EntryResult>({
    token,
    attempt: 0,
    status: "pending",
  });
  useEffect(() => {
    if (token.length === 0) return;
    const { loginStudentByLinkApi, applyAuthed, signal } = operations.current;
    const id = ++generation.current;
    const controller = new AbortController();
    const ownsEntry = () =>
      generation.current === id && !controller.signal.aborted;
    const isCurrent = () => ownsEntry() && !signal.aborted;
    setResult({ token, attempt, status: "pending" });
    async function exchange() {
      if (!isCurrent()) return;
      try {
        const student = await loginStudentByLinkApi(token, controller.signal);
        if (!isCurrent()) return;
        const applied = await applyAuthed(student, isCurrent);
        // 身份已由本入口成功提交后，自己的Host换租约不应重新兑换；
        // 提交前外部换主体仍由捕获的旧signal阻止clear和写缓存。
        if (!ownsEntry()) return;
        if (applied) setResult({ token, attempt, status: "success" });
        else
          setResult({ token, attempt, status: "error", error: signal.reason });
      } catch (error) {
        if (ownsEntry()) setResult({ token, attempt, status: "error", error });
      }
    }
    // 已cleanup的setup不获取网络资源；StrictMode的新setup照常兑换并接收完成。
    queueMicrotask(() => {
      void exchange();
    });
    return () => {
      generation.current++;
      controller.abort();
    };
  }, [token, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const current = result.token === token && result.attempt === attempt;
  return {
    isPending: !current || result.status === "pending",
    isError: current && result.status === "error",
    error: result.status === "error" ? result.error : null,
    retry,
  };
}
