/**
 * 笔记头拉取与恢复接线（T6R.9，方案 §8「GET notes 工作稿头」）：
 * 答题页每道可草稿题挂一次本 hook——
 *
 * - head 拉取成功 → applyServerHead（baseRevision/noteId/lastHead 对齐 +
 *   同源备份回退检测，T6R.8 语义）；notCreated 显式空态（note=null）以
 *   baseRevision=0 起步，不拉正文；
 * - **条件拉正文**：本地无记录 / note 归属变更 / 服务端 revision 领先时才
 *   GET 版本文档并 applyServerLoad 播种（工作稿=服务端稿；本地未同步稿
 *   经 noteDocsEqual 比较保留，不会被覆盖）。本地同 base 且有 pending
 *   （本地领先）不拉——省请求，上传自然追平；
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
 */
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { NoteHeadData, StudentMeData } from "@tutor/contract";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { recoverNoteImages } from "@/features/notes/image-sync";
import {
  applyServerHead,
  applyServerLoad,
  type NoteScope,
  type NoteSessionRef,
  peekNoteRecord,
  subscribeNoteStore,
} from "@/features/notes/note-store";
import {
  bindNoteSession,
  currentNoteSession,
} from "@/features/notes/note-sync";
import {
  ApiError,
  fetchStudentNoteDocumentApi,
  fetchStudentNoteHeadApi,
} from "@/lib/api";

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

/** head 应用与条件恢复（queryFn 内执行；导出供测试直调） */
export async function applyNoteHeadSideEffects(
  session: NoteSessionRef,
  scope: NoteScope,
  head: NoteHeadData,
): Promise<void> {
  const note = head.note;
  const versionId = note?.currentVersionId ?? null;
  // 「服务端领先」判定取 head 应用**前**的快照（applyServerHead 会把
  // baseRevision/noteId 对齐——之后判就永远不领先了）
  const before = peekNoteRecord(session, scope);
  const serverAhead =
    versionId !== null &&
    note !== null &&
    (before === null ||
      before.noteId !== note.noteId ||
      before.baseRevision < note.revision);
  await applyServerHead(session, scope, head);
  // 补图触发（正文拉取与否都该补：本地领先时图片照样该恢复）
  if (
    versionId !== null &&
    head.images.some((img) => img.state === "failed" || img.state === "missing")
  ) {
    void recoverNoteImages({
      role: "student",
      versionId,
    }).catch((err: unknown) => {
      console.warn("草稿补图恢复失败（可用状态栏的重试入口再试）", err);
    });
  }
  if (!serverAhead) return; // 本地领先/已追平：省请求，上传自然覆盖
  try {
    const raw = await fetchStudentNoteDocumentApi(versionId);
    await applyServerLoad(session, scope, raw, head);
  } catch (err) {
    // 正文拉取失败不阻塞：本地稿（若有）继续可用，下一轮 head 重试播种
    console.warn("草稿正文拉取失败（本地稿不受影响）", err);
  }
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
      const head = await fetchStudentNoteHeadApi(attemptId, questionId);
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

/**
 * 答题页接线（T6R.9）：进入答题页 bind 当前学生 + 部署实例（origin 取
 * window.location.origin——同源即同实例）。离开答题页**不** reset——收起
 * 题卡/路由切换后同步队列照常完成（方案 §6.1）；登出在 student-auth 统一
 * resetNoteSession（切账号即旧会话失效、回执隔离）。
 */
export function useBindNoteSession(me: StudentMeData | undefined): void {
  useEffect(() => {
    if (me === undefined) return;
    bindNoteSession({
      origin: window.location.origin,
      studentId: me.id,
    });
  }, [me]);
}
