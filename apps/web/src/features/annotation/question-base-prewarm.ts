import type { AttemptQuestionPublic } from "@tutor/contract";
import {
  type AnnotationScope,
  type AnnotationSessionRef,
  annotationKeyOf,
} from "./annotation-store";
import { currentAnnotationSession } from "./annotation-sync";
import {
  questionSurfaceMatchesLayout,
  renderQuestionBaseImage,
} from "./question-base-image";
import { questionBaseRenderQueue } from "./question-base-render-queue";

type PreparedBase = Awaited<ReturnType<typeof renderQuestionBaseImage>>;
interface Entry {
  session: AnnotationSessionRef;
  expiresAt: number;
  controller: AbortController;
  claimed: boolean;
  ready: boolean;
  bytes: number;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  promise: Promise<PreparedBase> | null;
}
const entries = new Map<string, Entry>();
let warming: Entry | null = null;
const MAX_BYTES = 2 * 1024 * 1024;
function remove(key: string, entry: Entry) {
  entry.controller.abort();
  if (entry.expiryTimer !== null) clearTimeout(entry.expiryTimer);
  if (entries.get(key) === entry) entries.delete(key);
}

function prune() {
  for (const [key, entry] of entries) {
    if (
      entry.session !== currentAnnotationSession() ||
      entry.expiresAt <= Date.now()
    ) {
      remove(key, entry);
    }
  }
}
function limitMemory() {
  let bytes = [...entries.values()].reduce(
    (sum, entry) => sum + entry.bytes,
    0,
  );
  for (const [key, entry] of entries) {
    if (entries.size <= 2 && bytes <= MAX_BYTES) break;
    remove(key, entry);
    bytes -= entry.bytes;
  }
}
export function clearPrewarmedQuestionBases() {
  for (const [key, entry] of entries) remove(key, entry);
  warming?.controller.abort();
  entries.clear();
  warming = null;
}
export function cancelQuestionBasePrewarm(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
) {
  const key = annotationKeyOf(session, scope);
  const entry = entries.get(key);
  if (entry && !entry.claimed) {
    remove(key, entry);
  }
}
/** 交互打断只停止在途栅格化；已完成的候选保留给显式打开复用。 */
export function interruptQuestionBasePrewarm(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
) {
  const key = annotationKeyOf(session, scope);
  const entry = entries.get(key);
  if (entry && !entry.claimed && !entry.ready) {
    remove(key, entry);
  }
}
/** 前台请求优先，其他题的预备在下一检查处让出队列。 */
export function cancelOtherQuestionBasePrewarm(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
) {
  prune();
  const wanted = entries.get(annotationKeyOf(session, scope));
  if (warming && warming !== wanted && !warming.claimed)
    warming.controller.abort();
}

/** 只生成短期内存候选，不创建本机稿、请求云端状态或上传空稿。 */
export async function prewarmQuestionBase(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  question: AttemptQuestionPublic,
  surface: HTMLElement,
  isBusy: () => boolean,
): Promise<void> {
  prune();
  const key = annotationKeyOf(session, scope);
  if (
    isBusy() ||
    session !== currentAnnotationSession() ||
    scope.questionId !== question.id ||
    entries.has(key) ||
    warming
  )
    return;
  const controller = new AbortController();
  const entry: Entry = {
    session,
    expiresAt: Date.now() + 30_000,
    controller,
    claimed: false,
    ready: false,
    bytes: 0,
    expiryTimer: null,
    promise: null,
  };
  entry.promise = questionBaseRenderQueue
    .run(async () => {
      if (session !== currentAnnotationSession())
        throw new Error("预备会话已切换");
      const result = await renderQuestionBaseImage(question, surface, {
        signal: controller.signal,
        shouldAbort: () =>
          session !== currentAnnotationSession() ||
          (!entry.claimed && isBusy()),
      });
      if (controller.signal.aborted || session !== currentAnnotationSession())
        throw new Error("预备已取消");
      entry.bytes = result.blob.size;
      entry.ready = true;
      if (entries.get(key) === entry) limitMemory();
      return result;
    })
    .finally(() => {
      if (warming === entry) warming = null;
    });
  entries.set(key, entry);
  entry.expiryTimer = setTimeout(() => remove(key, entry), 30_000);
  warming = entry;
  limitMemory();
  try {
    await entry.promise;
  } catch (error) {
    if (entries.get(key) === entry) remove(key, entry);
    throw error;
  }
}

export async function takePrewarmedQuestionBase(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  question: AttemptQuestionPublic,
  surface: HTMLElement,
): Promise<PreparedBase | null> {
  prune();
  if (session !== currentAnnotationSession()) return null;
  const key = annotationKeyOf(session, scope);
  const entry = entries.get(key);
  if (!entry?.promise || entry.session !== session) return null;
  entry.claimed = true;
  if (entry.expiryTimer !== null) clearTimeout(entry.expiryTimer);
  entries.delete(key);
  try {
    const result = await entry.promise;
    if (
      session !== currentAnnotationSession() ||
      entry.controller.signal.aborted
    )
      return null;
    const matches = await questionSurfaceMatchesLayout(
      question,
      surface,
      result.layout,
    );
    return matches && session === currentAnnotationSession() ? result : null;
  } catch {
    return null;
  }
}
