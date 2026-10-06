/**
 * 串行异步任务队列（共享原语）：任务按入队顺序逐个执行，前一任务的成败
 * 都不阻塞后一任务（失败不毒化队列）。
 *
 * 提取自 features/notes/image-sync.ts（T6R.6 建立、T6R.8 抽出共享）：
 * 图片派生队列与草稿同步队列（note-sync）都需要「串行、失败不吞后续」的
 * 执行骨架，此处单一实现，两侧不各自重写（image-sync 的注释约定）。
 *
 * 语义要点（与 image-sync 时期一致，测试锁定在各自消费方）：
 * - 对调用方返回的 Promise 保持原始拒绝（不吞错——组件卸载后 catch 闭包
 *   仍执行；错误处理是调用方的职责）；
 * - 内部 #tail 永远 resolve（吞掉前一个的失败文案只记入 lastError）⇒
 *   后续任务照常执行；
 * - stats() 是瞬时快照（诊断/状态展示轮询用）。
 */

/** 队列瞬时状态（诊断/状态展示轮询用） */
export interface SerialTaskQueueStats {
  /** 在途作业数（0 或 1——串行约束） */
  active: number;
  /** 排队等待数 */
  queued: number;
  /** 最近一次作业失败的错误文案；null = 无失败记录 */
  lastError: string | null;
}

export class SerialTaskQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #active = 0;
  #queued = 0;
  #lastError: string | null = null;

  run<T>(task: () => Promise<T>): Promise<T> {
    this.#queued += 1;
    const start = (): Promise<T> => {
      this.#queued -= 1;
      this.#active += 1;
      // Promise.resolve().then(task)：task 同步抛错也走 rejection 路径，
      // .finally 必然执行——#active 不因同步 throw 泄漏（复审①）
      return Promise.resolve()
        .then(task)
        .finally(() => {
          this.#active -= 1;
        });
    };
    // #tail 永远 resolve（吞掉前一个的失败）⇒ 后续任务照常执行
    const result = this.#tail.then(start, start);
    this.#tail = result.then(
      () => undefined,
      (err: unknown) => {
        this.#lastError = err instanceof Error ? err.message : String(err);
        return undefined;
      },
    );
    return result;
  }

  stats(): SerialTaskQueueStats {
    return {
      active: this.#active,
      queued: this.#queued,
      lastError: this.#lastError,
    };
  }
}
