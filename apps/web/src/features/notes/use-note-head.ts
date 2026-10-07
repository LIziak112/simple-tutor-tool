/**
 * 笔记头拉取与恢复接线（T6R.9，方案 §8「GET notes 工作稿头」；T6R.14 起拉取
 * 经批量端点合批）：答题页每道可草稿题挂一次本 hook——
 *
 * - head 拉取成功 → 播种共享核（note-seed.seedRecordFromServerHead，
 *   闸门修复 F1 抽取）：notCreated 显式空态（note=null）以 baseRevision=0
 *   起步不拉正文；**条件拉正文**（本地无记录 / note 归属变更 / 服务端
 *   revision 领先时才 GET 版本文档并 applyServerLoad 播种；**先 fetch 成功
 *   才落 head 对齐**，失败不动本地状态、下次 head 重拉重试——工作稿=服务端
 *   稿；本地未同步稿经 noteDocsEqual 比较保留，不会被覆盖）。本地同 base
 *   且有 pending（本地领先）不拉——省请求，上传自然追平；
 * - **补图触发**（T6R.6「学生重新进入时触发」）：head 的 images 含
 *   failed/missing → recoverNoteImages 重建补传（不 await：补图不阻塞
 *   head 应用；确定性渲染 + 槽位幂等 upsert，重入安全）。UI 侧的
 *   「图片待生成/失败重试」入口见 NoteLayer（正文 synced 图片 failed 的
 *   手动重试同 recoverNoteImages）。
 *
 * 副作用放在 queryFn 内（react-query v5 无 query onSuccess）：缓存命中不
 * 重放副作用；失败重试由 react-query 退避（ApiError 不重试——权限/终态类
 * 错误重试无意义，网络错误重试 2 次）。head 失败不阻塞本地作答——四维状态
 * 的 server 维度来自同步队列视角（note-store 派生），不依赖 head。
 *
 * 批量合批（T6R.14）：逐题 GET 在二十题卷上是 N 个请求，queryFn 的网络段
 * 经 lib/note-head-batch 的 fetchStudentNoteHeadCoalesced 在宏任务边界合并
 * 为一次批量 POST（合批协调器在传输层小模块）；副作用与重试语义不变。
 */
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { NoteHeadData } from "@tutor/contract";
import { useSyncExternalStore } from "react";
import { seedRecordFromServerHead } from "@/features/notes/note-seed";
import {
  type NoteScope,
  type NoteSessionRef,
  subscribeNoteStore,
} from "@/features/notes/note-store";
import { currentNoteSession } from "@/features/notes/note-sync";
import { ApiError } from "@/lib/api";
import { fetchStudentNoteHeadCoalesced } from "@/lib/note-head-batch";

/**
 * 订阅当前草稿会话（bind/unbind 经 note-store 的全量通知重取快照）。
 * NoteLayer/useNoteHead 共用：会话未绑定（standby）时一切笔记 UI 静默。
 */
/** 订阅/快照模块常量（复审⑮）：无组件态，多消费方共享同一对函数 */
const SUBSCRIBE_NOTE_SESSION = (listener: () => void): (() => void) =>
  subscribeNoteStore(() => listener());
const GET_NOTE_SESSION = (): NoteSessionRef | null => currentNoteSession();

export function useNoteSessionRef(): NoteSessionRef | null {
  // 通知带 key、React 监听器无参——包一层；getSnapshot 返回模块单例引用，
  // 非会话变更的键级通知不会引发重渲染（引用相等）
  return useSyncExternalStore(
    SUBSCRIBE_NOTE_SESSION,
    GET_NOTE_SESSION,
    GET_NOTE_SESSION,
  );
}

/** head 查询键（含学生 id：切账号不回放缓存的他人 head） */
export const studentNoteHeadKey = (
  studentId: string,
  attemptId: string,
  questionId: string,
) => ["student", studentId, "note-head", attemptId, questionId] as const;

/** head 应用与条件恢复（queryFn 内执行；导出供测试直调）——播种共享核的
 * scratch 接线（真实 head + 补图触发；时序与失败重试语义见 note-seed） */
export async function applyNoteHeadSideEffects(
  session: NoteSessionRef,
  scope: NoteScope,
  head: NoteHeadData,
): Promise<void> {
  await seedRecordFromServerHead(session, scope, head, { recoverImages: true });
}

/**
 * 答题页每题的笔记头接线（NoteLayer 内部调用）。返回 useQuery 句柄供
 * UI 刷新图片状态（补图重试成功后 refetch 更新 images 维度）。
 */
export function useNoteHead(
  attemptId: string,
  questionId: string,
): UseQueryResult<NoteHeadData, Error> {
  const session = useNoteSessionRef();
  return useQuery({
    queryKey: studentNoteHeadKey(
      session?.studentId ?? "standby",
      attemptId,
      questionId,
    ),
    queryFn: async () => {
      if (session === null) {
        throw new Error("草稿会话未绑定（不应发生：enabled 已守卫）");
      }
      // T6R.14：经传输层合批拉取（同 tick 多题合并为一次 POST；分发回各题
      // 后副作用照旧在本 queryFn 内跑；协调器本体在 lib/note-head-batch）
      const head = await fetchStudentNoteHeadCoalesced(attemptId, questionId);
      await applyNoteHeadSideEffects(
        session,
        {
          attemptId,
          questionId,
          phase: "scratch",
        },
        head,
      );
      return head;
    },
    enabled: session !== null,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    // ApiError（403/404/401 等）不重试：终态或需登录干预；网络错误重试 2 次
    retry: (count, err) => !(err instanceof ApiError) && count < 2,
  });
}
