import { useRef } from "react";
import { randomUuid } from "./uuid";

/** 请求结果未知时，同一页面中的同一确认意图沿用原操作标识。 */
export function useReplayableCreate() {
  const pending = useRef<{ intent: string; operationId: string } | null>(null);
  return async function create<T>(
    input: unknown,
    send: (operationId: string) => Promise<T>,
  ): Promise<T> {
    const intent = JSON.stringify(input);
    const operation =
      pending.current?.intent === intent
        ? pending.current
        : { intent, operationId: randomUuid() };
    pending.current = operation;
    const result = await send(operation.operationId);
    if (pending.current === operation) pending.current = null;
    return result;
  };
}
