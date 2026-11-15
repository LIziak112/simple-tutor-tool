/**
 * 提交前的事件收口。
 *
 * 服务端在提交那一刻封存用时：只算到它已经收到的最后一条客户端事件，账行写入后
 * 不许改，之后才到的事件不再计入。网页的事件每 5 秒才发一批，所以每条提交路径
 * （逐题、讲练单题、分批、整卷）发请求之前，都要先把当前聚焦收口、把已有事件
 * 送到服务端，再发提交。约定见 docs/约定/封存题内活动用时.md「提交前先送事件」。
 *
 * 埋点 hook（useAttemptEvents）按卷登记收口函数，题级提交路径按卷号调用，不经
 * 组件层层传递；整卷交卷沿用原有的 finalizeSubmit 入参，用 withinSubmitSettle
 * 限时。
 */

/**
 * 等事件送达的上限。超时、失败、没有登记都不拦提交——事件留在发件箱照常补传，
 * 只是这一次封存可能少算。
 */
export const SUBMIT_EVENT_SETTLE_TIMEOUT_MS = 2500;

export interface SubmitEventSettler {
  /** 结束这些题里的当前聚焦，并把已有事件送出；resolve 表示送过一轮。 */
  settle(questionIds: readonly string[]): Promise<void>;
  /** 提交没成、学生还留在题上：把 settle 结束的那次聚焦接回去。 */
  resume(): void;
}

const settlers = new Map<string, SubmitEventSettler>();

/** 同一份卷后登记的覆盖先登记的；返回的函数只撤销自己这一次登记。 */
export function registerSubmitEventSettler(
  attemptId: string,
  settler: SubmitEventSettler,
): () => void {
  settlers.set(attemptId, settler);
  return () => {
    if (settlers.get(attemptId) === settler) settlers.delete(attemptId);
  };
}

/** 限时等一次收口；不抛错。 */
export async function withinSubmitSettle(
  settling: Promise<unknown>,
  timeoutMs = SUBMIT_EVENT_SETTLE_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settling.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 题级提交（逐题、讲练单题、分批）发请求之前调用。 */
export function settleEventsBeforeSubmit(
  attemptId: string,
  questionIds: readonly string[],
): Promise<void> {
  const settler = settlers.get(attemptId);
  if (settler === undefined) return Promise.resolve();
  let settling: Promise<void>;
  try {
    settling = settler.settle(questionIds);
  } catch {
    return Promise.resolve();
  }
  return withinSubmitSettle(settling);
}

/**
 * 题级提交没成（网络失败、版本冲突、被教师收紧等）之后调用：学生还在这道题上，
 * 计时接着走。已提交的不要调用。
 */
export function resumeFocusAfterFailedSubmit(attemptId: string): void {
  try {
    settlers.get(attemptId)?.resume();
  } catch {
    // 埋点失败不影响作答
  }
}
