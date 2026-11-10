import type {
  Memo,
  MemoAnchor,
  MemoCreateMedia,
  MemoCreateText,
  MemoDevice,
  MemoKind,
} from "@tutor/contract";
import { useSyncExternalStore } from "react";
import { ApiError } from "@/lib/api";
import {
  idbKVBackend,
  type KVStoreBackend,
  memoryKVBackend,
} from "@/lib/kv-backend";
import { createTextMemoApi, uploadMemoMediaApi } from "@/lib/memo-api";

/**
 * 随笔待补传队列（模块 5 第一步，计划 §8.2 第 3 条「离线也能记，联网后自动合并
 * （只追加，不会冲突）」）：
 * - 每条随笔先落本机（IndexedDB，媒体 Blob 一并存），再尝试上传；成功即删本机；
 * - 网络层失败（离线 / 超时）保留在队列，联网（online 事件）/ 进页面 / 新记一条时
 *   按入队顺序重试；服务端按 clientId 幂等，重放不产生重复；
 * - 业务拒绝（4xx：格式 / 超限 / 校验）不会自愈：标 failedMessage 留在队列让本人
 *   看到并手动丢弃，不静默删除未同步内容（草稿域同口径）；
 * - 按账号隔离：键前缀带 studentId，布局层 bind / 登出 unbind。
 */
export interface MemoOutboxItem {
  readonly clientId: string;
  readonly kind: MemoKind;
  readonly text: string | undefined;
  readonly anchor: MemoAnchor;
  readonly tags: readonly string[];
  readonly device: MemoDevice;
  readonly recordedAt: string;
  readonly durationSec: number | undefined;
  readonly blob: Blob | undefined;
  /** 服务端业务拒绝的中文说明；有值 = 不再自动重试 */
  readonly failedMessage: string | undefined;
}

export type MemoOutboxInput = Omit<
  MemoOutboxItem,
  "clientId" | "recordedAt" | "failedMessage"
> & { readonly recordedAt?: string | undefined };

const IDB_DB = "tutor-memos";
const IDB_STORE = "outbox";

function defaultBackend(): KVStoreBackend {
  return typeof indexedDB === "undefined"
    ? memoryKVBackend()
    : idbKVBackend(IDB_DB, IDB_STORE);
}

let backend: KVStoreBackend = defaultBackend();
let accountId: string | null = null;
let items: readonly MemoOutboxItem[] = [];
let flushing: Promise<void> | null = null;
const listeners = new Set<() => void>();
const syncedListeners = new Set<(memo: Memo) => void>();

function keyOf(clientId: string): string {
  return JSON.stringify(["memo-outbox", accountId, clientId]);
}

function prefix(): string {
  // 去掉结尾的 "]"，前缀匹配同账号全部条目
  return JSON.stringify(["memo-outbox", accountId]).slice(0, -1);
}

function emit(): void {
  for (const listener of listeners) listener();
}

function setItems(next: readonly MemoOutboxItem[]): void {
  items = next;
  emit();
}

function isItem(value: unknown): value is MemoOutboxItem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { clientId?: unknown }).clientId === "string" &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

/** 布局层按当前学生绑定（null = 登出）；绑定后从本机载入该账号的待传条目并尝试补传 */
export async function bindMemoOutboxAccount(
  studentId: string | null,
): Promise<void> {
  if (accountId === studentId) return;
  accountId = studentId;
  setItems([]);
  if (studentId === null) return;
  try {
    const stored = await backend.getAll(prefix());
    if (accountId !== studentId) return;
    setItems(
      stored
        .map(([, value]) => value)
        .filter(isItem)
        .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)),
    );
  } catch {
    // 本机存储不可用：队列只在内存里活着，这次会话内仍能记、能传
  }
  void flushMemoOutbox();
}

/** 记一条：先落本机，再立即尝试上传；返回时本机已保存（上传结果看队列 / onSynced） */
export async function enqueueMemo(input: MemoOutboxInput): Promise<string> {
  const item: MemoOutboxItem = {
    ...input,
    clientId: crypto.randomUUID(),
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    failedMessage: undefined,
  };
  try {
    await backend.set(keyOf(item.clientId), item);
  } catch {
    // 本机落盘失败仍进内存队列：能传就传，不因存储故障丢这一条
  }
  setItems([...items, item]);
  void flushMemoOutbox();
  return item.clientId;
}

/** 丢弃一条（业务拒绝后由本人决定） */
export async function discardMemoOutboxItem(clientId: string): Promise<void> {
  setItems(items.filter((item) => item.clientId !== clientId));
  try {
    await backend.del(keyOf(clientId));
  } catch {
    // 本机删除失败下次 bind 会再出现，届时仍可丢弃
  }
}

async function upload(item: MemoOutboxItem): Promise<Memo> {
  const common = {
    clientId: item.clientId,
    anchor: item.anchor,
    tags: [...item.tags],
    device: item.device,
    recordedAt: item.recordedAt,
  };
  if (item.kind === "text") {
    const body: MemoCreateText = { ...common, text: item.text ?? "" };
    return createTextMemoApi(body);
  }
  if (item.blob === undefined) {
    throw new ApiError("MEMO_MEDIA_MISSING", "这条随笔的媒体内容丢失", 400);
  }
  const fields: MemoCreateMedia = {
    ...common,
    kind: item.kind,
    ...(item.text !== undefined && item.text !== "" ? { text: item.text } : {}),
    ...(item.durationSec !== undefined
      ? { durationSec: item.durationSec }
      : {}),
  };
  return uploadMemoMediaApi(item.blob, fields);
}

/** 按入队顺序补传；网络层失败即停（等下次触发），业务拒绝标 failedMessage 后继续下一条 */
export function flushMemoOutbox(): Promise<void> {
  if (flushing !== null) return flushing;
  const account = accountId;
  flushing = (async () => {
    // 每轮重新从当前队列取「还没试过、没被拒绝」的第一条：补传期间新记的也在本轮传完
    const attempted = new Set<string>();
    for (;;) {
      if (account === null || accountId !== account) return;
      const item = items.find(
        (it) => it.failedMessage === undefined && !attempted.has(it.clientId),
      );
      if (item === undefined) return;
      attempted.add(item.clientId);
      try {
        const memo = await upload(item);
        setItems(items.filter((it) => it.clientId !== item.clientId));
        try {
          await backend.del(keyOf(item.clientId));
        } catch {
          // 已在服务端：下次 bind 重放只会命中幂等键，无害
        }
        for (const listener of syncedListeners) listener(memo);
      } catch (err) {
        if (err instanceof ApiError) {
          const failed: MemoOutboxItem = {
            ...item,
            failedMessage: err.message,
          };
          setItems(
            items.map((it) => (it.clientId === item.clientId ? failed : it)),
          );
          try {
            await backend.set(keyOf(item.clientId), failed);
          } catch {
            // 标记只影响是否自动重试，落盘失败可接受
          }
          continue;
        }
        // 网络 / 本机解析类失败：保留原样，等下次触发
        return;
      }
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMemoOutbox(): readonly MemoOutboxItem[] {
  return useSyncExternalStore(
    subscribe,
    () => items,
    () => items,
  );
}

/** 某条补传成功时回调（页面据此刷新列表） */
export function onMemoSynced(listener: (memo: Memo) => void): () => void {
  syncedListeners.add(listener);
  return () => {
    syncedListeners.delete(listener);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    void flushMemoOutbox();
  });
}

/** 测试用：换后端并清空状态 */
export function installMemoOutboxBackendForTest(
  next: KVStoreBackend | null,
): void {
  backend = next ?? defaultBackend();
  accountId = null;
  flushing = null;
  setItems([]);
}
