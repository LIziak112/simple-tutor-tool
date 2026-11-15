/**
 * 工具箱记忆：各支工具的设置（笔的颜色粗细、荧光笔的颜色粗细线条、橡皮的方式
 * 大小、形状的种类）按账号记在本机，换一道题、刷新页面、下次打开都还是上回的
 * 样子。
 *
 * - 按场景分开记：草稿纸一类（草稿纸、正式手写、随笔）共用一份，题面圈画（连
 *   同材料圈画）另记一份——圈画缺省是红色细笔，不该被草稿纸的黑笔带走。
 * - 当前选中的是哪支工具不记：每张纸打开都是笔，免得上回停在橡皮上，这回一
 *   落笔先擦掉东西。
 * - 账号跟笔感设置用同一个（ink-profile-store 绑定的那个）；没有账号时不记，
 *   工具箱只是所在组件自己的状态。
 * - 同一场景同时挂着的几处（一页上好几道题的草稿纸）共用这一份：一处改了，
 *   其余立即跟上。
 * - 只存在浏览器的 localStorage 里，不上传；读不懂、存不进去都不报错。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { type InkToolboxState, parseInkToolbox } from "./engine/toolbox.ts";
import type { InkPenBase } from "./engine/types.ts";
import {
  getInkProfileAccount,
  subscribeInkProfileSelection,
} from "./ink-profile-store";

const SCOPES = ["paper", "annotation"] as const;
/** 记忆的场景：paper 草稿纸一类，annotation 题面圈画 */
export type InkToolboxScope = (typeof SCOPES)[number];

/**
 * 一个场景里记住的内容。原样存取，读回时再逐字段校验（见
 * resolveRememberedToolbox）：档位以后增减，旧数据里不认识的值自动回缺省。
 * penBasis 是记下这支笔时笔感设置里的颜色粗细，只有笔跟随笔感设置的场景才有。
 */
export type RememberedTools = Readonly<Record<string, unknown>>;

type Scopes = Readonly<Partial<Record<InkToolboxScope, RememberedTools>>>;

const VERSION = 1;
const NOTHING: RememberedTools = Object.freeze({});
const listeners = new Set<() => void>();
/** 已读入的那个账号的内容；undefined 表示要重新读 */
let loaded: { key: string | null; scopes: Scopes } | undefined;

function storageKey(): string | null {
  const account = getInkProfileAccount();
  return account
    ? `ownclass:ink-toolbox:${JSON.stringify([location.origin, account.role, account.id])}`
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function read(key: string): Scopes {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!isRecord(parsed) || parsed.version !== VERSION) return {};
    if (!isRecord(parsed.scopes)) return {};
    const scopes: Partial<Record<InkToolboxScope, RememberedTools>> = {};
    for (const scope of SCOPES) {
      const value = parsed.scopes[scope];
      if (isRecord(value)) scopes[scope] = value;
    }
    return scopes;
  } catch {
    return {};
  }
}

function current(): Scopes | null {
  const key = storageKey();
  if (loaded?.key !== key)
    loaded = { key, scopes: key === null ? {} : read(key) };
  return key === null ? null : loaded.scopes;
}

function notify() {
  for (const listener of [...listeners]) listener();
}

function commit(scopes: Scopes) {
  const key = storageKey();
  if (key === null) return;
  loaded = { key, scopes };
  try {
    localStorage.setItem(key, JSON.stringify({ version: VERSION, scopes }));
  } catch {
    // 存不进去（空间满、隐私模式）：这一次打开期间照常生效，只是下次不记得
  }
  notify();
}

// 登录、退出、换账号时笔感设置会发通知：账号变了就重新读
subscribeInkProfileSelection(() => {
  if (loaded !== undefined && loaded.key !== storageKey()) {
    loaded = undefined;
    notify();
  }
});
// 另一个标签页改了同一份：重新读
window.addEventListener("storage", (event) => {
  if (event.storageArea !== localStorage || loaded === undefined) return;
  if (event.key !== null && event.key !== loaded.key) return;
  loaded = undefined;
  notify();
});

/** 当前账号在这个场景里记住的内容；没有账号时为 null（不记忆） */
export function getRememberedTools(
  scope: InkToolboxScope,
): RememberedTools | null {
  const scopes = current();
  return scopes === null ? null : (scopes[scope] ?? NOTHING);
}

export function subscribeRememberedTools(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 记下这个场景各支工具的设置（当前工具不记）。penBasis 给出时一并记下：以后
 * 笔感设置里的颜色粗细和它不一样了，记住的笔就不再算数。没有账号时什么也不做。
 */
export function rememberInkToolbox(
  scope: InkToolboxScope,
  toolbox: InkToolboxState,
  penBasis?: InkPenBase,
) {
  const scopes = current();
  if (scopes === null) return;
  const next: RememberedTools = {
    pen: toolbox.pen,
    highlighter: toolbox.highlighter,
    eraser: toolbox.eraser,
    shape: toolbox.shape,
    ...(penBasis
      ? { penBasis: { color: penBasis.color, size: penBasis.size } }
      : {}),
  };
  if (JSON.stringify(next) === JSON.stringify(scopes[scope])) return;
  commit({ ...scopes, [scope]: next });
}

/** 丢掉这个场景记住的笔（其余工具照旧）：笔感设置里的颜色粗细变了之后调用 */
export function forgetRememberedPen(scope: InkToolboxScope) {
  const scopes = current();
  const remembered = scopes?.[scope];
  if (!scopes || !remembered) return;
  if (!("pen" in remembered) && !("penBasis" in remembered)) return;
  const { pen: _pen, penBasis: _penBasis, ...rest } = remembered;
  commit({ ...scopes, [scope]: rest });
}

function samePen(value: unknown, pen: InkPenBase): boolean {
  return (
    isRecord(value) && value.color === pen.color && value.size === pen.size
  );
}

/**
 * 把记住的内容还原成工具箱：逐字段校验，非法或没记过的字段取 defaults 的值，
 * 当前工具取 defaults 的。profilePen 给出时（笔跟随笔感设置的场景），记住的笔
 * 只在「记下它时的设置」和现在的设置一样时才算数。
 */
export function resolveRememberedToolbox(
  remembered: RememberedTools,
  defaults: InkToolboxState,
  profilePen?: InkPenBase,
): InkToolboxState {
  const penCounts =
    profilePen === undefined || samePen(remembered.penBasis, profilePen);
  return parseInkToolbox(
    {
      pen: penCounts ? remembered.pen : undefined,
      highlighter: remembered.highlighter,
      eraser: remembered.eraser,
      shape: remembered.shape,
    },
    defaults,
  );
}

/**
 * 宿主的工具箱状态，用法同 useState。有账号时各工具的设置取自本机记忆，改动
 * 随手记下；没有账号时就是组件自己的状态。当前工具始终是组件自己的。
 *
 * @param initial 缺省工具箱，只在挂载时取一次
 * @param profilePen 笔跟随笔感设置的宿主传入设置里的颜色粗细：设置变了，笔
 *   重新取设置里的值，记住的笔作废
 */
export function useRememberedToolbox(
  scope: InkToolboxScope,
  initial: () => InkToolboxState,
  profilePen?: InkPenBase,
): readonly [InkToolboxState, (next: InkToolboxState) => void] {
  const [base] = useState(initial);
  const [local, setLocal] = useState(base);
  const remembered = useSyncExternalStore(
    subscribeRememberedTools,
    () => getRememberedTools(scope),
    () => getRememberedTools(scope),
  );
  const penColor = profilePen?.color;
  const penSize = profilePen?.size;
  const pen = useMemo(
    () =>
      penColor === undefined || penSize === undefined
        ? undefined
        : { color: penColor, size: penSize },
    [penColor, penSize],
  );

  // 组件自己的那份：笔感设置变了，笔重新取设置里的值
  useEffect(() => {
    if (!pen) return;
    setLocal((value) =>
      value.pen.color === pen.color && value.pen.size === pen.size
        ? value
        : { ...value, pen },
    );
  }, [pen]);

  // 记住的笔是在另一套笔感设置下选的：作废，免得换回原设置时又冒出来
  const stale =
    remembered !== null &&
    pen !== undefined &&
    "pen" in remembered &&
    !samePen(remembered.penBasis, pen);
  useEffect(() => {
    if (stale) forgetRememberedPen(scope);
  }, [stale, scope]);

  const settings = useMemo(
    () =>
      remembered === null
        ? null
        : resolveRememberedToolbox(
            remembered,
            pen ? { ...base, pen } : base,
            pen,
          ),
    [remembered, base, pen],
  );
  const active = local.active;
  const rememberedToolbox = useMemo(() => {
    if (settings === null) return null;
    return settings.active === active ? settings : { ...settings, active };
  }, [settings, active]);
  const toolbox = rememberedToolbox ?? local;

  const setToolbox = useCallback(
    (next: InkToolboxState) => {
      setLocal(next);
      rememberInkToolbox(scope, next, pen);
    },
    [scope, pen],
  );
  return [toolbox, setToolbox];
}
