/**
 * 题卡窗口化虚拟列表控制器（性能第三步：窗口化卸载 + 进视口调度，2026-10-28）。
 *
 * 在题卡懒挂载（AttemptQuestionRow 第一版：进视口挂载、只挂不卸）之上加两个能力：
 *
 * 1. 窗口化卸载：整条 li（题行常驻元素）完全离开「卸载窗口」（视口上下各
 *    2.5 屏）后，把已挂载的题卡卸回等高占位。卸载前记录实测高度，占位
 *    minHeight 用它回填——重挂零位移；Markdown 渲染结果由 render-cache
 *    （按管线变体 + 源文缓存元素）承担，重挂不重跑 remark→rehype→KaTeX。
 *    卸载按小批量节奏执行（单批 ≤3 张）：卸载远轻于挂载，但也不占滚动帧预算。
 *
 * 2. 进视口挂载调度：进入视口带的挂载请求先进队列；滚动静默
 *    （SCROLL_QUIET_MS 内无 scroll 事件）后按「离视口距离」就近优先、每个
 *    宏任务最多挂一张卡地逐个挂载（卡片之间浏览器有机会绘制）。效果：首屏
 *    关键路径只付第一张卡的解析渲染成本（首卡判定线）；连续滚动期间挂载
 *    让位（已入队的请求退回队列，静默后继续，一张不丢），滚动帧只留给浏览
 *    器自身的滚动开销（滚动 p95 判定线），停稳后约一个静默周期内把视口带填齐。
 *
 * 卸载守卫（retain，由构造方注入；命中即本轮不卸、留在队列等下一轮）：
 * 跳题/阅读位置恢复的目标题（forceMount 钉住）、编辑器激活或纸面展开在该题
 * （圈画/草稿/正式手写，绘制中不卸载）、卡内含焦点（正在输入）、卡内有展开
 * 的 UI（对话框/下拉/details/AI 面板内容）。li 级观察保证长卡只要任何部分
 * 还在窗口内就不会整卡卸载，正在阅读的卡天然安全。
 */

/** 挂载带：与懒挂载第一版一致（上方半屏、下方一屏）。 */
const MOUNT_MARGIN = "50% 0px 100% 0px";
/** 卸载窗口：视口上下各 2.5 屏；挂载带内（≤1 屏）永远不卸，中间留迟滞带防抖。 */
const UNLOAD_MARGIN = "250% 0px 250% 0px";
/** 滚动静默：最后一次 scroll 事件后静默这么久才恢复挂载。 */
const SCROLL_QUIET_MS = 150;
/** 卸载节奏：每批间隔与单批上限（卸载任务远小于一帧预算）。 */
const UNLOAD_INTERVAL_MS = 120;
const UNLOAD_BATCH = 3;

export interface LazyMountWindowOptions {
  /** 卸载守卫：返回 true 表示该题本轮不可卸载（编辑器激活/焦点/展开 UI/钉住）。 */
  retain?: (questionId: string) => boolean;
  /** 挂载/卸载结算回调（挂载版本号驱动判分反馈观察列表与阅读位置重捕）。 */
  onSettle?: () => void;
  /** 可注入时钟（单测）。 */
  now?: () => number;
}

type Id = string;

export class LazyMountWindow {
  private readonly retain: (questionId: Id) => boolean;
  private readonly onSettle: () => void;
  private readonly now: () => number;

  private mountedIds = new Set<Id>();
  private measured = new Map<Id, number>();
  private elements = new Map<Id, HTMLElement>();
  private idsByElement = new Map<Element, Id>();
  private listeners = new Map<Id, Set<() => void>>();

  /** 待挂载请求（尚未排序）；ranked 为已排序的挂载顺序。 */
  private pending = new Set<Id>();
  private ranked: Id[] = [];
  private chainActive = false;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;

  private unloadQueue = new Set<Id>();
  private unloadTimer: ReturnType<typeof setTimeout> | null = null;

  private lastScrollAt = -Infinity;
  private mountObserver: IntersectionObserver | null = null;
  private unloadObserver: IntersectionObserver | null = null;
  private scrollWired = false;
  private disposed = false;

  constructor(options: LazyMountWindowOptions = {}) {
    this.retain = options.retain ?? (() => false);
    this.onSettle = options.onSettle ?? (() => {});
    this.now = options.now ?? (() => performance.now());
  }

  /** 行注册回调里调用：element 为 null 表示行卸载。 */
  attach(id: Id, element: HTMLElement | null): void {
    if (this.disposed) return;
    const previous = this.elements.get(id);
    if (element === null) {
      if (previous === undefined) return;
      this.mountObserver?.unobserve(previous);
      this.unloadObserver?.unobserve(previous);
      this.elements.delete(id);
      this.idsByElement.delete(previous);
      return;
    }
    if (previous === element) return;
    if (previous !== undefined) {
      this.mountObserver?.unobserve(previous);
      this.unloadObserver?.unobserve(previous);
      this.idsByElement.delete(previous);
    }
    this.elements.set(id, element);
    this.idsByElement.set(element, id);
    if (typeof IntersectionObserver === "undefined") {
      // 无 IntersectionObserver 环境（jsdom 等）：退化为进页即挂载。
      this.mountOne(id);
      return;
    }
    this.ensureObservers();
    this.wireScroll();
    this.mountObserver?.observe(element);
    if (this.mountedIds.has(id)) this.unloadObserver?.observe(element);
    // 首挂不等观察器：kick 出的 pump 会按几何把带内的行补齐。
    this.kick();
  }

  /** 订阅某题的挂载状态变化（行组件用 useSyncExternalStore 接入）。 */
  subscribe(id: Id, listener: () => void): () => void {
    let set = this.listeners.get(id);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(id);
      current?.delete(listener);
      if (current !== undefined && current.size === 0)
        this.listeners.delete(id);
    };
  }

  isMounted(id: Id): boolean {
    return this.mountedIds.has(id);
  }

  /** 卸载前记录的实测卡高（占位回填，重挂零位移）；未量过返回 undefined。 */
  measuredHeight(id: Id): number | undefined {
    return this.measured.get(id);
  }

  /** 行内滚动监听上报：任何 scroll（含嵌套容器，capture）都算「滚动中」。 */
  noteScroll(): void {
    this.lastScrollAt = this.now();
    // 滚动静默本身就是自愈时钟：停稳后 pump→reconcile 按几何核对缺口，
    // 不依赖观察器是否可靠投递。
    this.kick();
  }

  isScrolling(): boolean {
    return this.now() - this.lastScrollAt < SCROLL_QUIET_MS;
  }

  /** 进入视口带后的挂载请求：入队走调度（滚动静默后执行）。 */
  requestMount(id: Id): void {
    if (this.disposed || this.mountedIds.has(id)) return;
    this.pending.add(id);
    this.kick();
  }

  /** 立即挂载（跳题/阅读位置恢复的目标题）：跳过队列与滚动门槛。 */
  forceMount(id: Id): void {
    if (this.disposed) return;
    this.pending.delete(id);
    this.ranked = this.ranked.filter((item) => item !== id);
    this.mountOne(id);
  }

  dispose(): void {
    this.disposed = true;
    this.mountObserver?.disconnect();
    this.unloadObserver?.disconnect();
    if (this.scrollWired && typeof window !== "undefined")
      window.removeEventListener("scroll", this.handleScroll, {
        capture: true,
      });
    if (this.pumpTimer !== null) clearTimeout(this.pumpTimer);
    if (this.unloadTimer !== null) clearTimeout(this.unloadTimer);
    this.mountObserver = null;
    this.unloadObserver = null;
    this.mountedIds.clear();
    this.measured.clear();
    this.elements.clear();
    this.idsByElement.clear();
    this.listeners.clear();
    this.pending.clear();
    this.ranked = [];
    this.unloadQueue.clear();
  }

  // ---------- 挂载调度 ----------

  private kick(): void {
    if (this.pumpTimer !== null || this.chainActive) return;
    const delay = this.isScrolling() ? SCROLL_QUIET_MS : 0;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, delay);
  }

  private pump(): void {
    if (this.disposed) {
      this.pending.clear();
      return;
    }
    if (this.isScrolling()) {
      // 滚动中：不挂载，等下一个静默窗口（请求留在 pending，一张不丢）。
      if (this.pending.size > 0) this.kick();
      return;
    }
    // IO 只是提示，几何才是权威：静默后按当前几何核对带内未挂的行，
    // 观察器漏报/陈旧通知造成的缺口在这里自愈。
    this.reconcile();
    if (this.pending.size > 0) {
      const viewportHeight =
        typeof window === "undefined" ? 800 : window.innerHeight;
      const ordered = [
        ...pendingByDistance(
          this.pending,
          (id) => {
            const rect = this.elements.get(id)?.getBoundingClientRect();
            return rect ?? null;
          },
          viewportHeight,
        ),
      ];
      for (const id of ordered)
        if (!this.ranked.includes(id) && !this.mountedIds.has(id))
          this.ranked.push(id);
      this.pending.clear();
    }
    if (this.ranked.length === 0) return;
    if (this.chainActive) return;
    this.chainActive = true;
    this.step();
  }

  /** 带内核对：MOUNT_MARGIN 对应视口上方半屏、下方一屏；几何与 IO 不一致的缺口在这里补齐。 */
  private reconcile(): void {
    if (typeof window === "undefined") return;
    const viewportHeight = window.innerHeight;
    const bandTop = -viewportHeight * 0.5;
    const bandBottom = viewportHeight * 2;
    for (const [id, element] of this.elements) {
      if (this.mountedIds.has(id)) continue;
      const rect = element.getBoundingClientRect();
      if (
        rect.top < bandBottom &&
        rect.bottom > bandTop &&
        !this.pending.has(id)
      )
        this.pending.add(id);
    }
  }

  /** 挂载链：每个宏任务最多挂一张卡，卡片之间浏览器有机会绘制。 */
  private step(): void {
    if (this.disposed) {
      this.ranked = [];
      this.chainActive = false;
      return;
    }
    if (this.ranked.length === 0) {
      this.chainActive = false;
      if (this.pending.size > 0) this.kick();
      return;
    }
    if (this.isScrolling()) {
      // 滚动来了：未挂的退回 pending 等静默，绝不占滚动帧。
      for (const id of this.ranked) this.pending.add(id);
      this.ranked = [];
      this.chainActive = false;
      this.kick();
      return;
    }
    const id = this.ranked.shift();
    if (id !== undefined) this.mountOne(id);
    if (this.ranked.length > 0 || this.pending.size > 0)
      setTimeout(() => this.step(), 0);
    else this.chainActive = false;
  }

  private mountOne(id: Id): void {
    if (this.disposed || this.mountedIds.has(id)) return;
    this.mountedIds.add(id);
    const element = this.elements.get(id);
    if (element !== undefined) this.unloadObserver?.observe(element);
    this.notify(id);
    this.onSettle();
  }

  // ---------- 窗口化卸载 ----------

  private scheduleUnload(): void {
    if (this.disposed || this.unloadTimer !== null) return;
    this.unloadTimer = setTimeout(() => {
      this.unloadTimer = null;
      this.flushUnloads();
    }, UNLOAD_INTERVAL_MS);
  }

  private flushUnloads(): void {
    if (this.disposed) {
      this.unloadQueue.clear();
      return;
    }
    if (this.unloadQueue.size === 0) return;
    const viewportHeight =
      typeof window === "undefined" ? 800 : window.innerHeight;
    const windowTop = -viewportHeight * 2.5;
    const windowBottom = viewportHeight * 3.5;
    const candidates: Id[] = [];
    let retained = false;
    for (const id of this.unloadQueue) {
      if (!this.mountedIds.has(id)) {
        this.unloadQueue.delete(id);
        continue;
      }
      // IO 的穿越可能是陈旧快照（WebKit 对快速滚动后新 observe 的目标发过
      // 陈旧的「不可见」初始通知）：落手前按当前几何复核，仍在窗口内的直接
      // 出队——绝不卸载当前看得见/够得着的卡。
      const rect = this.elements.get(id)?.getBoundingClientRect();
      if (
        rect !== undefined &&
        rect.bottom > windowTop &&
        rect.top < windowBottom
      ) {
        this.unloadQueue.delete(id);
        continue;
      }
      if (this.retain(id)) {
        retained = true;
        continue;
      }
      candidates.push(id);
      if (candidates.length >= UNLOAD_BATCH) break;
    }
    for (const id of candidates) this.unloadQueue.delete(id);
    if (candidates.length === 0) {
      // 守卫命中：留在队列，等下一轮再试（守卫解除后自然收口）。
      if (retained) this.scheduleUnload();
      return;
    }
    // 先批量读高度（一次布局），再统一卸载提交。
    const heights = candidates.map((id) => {
      const card = this.elements.get(id)?.firstElementChild;
      const height = card?.getBoundingClientRect().height ?? 0;
      return [id, height] as const;
    });
    const settled: Id[] = [];
    for (const [id, height] of heights) {
      this.mountedIds.delete(id);
      if (Number.isFinite(height) && height > 0) this.measured.set(id, height);
      settled.push(id);
    }
    for (const id of settled) this.notify(id);
    this.onSettle();
    if (this.unloadQueue.size > 0) this.scheduleUnload();
    // 卸载若误伤（IO 陈旧通知），静默后的 reconcile 会把带内的行补回来。
    this.kick();
  }

  // ---------- 观察器与事件 ----------

  private ensureObservers(): void {
    if (this.mountObserver === null) {
      this.mountObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const id = this.idsByElement.get(entry.target);
            if (id !== undefined) this.requestMount(id);
          }
        },
        { rootMargin: MOUNT_MARGIN },
      );
    }
    if (this.unloadObserver === null) {
      this.unloadObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) continue;
            const id = this.idsByElement.get(entry.target);
            if (id === undefined || !this.mountedIds.has(id)) continue;
            this.unloadQueue.add(id);
          }
          if (this.unloadQueue.size > 0) this.scheduleUnload();
        },
        { rootMargin: UNLOAD_MARGIN },
      );
    }
  }

  private wireScroll(): void {
    if (this.scrollWired || typeof window === "undefined") return;
    this.scrollWired = true;
    window.addEventListener("scroll", this.handleScroll, {
      capture: true,
      passive: true,
    });
  }

  private readonly handleScroll = () => {
    this.noteScroll();
  };

  private notify(id: Id): void {
    for (const listener of this.listeners.get(id) ?? []) listener();
  }
}

/**
 * 按离视口的距离排序（视口内最优先，同距保持文档序）：下方按「顶边超出
 * 视口底」升序，上方按「底边在视口顶之上」升序。读不到几何的排最后。
 */
function pendingByDistance(
  ids: Iterable<Id>,
  rectOf: (id: Id) => DOMRect | null,
  viewportHeight: number,
): Id[] {
  return [...ids]
    .map((id) => {
      const rect = rectOf(id);
      let distance = Number.POSITIVE_INFINITY;
      if (rect !== null) {
        if (rect.bottom <= 0) distance = -rect.bottom;
        else if (rect.top >= viewportHeight)
          distance = rect.top - viewportHeight;
        else distance = 0;
      }
      return { id, distance };
    })
    .sort((a, b) => a.distance - b.distance)
    .map((item) => item.id);
}
