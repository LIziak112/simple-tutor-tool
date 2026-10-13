import { createContext, type ReactNode, useContext, useState } from "react";
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

const SettingsNavigationContext = createContext<{
  setDraft: (draft: { dirty: boolean; discard: () => void }) => void;
  leave: (action: () => void) => void;
} | null>(null);

/** 只拦截会离开设置的普通导航，分类切换与新窗口打开仍使用浏览器默认行为。 */
export function SettingsNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<{ dirty: boolean; discard: () => void }>({
    dirty: false,
    discard: () => {},
  });
  const [pending, setPending] = useState<{ action: () => void } | null>(null);
  function leave(action: () => void) {
    if (draft.dirty) setPending({ action });
    else action();
  }
  return (
    <SettingsNavigationContext value={{ setDraft, leave }}>
      <div
        onClickCapture={(event) => {
          if (
            !draft.dirty ||
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
              学生作答方式尚未保存。继续编辑，或放弃本次更改后离开。
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
                draft.discard();
                setDraft({ dirty: false, discard: () => {} });
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
