/**
 * 手写状态与历史管理（T2.7 纯数据层核心，架构 §5.4）。
 *
 * 不碰 DOM/canvas，可完整单测。负责：
 * - 维护当前笔画列表（唯一数据源，画布只是它的投影）；
 * - 撤销栈/重做栈：条目是纯数据（无闭包函数），撤销=应用反向、重做=应用正向；
 * - 变更通知：每次 commit / undo / redo / clear / replace 恰好触发一次；
 * - LR-2（学习记录模型设计稿 §4）：维护擦除墓碑 `deleted`（兄弟数组）——
 *   擦除/清空/撤销新增时笔画离开正文，完整几何与时刻进墓碑；撤销擦除 /
 *   重做 / 重做新增时按原墓碑回收（id 稳定）。墓碑预算 FIFO 压实：超预算
 *   丢最老墓碑（服务端只拒不压，压实责任在客户端）。
 *
 * 墓碑与历史条目的关联条目用 Map<entry, tombs>（条目对象作键，不污染
 * 纯数据条目本身）：remove/clear 条目的墓碑在**提交时**生成（deletedAt
 * = 删除时刻）；add 条目的墓碑在**撤销时**生成（deletedBy:"undo"，
 * deletedAt = 撤销时刻）——redo(add) 回收同一批（id 不变）。replace（load）
 * 双侧整组交换：撤销回到 prev 墓碑组、重做回到 next 墓碑组。
 */
import {
  type InkDeletedStroke,
  NOTE_MAX_DELETED_POINTS,
} from "@tutor/contract";
import type { InkStroke } from "./types.ts";

/**
 * 客户端铸造的稳定笔画 id（LR-1）：crypto.randomUUID 优先（36 位，契约
 * 8–40 位正则天然满足）；无 crypto 环境（旧 jsdom 测试等）退回时间+随机串。
 * 墓碑必带 id（被擦笔画若本身无 id，在进墓碑时补铸——该笔已离开正文，
 * 不触碰活笔画数据）。
 */
let mintCounter = 0;
export function mintStrokeId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return uuid;
  mintCounter = (mintCounter + 1) % 1_000_000;
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${mintCounter.toString(36)}`;
}

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

/** deep拷贝（结构化克隆语义；笔画数据均为可克隆的纯 JSON 值） */
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
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (JSON.stringify(left) !== JSON.stringify(right)) return false;
  }
  return true;
}

/** 两组墓碑是否内容一致（replace 往返等价判定的一部分） */
function equalDeleted(
  a: readonly InkDeletedStroke[],
  b: readonly InkDeletedStroke[],
): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 手写数据仓库。 strokes 只增不改（immutable 快照），对外返回副本，
 * 保证 getData() 的结果与后续操作互不影响（草稿保存/往返比较的前提）。
 */
export class InkStore {
  #maxEntries: number;
  #maxPoints: number;
  #maxDeletedPoints: number;
  #maxDeletedStrokes: number;
  #onTrimmed: ((trimmed: InkDeletedStroke[]) => void) | undefined;
  #undoPoints = 0;
  #strokes: InkStroke[] = [];
  #deleted: InkDeletedStroke[] = [];
  #undoStack: InkHistoryEntry[] = [];
  #redoStack: InkHistoryEntry[] = [];
  #listeners = new Set<(strokes: readonly InkStroke[]) => void>();
  #updatedAt = 0;
  /** 墓碑 ↔ 历史条目关联：remove/clear 的墓碑（提交时产）、add 的墓碑（undo 时产，redo 回收） */
  #entryTombs = new Map<InkHistoryEntry, InkDeletedStroke[]>();
  /** replace 条目的双侧墓碑组（撤销取 prev、重做取 next） */
  #swapTombs = new Map<
    InkHistoryEntry,
    { prev: InkDeletedStroke[]; next: InkDeletedStroke[] }
  >();

  constructor(
    budget: {
      maxEntries?: number;
      maxPoints?: number;
      /** 墓碑 FIFO 预算（点数）；缺省取最宽松的草稿链预算 NOTE_MAX_DELETED_POINTS */
      maxDeletedPoints?: number;
      /**
       * 墓碑 FIFO 预算（笔数）。缺省不设上限（点数预算兜底）；圈画链必须传
       * ANNOTATION_MAX_DELETED_STROKES——圈画一笔几十点，400 笔才 2 万点，
       * 只按点数压实时服务端 400 笔上限先撞，且 413 后圈画链无自愈路径。
       */
      maxDeletedStrokes?: number;
      /** 压实回调：丢最老墓碑时通知（消费方同步清理这些 id 的锚点等派生键） */
      onTombstonesTrimmed?: (trimmed: InkDeletedStroke[]) => void;
    } = {},
  ) {
    this.#maxEntries = Math.max(1, budget.maxEntries ?? 200);
    this.#maxPoints = Math.max(1, budget.maxPoints ?? 600_000);
    this.#maxDeletedPoints = Math.max(
      1,
      budget.maxDeletedPoints ?? NOTE_MAX_DELETED_POINTS,
    );
    this.#maxDeletedStrokes =
      budget.maxDeletedStrokes ?? Number.MAX_SAFE_INTEGER;
    this.#onTrimmed = budget.onTombstonesTrimmed;
  }

  /** 当前笔画快照（副本，调用方可安全持有） */
  getStrokes(): InkStroke[] {
    return cloneStrokes(this.#strokes);
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

  /** 当前墓碑快照（副本；LR-2，序列化进文档的 deleted 兄弟数组） */
  getDeleted(): InkDeletedStroke[] {
    return clone(this.#deleted);
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
    this.#strokes.push(...cloneStrokes(strokes));
    this.#pushUndo({ kind: "add", strokes: cloneStrokes(strokes) });
    this.#changed();
  }

  /**
   * 整笔橡皮提交：indices 为被删除笔画的当前下标（任意顺序，内部排序）。
   * 一次拖动的多次命中应累积后一次性提交（一个历史条目）。
   * LR-2：被删笔画整体移入墓碑（deletedBy:"eraser"，同一 deletedAt）。
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
    const tombs = this.#toTombstones(
      removed.map((item) => item.stroke),
      "eraser",
    );
    this.#deleted.push(...tombs);
    const entry: InkHistoryEntry = { kind: "remove", removed };
    this.#entryTombs.set(entry, tombs);
    this.#pushUndo(entry);
    this.#trimDeleted();
    this.#changed();
  }

  /** 清空画布（可撤销：撤销恢复全部笔画）。LR-2：全部移入墓碑（"clear"） */
  commitClear(): void {
    if (this.#strokes.length === 0) return;
    const previous = clone(this.#strokes);
    const tombs = this.#toTombstones(previous, "clear");
    this.#deleted.push(...tombs);
    const entry: InkHistoryEntry = { kind: "clear", previous };
    this.#entryTombs.set(entry, tombs);
    this.#pushUndo(entry);
    this.#strokes = [];
    this.#trimDeleted();
    this.#changed();
  }

  /**
   * 整体替换为外部文档内容（load 用）。默认时间戳取当前时刻；
   * load 外部文档时传入文档自带的 updatedAt 与墓碑组（LR-2：文档的
   * deleted 随之整组载入），保证 load(getData()) 往返一致。
   * 内容与当前完全一致时（如 load(getData()) 往返验证）不产生历史条目，
   * 避免撤销栈里出现"什么都没变"的一步。
   */
  replace(
    strokes: InkStroke[],
    updatedAt = Date.now(),
    deleted?: InkDeletedStroke[],
  ): void {
    const nextDeleted = deleted ?? [];
    if (
      equalStrokes(this.#strokes, strokes) &&
      equalDeleted(this.#deleted, nextDeleted)
    ) {
      this.#changed(updatedAt);
      return;
    }
    const entry: InkHistoryEntry = {
      kind: "replace",
      previous: clone(this.#strokes),
      next: clone(strokes),
    };
    this.#swapTombs.set(entry, {
      prev: clone(this.#deleted),
      next: clone(nextDeleted),
    });
    this.#strokes = clone(strokes);
    this.#deleted = clone(nextDeleted);
    this.#pushUndo(entry);
    this.#changed(updatedAt);
  }

  /** 撤销一步。返回是否有操作被执行（空栈为 no-op 且不通知） */
  undo(): boolean {
    const entry = this.#undoStack.pop();
    if (!entry) return false;
    this.#undoPoints -= historyPoints(entry);
    switch (entry.kind) {
      case "add": {
        // 撤销新增：笔画离开正文 → 产墓碑（deletedBy:"undo"，设计稿 §4.3）
        const tombs = this.#toTombstones(entry.strokes, "undo");
        this.#deleted.push(...tombs);
        this.#entryTombs.set(entry, tombs);
        break;
      }
      case "remove":
      case "clear": {
        // 撤销删除：回收该条目的墓碑（笔画回正文）
        this.#recycleTombs(this.#entryTombs.get(entry));
        break;
      }
      case "replace": {
        // 撤销 load：整组回到 prev 墓碑
        const swap = this.#swapTombs.get(entry);
        if (swap) this.#deleted = clone(swap.prev);
        break;
      }
    }
    this.#applyInverse(entry);
    this.#redoStack.push(entry);
    this.#trimDeleted();
    this.#changed();
    return true;
  }

  /** 重做一步。返回是否有操作被执行 */
  redo(): boolean {
    const entry = this.#redoStack.pop();
    if (!entry) return false;
    this.#applyForward(entry);
    switch (entry.kind) {
      case "add": {
        // 重做新增：回收 undo(add) 产生的墓碑（笔画回正文，id 不变）
        this.#recycleTombs(this.#entryTombs.get(entry));
        break;
      }
      case "remove":
      case "clear": {
        // 重做删除：**原墓碑原样回归**（id 稳定，锚点/时间线引用不断）
        const tombs = this.#entryTombs.get(entry);
        if (tombs) this.#deleted.push(...clone(tombs));
        break;
      }
      case "replace": {
        const swap = this.#swapTombs.get(entry);
        if (swap) this.#deleted = clone(swap.next);
        break;
      }
    }
    this.#undoStack.push(entry);
    this.#undoPoints += historyPoints(entry);
    this.#trimHistory();
    this.#trimDeleted();
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
    this.#undoPoints += historyPoints(entry);
    // 新提交丢弃整个重做栈：被弃条目的墓碑关联一并清理
    //（remove/clear 条目的墓碑本体留在 #deleted——该删除已是永久事实）
    const discarded = this.#redoStack;
    this.#redoStack = [];
    for (const old of discarded) {
      this.#entryTombs.delete(old);
      this.#swapTombs.delete(old);
    }
    this.#trimHistory();
  }

  #trimHistory(): void {
    // 即使单次清空超过预算，也保留最近一步，确保清空可撤销；正文不参与淘汰。
    while (
      this.#undoStack.length > 1 &&
      (this.#undoStack.length > this.#maxEntries ||
        this.#undoPoints > this.#maxPoints)
    ) {
      const oldest = this.#undoStack.shift();
      if (oldest) {
        this.#undoPoints -= historyPoints(oldest);
        this.#entryTombs.delete(oldest);
        this.#swapTombs.delete(oldest);
      }
    }
  }

  /** 通知并刷新时间戳。replace 传入外部文档的 updatedAt 以保证往返一致 */
  #changed(updatedAt?: number): void {
    this.#updatedAt = updatedAt ?? Date.now();
    const snapshot = this.#strokes;
    for (const cb of this.#listeners) cb(snapshot);
  }

  /** 笔画 → 墓碑（补铸 id；同一批次共用同一 deletedAt） */
  #toTombstones(
    strokes: readonly InkStroke[],
    deletedBy: InkDeletedStroke["deletedBy"],
  ): InkDeletedStroke[] {
    const deletedAt = Date.now();
    return strokes.map((stroke) => ({
      ...clone(stroke),
      id: stroke.id ?? mintStrokeId(),
      deletedAt,
      deletedBy,
    }));
  }

  /** 墓碑回收：按 id 从当前墓碑数组移除（笔画回正文） */
  #recycleTombs(tombs: InkDeletedStroke[] | undefined): void {
    if (!tombs || tombs.length === 0) return;
    const ids = new Set(tombs.map((tomb) => tomb.id));
    this.#deleted = this.#deleted.filter((tomb) => !ids.has(tomb.id));
  }

  /** 墓碑 FIFO 压实：超预算丢最老墓碑；回调通知（消费方清理派生键） */
  #trimDeleted(): void {
    let total = 0;
    for (const tomb of this.#deleted) total += tomb.points.length;
    if (
      total <= this.#maxDeletedPoints &&
      this.#deleted.length <= this.#maxDeletedStrokes
    ) {
      return;
    }
    const trimmed: InkDeletedStroke[] = [];
    while (
      (total > this.#maxDeletedPoints ||
        this.#deleted.length > this.#maxDeletedStrokes) &&
      this.#deleted.length > 0
    ) {
      const oldest = this.#deleted.shift();
      if (!oldest) break;
      total -= oldest.points.length;
      trimmed.push(oldest);
    }
    if (trimmed.length > 0) this.#onTrimmed?.(trimmed);
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

/** 已知纯数值笔迹结构逐层复制，避免通用 structuredClone 在每笔结束时扫描整个对象图。 */
function cloneStrokes(strokes: InkStroke[]): InkStroke[] {
  return strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({ ...point })),
  }));
}

function historyPoints(entry: InkHistoryEntry): number {
  const points = (strokes: InkStroke[]) =>
    strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
  switch (entry.kind) {
    case "add":
      return points(entry.strokes);
    case "remove":
      return entry.removed.reduce(
        (sum, item) => sum + item.stroke.points.length,
        0,
      );
    case "clear":
      return points(entry.previous);
    case "replace":
      return points(entry.previous) + points(entry.next);
  }
}
