import { useCallback, useEffect, useRef, useState } from "react";
import { loginStudentByLinkApi } from "@/lib/api";
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
  const applyAuthed = useApplyStudentAuthed();
  const generation = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<EntryResult>({
    token,
    attempt: 0,
    status: "pending",
  });
  useEffect(() => {
    if (token.length === 0) return;
    const id = ++generation.current;
    const controller = new AbortController();
    const isCurrent = () =>
      generation.current === id && !controller.signal.aborted;
    setResult({ token, attempt, status: "pending" });
    async function exchange() {
      if (!isCurrent()) return;
      try {
        const student = await loginStudentByLinkApi(token, controller.signal);
        if (!isCurrent()) return;
        await applyAuthed(student, isCurrent);
        if (isCurrent()) setResult({ token, attempt, status: "success" });
      } catch (error) {
        if (isCurrent()) setResult({ token, attempt, status: "error", error });
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
  }, [token, attempt, applyAuthed]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const current = result.token === token && result.attempt === attempt;
  return {
    isPending: !current || result.status === "pending",
    isError: current && result.status === "error",
    error: result.status === "error" ? result.error : null,
    retry,
  };
}
