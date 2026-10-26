import type { StudentAiDisplayLayout } from "@tutor/contract";
import { Check, Columns2, LayoutPanelTop, Rows2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  saveAiDisplayPreference,
  useAiDisplayPreference,
} from "./ai-display-preference-store";

const options = [
  {
    value: "inline",
    title: "题下阅读",
    description: "在当前题目下方展开，跟随页面阅读。",
    icon: Rows2,
  },
  {
    value: "side",
    title: "侧边对照",
    description: "在题目右侧查看回复，方便边看边写。空间不足时暂用弹窗。",
    icon: Columns2,
  },
  {
    value: "dialog",
    title: "独立弹窗",
    description: "在独立窗口中阅读和追问，关闭后回到原题。",
    icon: LayoutPanelTop,
  },
] as const;

export function StudentAiDisplaySection() {
  const saved = useAiDisplayPreference();
  const [draft, setDraft] = useState<{
    layout: StudentAiDisplayLayout;
    base: StudentAiDisplayLayout;
    owner: string | null;
  } | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(
    null,
  );
  const selected = draft?.layout ?? saved.layout;
  const dirty = draft !== null && draft.layout !== saved.layout;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const leave = (event: MouseEvent) => {
      if (
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      )
        return;
      const link = event.target.closest<HTMLAnchorElement>("a[href]");
      if (
        !link ||
        link.target === "_blank" ||
        link.hasAttribute("download") ||
        link.getAttribute("href")?.startsWith("#")
      )
        return;
      if (!window.confirm("显示方式尚未保存，放弃更改并离开？")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", leave, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", leave, true);
    };
  }, [dirty]);
  return (
    <section
      id="ai-display"
      aria-labelledby="ai-display-title"
      className="scroll-mt-24 space-y-4 rounded-xl border border-border bg-card p-5 sm:p-6"
    >
      <div className="space-y-1">
        <h3 id="ai-display-title" className="font-semibold">
          助教显示方式
        </h3>
        <p id="ai-display-scope" className="text-sm text-muted-foreground">
          仅用于当前账号在此浏览器中的显示方式。
        </p>
      </div>
      <fieldset
        aria-describedby="ai-display-scope"
        className="grid min-w-0 gap-3 sm:grid-cols-3"
      >
        <legend className="sr-only">选择助教显示方式</legend>
        {options.map(({ value, title, description, icon: Icon }) => (
          <label
            key={value}
            className={`relative flex min-w-0 cursor-pointer flex-col gap-3 rounded-lg border p-4 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 ${selected === value ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"}`}
          >
            <input
              className="absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0"
              type="radio"
              name="ai-display-layout"
              value={value}
              checked={selected === value}
              onChange={() => {
                setDraft({
                  layout: value,
                  base: draft?.base ?? saved.layout,
                  owner: saved.accountId,
                });
                setNotice(null);
              }}
            />
            <span
              aria-hidden
              className="flex items-center justify-between text-primary"
            >
              <Icon className="size-7" />
              {selected === value && <Check className="size-4" />}
            </span>
            <span className="font-medium">{title}</span>
            <span className="text-sm leading-6 text-muted-foreground">
              {description}
            </span>
          </label>
        ))}
      </fieldset>
      {draft && draft.base !== saved.layout && (
        <p className="text-sm text-muted-foreground">
          其他页面已修改显示方式，你的选择已保留。
          <Button
            variant="link"
            className="min-h-11"
            onClick={() => {
              setDraft(null);
              setNotice(null);
            }}
          >
            载入已保存值
          </Button>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          className="min-h-11"
          disabled={!dirty}
          onClick={() => {
            try {
              saveAiDisplayPreference(selected, draft?.owner);
              setDraft(null);
              setNotice({ error: false, text: "显示方式已保存" });
            } catch {
              setNotice({
                error: true,
                text: "未能保存显示方式，请确认账号和浏览器存储后重试。",
              });
            }
          }}
        >
          保存显示方式
        </Button>
        {dirty && (
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => {
              setDraft(null);
              setNotice(null);
            }}
          >
            取消更改
          </Button>
        )}
        {dirty && (
          <span className="text-sm text-muted-foreground">有未保存更改</span>
        )}
      </div>
      {notice && (
        <p
          role={notice.error ? "alert" : "status"}
          className={`text-sm ${notice.error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {notice.text}
        </p>
      )}
    </section>
  );
}
