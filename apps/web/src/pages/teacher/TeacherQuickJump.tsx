import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

export interface QuickJumpItem {
  to: string;
  label: string;
  group: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  keywords?: string;
}

/**
 * 2026-11 壳层重构：教师端全局快速跳转（⌘K / Ctrl+K / 「/」）。
 * 九个一级入口不必逐项在侧栏里找；键盘 ↑↓ 选择、Enter 前往、Esc 关闭。
 * 只在打开时挂载内容，关闭时不在可访问树里重复出现导航链接。
 */
export function TeacherQuickJump({ items }: { items: QuickJumpItem[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      `${item.label} ${item.group} ${item.keywords ?? ""} ${item.to}`
        .toLowerCase()
        .includes(q),
    );
  }, [items, query]);

  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) {
      setQuery("");
      setActive(0);
    }
  }

  function go(item: QuickJumpItem | undefined) {
    if (!item) return;
    changeOpen(false);
    navigate(item.to);
  }

  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform);
  const activeItem = results[active];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="快速跳转"
        aria-keyshortcuts="Meta+K Control+K /"
        className="ml-auto flex min-h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-muted-foreground transition-[color,border-color,transform] duration-150 hover:border-primary/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary active:scale-[0.98] sm:min-w-64"
      >
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="hidden flex-1 text-left sm:inline">跳转到…</span>
        <kbd className="hidden rounded border border-border bg-muted px-1.5 font-mono text-[11px] sm:inline">
          {isMac ? "⌘K" : "Ctrl K"}
        </kbd>
      </button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="teacher-theme top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg">
          <DialogTitle className="sr-only">快速跳转</DialogTitle>
          <DialogDescription className="sr-only">
            输入页面名称筛选，方向键选择，回车前往
          </DialogDescription>
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
            <input
              role="combobox"
              aria-expanded
              aria-controls="teacher-quick-jump-list"
              aria-activedescendant={
                activeItem ? `qj-${activeItem.to}` : undefined
              }
              aria-label="搜索页面"
              placeholder="搜索页面：资源库、作业、导出…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((i) => Math.min(i + 1, results.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  go(activeItem);
                }
              }}
              className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div
            id="teacher-quick-jump-list"
            role="listbox"
            aria-label="页面"
            className="max-h-80 overflow-y-auto overscroll-contain p-2"
          >
            {results.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                没有匹配「{query}」的页面
              </p>
            )}
            {results.map((item, i) => (
              <div
                key={item.to}
                id={`qj-${item.to}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                onMouseMove={() => setActive(i)}
                onClick={() => go(item)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") go(item);
                }}
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm ${
                  i === active
                    ? "bg-sidebar-accent text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                <item.icon aria-hidden className="size-4 shrink-0" />
                <span className="flex-1 font-medium text-foreground">
                  {item.label}
                </span>
                <span className="text-xs">{item.group}</span>
                {i === active && (
                  <CornerDownLeft aria-hidden className="size-3.5 shrink-0" />
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
