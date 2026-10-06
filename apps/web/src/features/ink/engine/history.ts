/**
 * 手写状态与历史管理（T2.7 纯数据层核心，架构 §5.4）。
 *
 * 不碰 DOM/canvas，可完整单测。负责：
 * - 维护当前笔画列表（唯一数据源，画布只是它的投影）；
 * - 撤销栈/重做栈：条目是纯数据（无闭包函数），撤销=应用反向、重做=应用正向；
 * - 变更通知：每次 commit / undo / redo / clear / replace 恰好触发一次。
 *
 * 整笔橡皮一次拖动可能删除多笔：合并为一个 remove 条目，撤销时按原位置全部
 * 恢复、重做时再次全部删除（验收项"擦除后再撤销恢复被擦笔画、重做再擦除"）。
 */
import type { InkStroke } from "./types.ts";

/** 撤销/重做栈条目（纯数据，undo/redo 双向都可从条目本身推导） */
export type InkHistoryEntry =
  /** 新增笔画（按提交顺序追加在末尾） */
  | { kind: "add"; strokes: InkStroke[] }
  /** 删除笔画：记录原下标（升序）与内容，撤销时按下标插回 */
  | { kind: "remove"; removed: Array<{ index: number; stroke: InkStroke }> }
  /** 清空：撤销恢复全部 */
  | { kind: "clear"; previous: InkStroke[] }
  /** 整体替换（load 外部文档用）：撤销回到旧内容，重做回到新内容 */
  | { kind: "replace"; previous: InkStroke[]; next: InkStroke[] };

/** 深拷贝（结构化克隆语义；笔画数据均为可克隆的纯 JSON 值） */
function clone<T>(v: T): T {
  return structuredClone(v);
}

/** 两组笔画是否内容完全一致（load 相同内容时不产生历史噪音） */
function equalStrokes(
  a: readonly InkStroke[],
  b: readonly InkStroke[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}

/**
 * 手写数据仓库。 strokes 只增不改（immutable 快照），对外返回副本，
 * 保证 getData() 的结果与后续操作互不影响（草稿保存/往返比较的前提）。
 */
export class InkStore {
  #strokes: InkStroke[] = [];
  #undoStack: InkHistoryEntry[] = [];
  #redoStack: InkHistoryEntry[] = [];
  #listeners = new Set<(strokes: readonly InkStroke[]) => void>();
  #updatedAt = 0;

  /** 当前笔画快照（副本，调用方可安全持有） */
  getStrokes(): InkStroke[] {
    return clone(this.#strokes);
  }

  /**
   * 当前笔画的**只读零拷贝视图**（T6R.7 复审⑨：橡皮命中/重绘等同步热路径
   * 专用——getStrokes 的深拷贝在每个 coalesced 采样点上不可负担）。
   * **仅同步消费**：同一事件处理内读取；随后的提交会原地追加或更换内部
   * 数组，跨异步/跨事件持有请用 getStrokes() 的副本。
   */
  peekStrokes(): readonly InkStroke[] {
    return this.#strokes;
  }

  /** 最后变更时间（epoch 毫秒） */
  getUpdatedAt(): number {
    return this.#updatedAt;
  }

  /** 变更通知：注册监听，返回取消函数。每次状态变化恰好触发一次 */
  subscribe(cb: (strokes: readonly InkStroke[]) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  canUndo(): boolean {
    return this.#undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  /** 新增一笔（或若干笔，如 load 之后连续书写）。任何新提交都会清空重做栈 */
  commitAdd(strokes: InkStroke[]): void {
    if (strokes.length === 0) return;
    this.#strokes.push(...clone(strokes));
    this.#pushUndo({ kind: "add", strokes: clone(strokes) });
    this.#changed();
  }

  /**
   * 整笔橡皮提交：indices 为被删除笔画的当前下标（任意顺序，内部排序）。
   * 一次拖动的多次命中应累积后一次性提交（一个历史条目）。
   */
  commitErase(indices: number[]): void {
    const sorted = [...indices].sort((a, b) => a - b);
    const removed: Array<{ index: number; stroke: InkStroke }> = [];
    // 从大到小删，保证前面的下标不受影响
    for (let i = sorted.length - 1; i >= 0; i--) {
      const index = sorted[i];
      if (index === undefined) continue;
      const stroke = this.#strokes[index];
      if (stroke === undefined) continue;
      removed.unshift({ index, stroke: clone(stroke) });
      this.#strokes.splice(index, 1);
    }
    if (removed.length === 0) return;
    this.#pushUndo({ kind: "remove", removed });
    this.#changed();
  }

  /** 清空画布（可撤销：撤销恢复全部笔画） */
  commitClear(): void {
    if (this.#strokes.length === 0) return;
    this.#pushUndo({ kind: "clear", previous: clone(this.#strokes) });
    this.#strokes = [];
    this.#changed();
  }

  /**
   * 整体替换为外部文档内容（load 用）。默认时间戳取当前时刻；
   * load 外部文档时传入文档自带的 updatedAt，保证 load(getData()) 往返一致。
   * 内容与当前完全一致时（如 load(getData()) 往返验证）不产生历史条目，
   * 避免撤销栈里出现"什么都没变"的一步。
   */
  replace(strokes: InkStroke[], updatedAt = Date.now()): void {
    if (equalStrokes(this.#strokes, strokes)) {
      this.#changed(updatedAt);
      return;
    }
    this.#pushUndo({
      kind: "replace",
      previous: clone(this.#strokes),
      next: clone(strokes),
    });
    this.#strokes = clone(strokes);
    this.#changed(updatedAt);
  }

  /** 撤销一步。返回是否有操作被执行（空栈为 no-op 且不通知） */
  undo(): boolean {
    const entry = this.#undoStack.pop();
    if (!entry) return false;
    this.#applyInverse(entry);
    this.#redoStack.push(entry);
    this.#changed();
    return true;
  }

  /** 重做一步。返回是否有操作被执行 */
  redo(): boolean {
    const entry = this.#redoStack.pop();
    if (!entry) return false;
    this.#applyForward(entry);
    this.#undoStack.push(entry);
    this.#changed();
    return true;
  }

  /** 仅用于测试/调试：栈条目只读视图 */
  debugHistory(): {
    undo: readonly InkHistoryEntry[];
    redo: readonly InkHistoryEntry[];
  } {
    return { undo: [...this.#undoStack], redo: [...this.#redoStack] };
  }

  #pushUndo(entry: InkHistoryEntry): void {
    this.#undoStack.push(entry);
    this.#redoStack = [];
  }

  /** 通知并刷新时间戳。replace 传入外部文档的 updatedAt 以保证往返一致 */
  #changed(updatedAt?: number): void {
    this.#updatedAt = updatedAt ?? Date.now();
    const snapshot = this.#strokes;
    for (const cb of this.#listeners) cb(snapshot);
  }

  #applyInverse(entry: InkHistoryEntry): void {
    switch (entry.kind) {
      case "add": {
        // 撤销新增：移除末尾对应数量的笔画
        this.#strokes.splice(this.#strokes.length - entry.strokes.length);
        break;
      }
      case "remove": {
        // 撤销擦除：按记录的下标升序插回原位
        for (const { index, stroke } of entry.removed) {
          this.#strokes.splice(index, 0, clone(stroke));
        }
        break;
      }
      case "clear": {
        this.#strokes = clone(entry.previous);
        break;
      }
      case "replace": {
        this.#strokes = clone(entry.previous);
        break;
      }
    }
  }

  #applyForward(entry: InkHistoryEntry): void {
    switch (entry.kind) {
      case "add": {
        this.#strokes.push(...clone(entry.strokes));
        break;
      }
      case "remove": {
        // 重做擦除：按下标从大到小再次删除
        for (let i = entry.removed.length - 1; i >= 0; i--) {
          const item = entry.removed[i];
          if (item && item.index < this.#strokes.length) {
            this.#strokes.splice(item.index, 1);
          }
        }
        break;
      }
      case "clear": {
        this.#strokes = [];
        break;
      }
      case "replace": {
        this.#strokes = clone(entry.next);
        break;
      }
    }
  }
}
