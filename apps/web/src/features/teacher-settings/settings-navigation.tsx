import {
  createContext,
  type ReactNode,
  useContext,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 设置页未保存草稿注册表。同一分类下可有多个配置区（teaching 分类：
 * 辅助能力 + AI 伴学），按 id 键控注册：任一区 dirty 即拦截离开，
 * 确认放弃时全部 discard。
 */
const SettingsNavigationContext = createContext<{
  setDraft: (
    id: string,
    draft: { dirty: boolean; discard: () => void },
  ) => void;
  leave: (action: () => void) => void;
} | null>(null);

/** 只拦截会离开设置的普通导航，分类切换与新窗口打开仍使用浏览器默认行为。 */
export function SettingsNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState<
    Record<string, { dirty: boolean; discard: () => void }>
  >({});
  const [pending, setPending] = useState<{ action: () => void } | null>(null);
  function setDraft(
    id: string,
    draft: { dirty: boolean; discard: () => void },
  ) {
    setDrafts((prev) => ({ ...prev, [id]: draft }));
  }
  const dirtyEntries = Object.entries(drafts).filter(([, d]) => d.dirty);
  function leave(action: () => void) {
    if (dirtyEntries.length > 0) setPending({ action });
    else action();
  }
  return (
    <SettingsNavigationContext value={{ setDraft, leave }}>
      <div
        onClickCapture={(event) => {
          if (
            dirtyEntries.length === 0 ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            event.shiftKey ||
            !(event.target instanceof Element)
          )
            return;
          const link = event.target.closest("a");
          if (
            !link ||
            link.target === "_blank" ||
            link.hasAttribute("download")
          )
            return;
          const url = new URL(link.href);
          if (
            url.origin !== window.location.origin ||
            url.pathname === "/t/settings" ||
            link.getAttribute("href")?.startsWith("#")
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          leave(() => navigate(`${url.pathname}${url.search}${url.hash}`));
        }}
      >
        {children}
      </div>
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogContent className="teacher-theme">
          <DialogHeader>
            <DialogTitle>放弃未保存的更改？</DialogTitle>
            <DialogDescription>
              有设置尚未保存。继续编辑，或放弃本次更改后离开。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setPending(null)}
            >
              继续编辑
            </Button>
            <Button
              className="min-h-11"
              onClick={() => {
                const action = pending?.action;
                for (const [, draft] of dirtyEntries) draft.discard();
                setDrafts({});
                setPending(null);
                action?.();
              }}
            >
              放弃更改并离开
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsNavigationContext>
  );
}

export function useSettingsNavigation() {
  return useContext(SettingsNavigationContext);
}
