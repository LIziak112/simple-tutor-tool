import { useQueryClient } from "@tanstack/react-query";
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { getDraftSessionEpoch } from "@/features/attempt/draft-store";

/** 角色内存只保存输入：页面内同步更新，切设置后恢复；退出清student缓存。 */
export function useAiDraftMap<Value>(
  kind: "question" | "followup",
  attemptId: string,
) {
  const client = useQueryClient();
  const sessionEpoch = getDraftSessionEpoch();
  const key = useMemo(
    () => ["student", "ai-workspace-draft", kind, attemptId] as const,
    [kind, attemptId],
  );
  const [state, setState] = useState(() => ({
    owner: attemptId,
    values:
      client.getQueryData<ReadonlyMap<string, Value>>(key) ??
      new Map<string, Value>(),
  }));
  // 作答身份变化时同步切换本地输入，避免旧值在一次effect间隙写进新卷缓存。
  if (state.owner !== attemptId) {
    setState({
      owner: attemptId,
      values:
        client.getQueryData<ReadonlyMap<string, Value>>(key) ??
        new Map<string, Value>(),
    });
  }
  useEffect(() => {
    if (state.owner !== attemptId || getDraftSessionEpoch() !== sessionEpoch)
      return;
    client.setQueryDefaults(key, { gcTime: Infinity });
    client.setQueryData(key, state.values);
  }, [client, key, state, attemptId, sessionEpoch]);
  const update = useCallback(
    (action: SetStateAction<ReadonlyMap<string, Value>>) => {
      if (getDraftSessionEpoch() !== sessionEpoch) return;
      setState((previous) => {
        if (previous.owner !== attemptId) return previous;
        return {
          owner: attemptId,
          values:
            typeof action === "function" ? action(previous.values) : action,
        };
      });
    },
    [attemptId, sessionEpoch],
  );
  return [state.values, update] as const;
}
