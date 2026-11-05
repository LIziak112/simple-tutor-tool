import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import {
  applyPwaUpdate,
  dismissPwaUpdate,
  getPwaUpdateSnapshot,
  subscribePwaUpdate,
} from "@/lib/pwa";

/** 不抢焦点、不自动刷新；保存期间仍让提示处于可访问树中。 */
export function PwaUpdateNotice() {
  const state = useSyncExternalStore(
    subscribePwaUpdate,
    getPwaUpdateSnapshot,
    getPwaUpdateSnapshot,
  );
  if (!state.available || state.dismissed) return null;
  return createPortal(
    <aside
      aria-label="版本更新"
      className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+16px)] z-50 mx-auto max-w-md rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
    >
      <div role="status" aria-live="polite">
        <p className="text-sm font-semibold">发现新版本</p>
        <p className="mt-1 text-sm text-muted-foreground">
          更新前会先保存作答和手写。你也可以稍后更新，继续当前操作。
        </p>
        {state.busy && (
          <p className="mt-2 text-sm">正在保存，请保持页面打开…</p>
        )}
      </div>
      {state.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {state.error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          className="min-h-11"
          disabled={state.busy}
          onClick={dismissPwaUpdate}
        >
          稍后
        </Button>
        <Button
          className="min-h-11"
          disabled={state.busy}
          onClick={() => void applyPwaUpdate()}
        >
          {state.busy
            ? "正在保存并更新…"
            : state.error
              ? "重试保存并更新"
              : "保存并更新"}
        </Button>
      </div>
    </aside>,
    document.body,
  );
}
