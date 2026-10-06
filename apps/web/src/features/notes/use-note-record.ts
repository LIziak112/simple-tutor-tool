/**
 * 草稿记录订阅 hook（T6R.8）：组件只订阅，不持有队列——收起题卡/路由
 * 切换（卸载）后同步作业照常完成（会话级服务单例，参照 image-sync 形态；
 * 方案 §6.1「队列和上传调度位于会话服务，React 组件仅订阅」）。
 *
 * 数据源：note-store 的版本化快照（getNoteView）+ note-sync 的会话绑定
 * （currentNoteSession）。快照引用按 store 版本号缓存（useSyncExternalStore
 * 的稳定性要求）；会话未绑定时返回 null（standby——登录/进入学生端由
 * 接入层 bindNoteSession，T6R.9 接线）。
 *
 * 返回 NoteRecordView：物化正文 + 本地/服务端状态 + 四维总览
 * （overview，T6R.5 契约注释的四维前端合成口径）+ 冲突/被拒副本数据
 * （T6R.9 状态文案与裁决 UI 消费）。
 */
import type { NotePhase } from "@tutor/contract";
import { useCallback, useSyncExternalStore } from "react";
import {
  currentNoteSession,
} from "./note-sync.ts";
import {
  type NoteRecordView,
  getNoteView,
  subscribeNoteStore,
} from "./note-store.ts";

/**
 * 订阅一份笔记的聚合视图（attempt + 题 + 阶段；首版 phase 缺省 scratch）。
 * 记录不存在（未创建/未载入/会话未绑定）时返回 null。
 */
export function useNoteRecord(
  attemptId: string,
  questionId: string,
  phase: NotePhase = "scratch",
): NoteRecordView | null {
  // 订阅回调：store 通知带 key，React 监听器无参——包装一层（key 粒度
  // 过滤不必要：快照有版本缓存，通知多跑一次 getSnapshot 无副作用）
  const subscribe = useCallback(
    (listener: () => void) => subscribeNoteStore(() => listener()),
    [],
  );
  const getSnapshot = useCallback((): NoteRecordView | null => {
    const session = currentNoteSession();
    if (session === null) return null;
    return getNoteView(session, { attemptId, questionId, phase });
  }, [attemptId, questionId, phase]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
