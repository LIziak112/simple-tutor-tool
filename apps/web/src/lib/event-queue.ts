import type {
  AttemptEvent,
  LearningEvent,
  LectureEvent,
} from "@tutor/contract";
import { createStore, del, get, keys, set } from "idb-keyval";
import { ApiError, postAttemptEventsApi, postLectureEventsApi } from "./api";

/**
 * 学习痕迹事件队列（T2.10，架构 §5.5；T4.0a 增强）：内存队列 + 每 5 秒批量
 * POST；页面隐藏时 navigator.sendBeacon 兜底（Blob application/json，同源
 * 自动带会话 Cookie）；离线（navigator.onLine / 发送失败）存 IndexedDB，
 * 恢复后补发。
 *
 * 职责边界：
 * - 本模块只负责「攒批 + 可靠送达」与环境事件注入，不产生业务事件
 *   （业务埋点在调用方）；
 * - attempt scope 自动注入 page_hidden / page_visible（visibilitychange，
 *   对接入方透明）；lecture scope 注入 lecture_visible / lecture_hidden
 *   （T4.0a，带 viewId，visibilitychange + pagehide + dispose 三路兜底、
 *   允许双发——服务端聚合按「重复 hidden 忽略」容错）；
 * - 两 scope 均注入 net_offline / net_online（T4.0a：scope 创建时若已离线
 *   主动补一条 net_offline——离线打开 PWA 壳没有翻转事件可听；此后翻转各发。
 *   口径：navigator.onLine 只反映网络接口连接，不代表服务器可达，与学生
 *   顶栏三态同源）与 idle_start / idle_end（阈值 attempt 90s / lecture 300s，
 *   按「上次活动时间戳」惰性判定，不依赖 interval 心跳——iOS 后台 timer 被限
 *   1Hz/挂起，靠心跳必错；低频检查搭 flush 周期的车，visible 恢复时补检查）；
 * - 前端不计算任何汇总值（activeSec 由服务端按原始事件计算，§5.5；
 *   idle 事件只供新指标扣减，不进 activeSec 计算）。
 *
 * 可靠性细节：
 * - 单次上报 ≤200 条（契约上限）且 **≤32KiB（UTF-8 字节）双限切批**
 *   （T4.0a §5.0-A5：sendBeacon 队列上限 64KiB，留序列化余量；answer_change
 *   的 from/to 是学生原文可能很长）。单条本身超限时独占一批：beacon 可能失败
 *   → 落离线仓，恢复后走 fetch 路径（无字节上限）补发。同源 beacon 无 CORS
 *   content-type 问题（现状 Blob application/json 同源可用）；
 * - 离线/失败的事件写回 IndexedDB；online 事件触发补发；IndexedDB 不可用时
 *   留在内存队列（绝不丢已 track 的事件，除非页面被杀且存储也失败——双重
 *   兜底的极限场景）；
 * - **持久键按队列实例隔离（T4.0a §5.0-A1，修 IDB 键跨实例冲突 bug）**：
 *   持久键 = scope 前缀 + 每实例随机后缀（旧版是全局固定键，两标签页同时
 *   离线会互相覆盖丢事件）；flush 时**遍历前缀下全部键**（其他实例与上次
 *   页面被杀的遗留积压，含旧版无后缀键）合并发送、成功后逐键删除。重复
 *   投递可能出现在「store 写失败后恢复」的极端路径，服务端聚合按重复容错
 *   （§5.0-D17），不为去重在前端做防重锁；
 * - 页面隐藏（visibilitychange=hidden / pagehide）时优先 sendBeacon
 *   （fire-and-forget，浏览器保证在页面卸载后发出）；
 * - **终态停止（T2A.6，D7）**：上报收到 403/404（如课程练习移出成员后的
 *   COURSE_ACCESS_DENIED）意味着访问权已永久失去——丢弃待发批次并停止
 *   定时/事件触发的后续发送（区别于网络失败的无限重试），队列进入
 *   stopped 状态（track 静默 no-op）。新前端打旧服务端的降级部署会出现
 *   新事件 400——按普通失败重试（403/404 才终态），可接受（§5.0-B9）；
 * - iOS 已知限制（§5.0-A6，说明不写码）：无 Background Sync，离线积压等
 *   学生下次打开页面才补发；Safari 标签页 7 天不用会被 ITP 清空脚本可写
 *   存储（主屏 PWA 豁免）；dispose 时 in-flight 批次可能丢（接受为已知
 *   极限场景，与 T2.10 口径一致）。
 *
 * 测试注入：send / beacon / intervalMs / store 均可替换（installEventStore
 * 换干净内存后端）；jsdom 无 indexedDB 时自动退化为内存实现（同 draft-store）。
 */

/** 队列归属：attempt 上下文（答题页）或讲义上下文（无 attemptId） */
export type EventScope =
  | { kind: "attempt"; attemptId: string }
  | { kind: "lecture"; lectureId: string };

/**
 * 底层键值存取的最小面（与 draft-store 的 KVBackend 同形；注入内存版便于单测）。
 * T4.0a 增 keys(prefix)：遍历前缀下全部持久键（§5.0-A1 的跨实例合并发送）。
 */
export interface EventStoreBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  /** 列出以 prefix 开头的全部键（乱序允许，调用方不依赖顺序） */
  keys(prefix: string): Promise<string[]>;
}

/** 批量发送周期（毫秒，§5.5：每 5 秒）；同一周期也承担 idle 检查（§5.0-A2） */
export const EVENT_FLUSH_INTERVAL_MS = 5000;

/** 单次上报上限（契约 LEARNING_EVENTS_BATCH_MAX 同值；本地再切一层防越限） */
const BATCH_MAX = 200;

/**
 * 单批字节上限（§5.0-A5）：sendBeacon 队列上限 64KiB，按 32KiB 切留序列化
 * 与并发余量。按 UTF-8 实际字节数计算（中文答案 3 字节/字）。
 */
export const EVENT_BATCH_BYTES_MAX = 32 * 1024;

/** attempt 域空闲阈值（§4.3.1：作答 90 秒无输入判空闲） */
export const IDLE_THRESHOLD_ATTEMPT_MS = 90_000;
/** lecture 域空闲阈值（阅读的正常状态就是零交互，用分钟级，§6 决策 2） */
export const IDLE_THRESHOLD_LECTURE_MS = 300_000;

/** pointermove 位移阈值（像素）：低于此位移不记活动——防手搭平板微抖 */
const POINTER_MOVE_THRESHOLD_PX = 10;
const POINTER_MOVE_THRESHOLD_SQ = POINTER_MOVE_THRESHOLD_PX ** 2;
/** scroll 活动节流（毫秒）：高频滚动事件里只做时间戳更新，节流降低开销 */
const SCROLL_ACTIVITY_THROTTLE_MS = 200;

const EVENT_DB = "tutor-events";
const EVENT_STORE = "pending";
/** scope → 持久键前缀（实例随机后缀拼在后，见 keyOf 注释） */
function keyPrefixOf(scope: EventScope): string {
  return scope.kind === "attempt"
    ? `events:attempt:${scope.attemptId}:`
    : "events:lecture:";
}
/** 旧版（T4.0a 前）无后缀持久键：升级后首次 flush 顺带收编其积压 */
function legacyKeyOf(scope: EventScope): string {
  return scope.kind === "attempt"
    ? `events:attempt:${scope.attemptId}`
    : "events:lecture";
}

/** 内存后端（jsdom 自动回退与单测隔离用；不持久） */
export function memoryEventStore(): EventStoreBackend {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    del: async (key) => {
      map.delete(key);
    },
    keys: async (prefix) =>
      Array.from(map.keys()).filter((key) => key.startsWith(prefix)),
  };
}

/** idb-keyval 后端（生产默认；专用 db/store 与草稿仓隔离） */
function idbEventStore(): EventStoreBackend {
  const store = createStore(EVENT_DB, EVENT_STORE);
  return {
    get: (key) => get(key, store),
    set: (key, value) => set(key, value, store),
    del: (key) => del(key, store),
    keys: async (prefix) => {
      const all = await keys(store);
      return all.filter(
        (key): key is string =>
          typeof key === "string" && key.startsWith(prefix),
      );
    },
  };
}

let activeStore: EventStoreBackend | null = null;

/** 测试注入后端（生产不调用；每个用例换 memoryEventStore 保证隔离） */
export function installEventStore(backend: EventStoreBackend): void {
  activeStore = backend;
}

function store(): EventStoreBackend {
  if (activeStore === null) {
    activeStore =
      typeof indexedDB === "undefined" ? memoryEventStore() : idbEventStore();
  }
  return activeStore;
}

/** 每队列实例的随机后缀（IDB 持久键防跨实例覆盖，§5.0-A1） */
function randomId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

/** 单事件 JSON 的 UTF-8 字节数（无 TextEncoder 的环境按 UTF-16 码元数 ×2 上界估） */
function eventBytes(event: LearningEvent): number {
  const text = JSON.stringify(event);
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  // 上界：BMP 字符最多 3 字节/码元 < 2×2，代理对 4 字节 = 2×2 —— 保守（偏小批）
  return text.length * 2;
}

/**
 * 按条数（≤200）与字节（≤32KiB）双限切批（§5.0-A5）。
 * 单条自身超字节上限时独占一批（不丢事件：beacon 失败落仓后走 fetch 补发）。
 */
function chunkBatches(pending: readonly LearningEvent[]): LearningEvent[][] {
  const batches: LearningEvent[][] = [];
  let current: LearningEvent[] = [];
  let bytes = 0;
  for (const event of pending) {
    const size = eventBytes(event) + 1; // +1 逗号（批量 JSON 分隔符）
    if (
      current.length >= BATCH_MAX ||
      (current.length > 0 && bytes + size > EVENT_BATCH_BYTES_MAX)
    ) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** scope → 上报 URL（fetch 与 sendBeacon 共用） */
function scopeUrl(scope: EventScope): string {
  return scope.kind === "attempt"
    ? `/api/student/attempts/${encodeURIComponent(scope.attemptId)}/events`
    : "/api/student/events";
}

/** 生产默认发送：走 hc 类型客户端（postAttemptEventsApi / postLectureEventsApi） */
function defaultSend(scope: EventScope) {
  return async (events: readonly LearningEvent[]): Promise<void> => {
    if (scope.kind === "attempt") {
      // scope 保证队列内全部为 attempt 事件（调用方只对 attempt scope track 这类事件）
      await postAttemptEventsApi(scope.attemptId, events as AttemptEvent[]);
      return;
    }
    await postLectureEventsApi(events as LectureEvent[]);
  };
}

/** 生产默认 beacon：Blob application/json（同源自动带会话 Cookie） */
function defaultBeacon(scope: EventScope) {
  return (events: readonly LearningEvent[]): boolean => {
    if (typeof navigator === "undefined" || navigator.sendBeacon === undefined)
      return false;
    const blob = new Blob([JSON.stringify({ events: [...events] })], {
      type: "application/json",
    });
    return navigator.sendBeacon(scopeUrl(scope), blob);
  };
}

/** 队列对外 API */
export interface EventQueueApi {
  /** 入队一条事件（clientTs 由调用方填 Date.now()）；队列已终态停止时静默丢弃 */
  track(event: LearningEvent): void;
  /** 立即批量发送（离线时写 IndexedDB；页面隐藏时走 sendBeacon）；终态后 no-op */
  flush(): Promise<void>;
  /** 停止队列：清定时器、移除监听、尽力最后一轮发送 */
  dispose(): void;
  /**
   * 队列是否已因 403/404 终态停止（T2A.6，D7：访问权已失去，不再重试）。
   * 答题页据此提示「已无权限访问该练习」。
   */
  isDenied(): boolean;
}

/** 创建选项（全部可注入，默认值即生产行为） */
export interface EventQueueOptions {
  scope: EventScope;
  /** 发送函数（抛错视为本批失败） */
  send?: (events: readonly LearningEvent[]) => Promise<void>;
  /** sendBeacon 实现（返回 false 视为失败）；传 null 显式禁用 */
  beacon?: ((events: readonly LearningEvent[]) => boolean) | null;
  /** 批量周期毫秒（默认 5000；idle 检查搭同一周期） */
  intervalMs?: number;
}

/**
 * 创建事件队列。副作用：setInterval、visibilitychange / pagehide /
 * online / offline / pointerdown / keydown / scroll / pointermove 监听
 * （attempt scope 注入 page_*；lecture scope 注入 lecture_visible/hidden；
 * 两 scope 注入 net 与 idle 环境事件）。页面卸载/组件卸载时调用 dispose()
 * （内部移除全部监听，lecture scope 补发 lecture_hidden 后尽力 flush）。
 */
export function createEventQueue(options: EventQueueOptions): EventQueueApi {
  const { scope } = options;
  const intervalMs = options.intervalMs ?? EVENT_FLUSH_INTERVAL_MS;
  const send =
    options.send ??
    ((events: readonly LearningEvent[]) => defaultSend(scope)(events));
  const beacon =
    options.beacon === undefined ? defaultBeacon(scope) : options.beacon;

  /** 本实例持久键：scope 前缀 + 随机后缀（两标签页/两次加载互不覆盖，§5.0-A1） */
  const keyPrefix = keyPrefixOf(scope);
  const key = `${keyPrefix}${randomId()}`;
  const legacyKey = legacyKeyOf(scope);
  /** 阅读会话标识：每次页面加载一个随机串（双标签页区间配对用，不含内容） */
  const viewId = randomId();

  /** 内存待发队列 */
  let queue: LearningEvent[] = [];
  /** 一轮发送进行中（并发触发只跑一轮，剩余等下一轮） */
  let flushing = false;
  /**
   * 终态停止标记（T2A.6，D7）：上报收到 403/404（访问权永久失去）后置位——
   * 丢弃待发事件、清离线仓、后续 track/flush 全部 no-op（不得当作网络失败
   * 无限重试）。发送错误为普通网络/5xx 失败时不置位（离线仓重试路径不变）。
   */
  let denied = false;

  /** 注入环境事件（终态停止不注入）；不触发立即发送（搭周期/可见性触发的车） */
  function inject(event: LearningEvent): void {
    if (denied) return;
    queue.push(event);
  }

  // ---------- 环境事件：网络状态（两 scope，§5.0-A3） ----------

  /** 联网基线（online 是常态：只在初始离线与翻转时发事件，离线占比按区间算） */
  let netOnline = typeof navigator !== "undefined" ? navigator.onLine : true;

  /** 网络翻转（online === 基线时不发——window 事件只在翻转时到达，这里再防一手） */
  function noteNet(online: boolean): void {
    if (online === netOnline) return;
    netOnline = online;
    inject({
      type: online ? "net_online" : "net_offline",
      clientTs: Date.now(),
    });
  }

  // 初始离线补发：离线打开 PWA 壳没有翻转事件可听（§5.0-A3）
  if (!netOnline) {
    inject({ type: "net_offline", clientTs: Date.now() });
  }

  // ---------- 环境事件：空闲判定（两 scope，§5.0-A2 惰性判定） ----------

  const idleThresholdMs =
    scope.kind === "attempt"
      ? IDLE_THRESHOLD_ATTEMPT_MS
      : IDLE_THRESHOLD_LECTURE_MS;
  let lastActiveAt = Date.now();
  let idleActive = false;

  /** 用户活动：更新时间戳；空闲中则结束空闲期（每空闲期只一对事件） */
  function noteActivity(): void {
    const now = Date.now();
    lastActiveAt = now;
    if (idleActive) {
      idleActive = false;
      inject({ type: "idle_end", clientTs: now });
    }
  }

  /** 惰性检查：已越过阈值且尚未发 idle_start 时发（低频周期与 visible 恢复时调） */
  function checkIdle(): void {
    if (idleActive) return;
    const now = Date.now();
    if (now - lastActiveAt >= idleThresholdMs) {
      idleActive = true;
      inject({ type: "idle_start", clientTs: now });
    }
  }

  /** pointermove 活动源：位移超过阈值才记（防手搭平板微抖） */
  let lastPointerX: number | null = null;
  let lastPointerY: number | null = null;
  function onPointerMove(event: Event): void {
    // MouseEvent 及其子类 PointerEvent 均带 clientX/Y；测试可派发 MouseEvent
    const { clientX, clientY } = event as MouseEvent;
    if (lastPointerX !== null && lastPointerY !== null) {
      const dx = clientX - lastPointerX;
      const dy = clientY - lastPointerY;
      lastPointerX = clientX;
      lastPointerY = clientY;
      if (dx * dx + dy * dy >= POINTER_MOVE_THRESHOLD_SQ) noteActivity();
      return;
    }
    lastPointerX = clientX;
    lastPointerY = clientY;
  }

  /** scroll 活动源：节流后只更新时间戳（iPad 阅读滚动是主要交互，必算） */
  let lastScrollMark = 0;
  function onScrollActivity(): void {
    const now = Date.now();
    if (now - lastScrollMark < SCROLL_ACTIVITY_THROTTLE_MS) return;
    lastScrollMark = now;
    noteActivity();
  }

  function onActivity(): void {
    noteActivity();
  }

  // ---------- 持久层：前缀扫描 + 逐键删除（§5.0-A1） ----------

  /** 是否为「访问权已失去」的终态错误（403/404，D7/D22；与网络失败区分） */
  function isDeniedError(err: unknown): boolean {
    return (
      err instanceof ApiError && (err.status === 403 || err.status === 404)
    );
  }

  /** 单个持久键的载入形态 */
  interface PersistedEntry {
    key: string;
    events: LearningEvent[];
  }

  /**
   * 扫描本 scope 前缀下全部持久键（含旧版无后缀键）：自己的键、其他实例
   * （双标签页）的键、上次页面被杀遗留的键——一并载入合并发送（§5.0-A1）。
   */
  async function loadPersistedEntries(): Promise<PersistedEntry[]> {
    try {
      const backend = store();
      const scanned = new Set(await backend.keys(keyPrefix));
      scanned.add(legacyKey);
      const entries: PersistedEntry[] = [];
      for (const scanKey of scanned) {
        const value = (await backend.get(scanKey)) as
          | { events?: unknown }
          | null
          | undefined;
        if (Array.isArray(value?.events)) {
          entries.push({
            key: scanKey,
            events: value.events as LearningEvent[],
          });
        }
      }
      return entries;
    } catch (err) {
      console.warn("事件离线仓读取失败（继续用内存队列）", err);
      return [];
    }
  }

  /** 写持久层（自己的键，替换式；吞错但向上反馈：失败时调用方把事件留在内存） */
  async function persist(events: readonly LearningEvent[]): Promise<boolean> {
    try {
      await store().set(key, { events: [...events] });
      return true;
    } catch (err) {
      console.warn("事件离线仓写入失败（事件留在内存队列）", err);
      return false;
    }
  }

  /** 逐键删除（成功送达后清理；吞错：清除失败不影响发送链路） */
  async function deleteKeys(keysToDelete: readonly string[]): Promise<void> {
    for (const delKey of keysToDelete) {
      try {
        await store().del(delKey);
      } catch (err) {
        console.warn("事件离线仓清除失败（不影响发送）", err);
      }
    }
  }

  /** 终态停止：丢弃待发与离线仓内容（含前缀下全部遗留键），界面提示由调用方负责 */
  async function stopDenied(): Promise<void> {
    denied = true;
    queue = [];
    let scanned: string[] = [];
    try {
      scanned = await store().keys(keyPrefix);
    } catch {
      scanned = []; // 存储故障：至少清自己的键
    }
    await deleteKeys([...scanned, key, legacyKey]);
  }

  async function flushNow(): Promise<void> {
    if (denied || flushing) return;
    flushing = true;
    try {
      const entries = await loadPersistedEntries();
      const persisted = entries.flatMap((entry) => entry.events);
      const pending = [...persisted, ...queue];
      queue = [];
      if (pending.length === 0) return;
      // 离线（复用 T2.9 的 navigator.onLine 判定）：合并落自己的键等恢复，
      // 其他键内容已并入 → 一并删除（下轮只从自己的键恢复，不再重复扫出）
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        if (await persist(pending)) {
          await deleteKeys(
            entries.filter((entry) => entry.key !== key).map((e) => e.key),
          );
        } else {
          queue = pending;
        }
        return;
      }
      // 页面隐藏（或即将卸载）→ sendBeacon 兜底；否则正常 POST
      const useBeacon =
        typeof document !== "undefined" &&
        document.visibilityState === "hidden";
      const failed: LearningEvent[] = [];
      let deniedHit = false;
      for (const chunk of chunkBatches(pending)) {
        try {
          if (useBeacon) {
            if (beacon === null || !beacon(chunk)) failed.push(...chunk);
          } else {
            await send(chunk);
          }
        } catch (err) {
          // 403/404 = 访问权终态（D7）：丢弃整批并停止（其余批次一并丢弃）
          if (isDeniedError(err)) {
            console.warn(
              "事件上报被拒（403/404），已停止本练习的事件上报",
              err,
            );
            deniedHit = true;
            break;
          }
          console.warn("事件批量上报失败（已留待重发）", err);
          failed.push(...chunk);
        }
      }
      if (deniedHit) {
        await stopDenied();
        return;
      }
      if (failed.length > 0) {
        // 失败批次写回自己的键（成功部分不回写）；写回成功后其他键可删
        // （其内容已并入 pending，失败部分随 failed 落在自己的键里）
        const persistedOk = await persist(failed);
        if (!persistedOk) queue = [...failed, ...queue];
        if (persistedOk) {
          await deleteKeys(
            entries.filter((entry) => entry.key !== key).map((e) => e.key),
          );
        }
      } else {
        // 全部成功：逐键删除（含自己的键与遗留键）
        await deleteKeys(entries.map((entry) => entry.key));
      }
    } finally {
      flushing = false;
    }
  }

  const timer =
    typeof setInterval === "function"
      ? setInterval(() => {
          // 低频检查搭 flush 周期的车（§5.0-A2：interval 只做「该发 idle_start
          // 了吗」的检查，判定本身基于上次活动时间戳，不依赖心跳计数）
          checkIdle();
          void flushNow();
        }, intervalMs)
      : null;

  function onVisibility(): void {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
      // 隐藏即停表（服务端按事件序列扣减），并立刻兜底发送
      if (scope.kind === "attempt") {
        inject({ type: "page_hidden", clientTs: Date.now() });
      } else {
        inject({
          type: "lecture_hidden",
          clientTs: Date.now(),
          lectureId: scope.lectureId,
          viewId,
        });
      }
      void flushNow();
    } else if (document.visibilityState === "visible") {
      // visible 恢复补检查（后台 timer 挂起可能错过检查点，§5.0-A2）
      checkIdle();
      if (scope.kind === "attempt") {
        inject({ type: "page_visible", clientTs: Date.now() });
      } else {
        inject({
          type: "lecture_visible",
          clientTs: Date.now(),
          lectureId: scope.lectureId,
          viewId,
        });
      }
    }
  }

  function onOnline(): void {
    noteNet(true);
    void flushNow();
  }

  function onOffline(): void {
    noteNet(false);
    void flushNow();
  }

  function onPageHide(): void {
    // 双兜底（§5.0-A4）：pagehide 与 visibilitychange→hidden 都注入
    // lecture_hidden（先到的先入队），允许双发、服务端聚合按重复忽略；
    // attempt scope 不注入（page_* 语义与 activeSec 计算锁定，不引入双发）
    if (scope.kind === "lecture") {
      inject({
        type: "lecture_hidden",
        clientTs: Date.now(),
        lectureId: scope.lectureId,
        viewId,
      });
    }
    void flushNow();
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("pagehide", onPageHide);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    window.addEventListener("pointermove", onPointerMove);
    // scroll 不冒泡：capture 捕获任意滚动容器的滚动（含文档级滚动）
    window.addEventListener("scroll", onScrollActivity, {
      capture: true,
      passive: true,
    });
  }

  // 讲义域：进入讲义页即开始阅读会话（创建时已可见才发；创建时隐藏则等
  // visibilitychange→visible 的注入，会话起点不早于首次可见时刻）
  if (
    scope.kind === "lecture" &&
    typeof document !== "undefined" &&
    document.visibilityState === "visible"
  ) {
    inject({
      type: "lecture_visible",
      clientTs: Date.now(),
      lectureId: scope.lectureId,
      viewId,
    });
  }

  return {
    track(event: LearningEvent): void {
      if (denied) return; // 终态停止：静默丢弃（不再上传）
      queue.push(event);
      // 队列攒到单批上限立即触发（防下一次越过 200 被契约拒绝）
      if (queue.length >= BATCH_MAX) void flushNow();
    },
    flush: flushNow,
    dispose(): void {
      if (timer !== null) clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
        document.removeEventListener("pagehide", onPageHide);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
        window.removeEventListener("pointerdown", onActivity);
        window.removeEventListener("keydown", onActivity);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("scroll", onScrollActivity, {
          capture: true,
        } as EventListenerOptions);
      }
      // 讲义域：离开讲义页（SPA 路由切换不触发 pagehide）即结束阅读会话；
      // 与 pagehide/visibilitychange 的双发由服务端聚合容错（§5.0-A4）
      if (scope.kind === "lecture") {
        inject({
          type: "lecture_hidden",
          clientTs: Date.now(),
          lectureId: scope.lectureId,
          viewId,
        });
      }
      void flushNow();
    },
    isDenied(): boolean {
      return denied;
    },
  };
}
