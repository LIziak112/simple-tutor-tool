import type { MemoKind } from "@tutor/contract";
import { MEMO_KIND_LABEL, memoKindSchema } from "@tutor/contract";
import { NotebookPen } from "lucide-react";
import { useSearchParams } from "react-router";
import { MemoComposer } from "@/features/memos/MemoComposer";
import { MemoList } from "@/features/memos/MemoList";
import { StudentPageHeader } from "@/features/student/student-ui";

/**
 * /s/memos 随笔（模块 5 第一步「记录端」）：顶部常驻记录端（文字 / 语音 / 图片 /
 * 手写），下方按记录时间倒序的列表；按形态 / 标签筛选走 URL（?kind=voice&tag=易错）。
 * 默认仅本人；整理稿（Agent 空闲整理）归模块 5 第二步。
 */
export function StudentMemosPage() {
  const [params, setParams] = useSearchParams();
  const kindParsed = memoKindSchema.safeParse(params.get("kind"));
  const kind: MemoKind | undefined = kindParsed.success
    ? kindParsed.data
    : undefined;
  const rawSeq = Number(params.get("seq"));
  const seq = Number.isSafeInteger(rawSeq) && rawSeq > 0 ? rawSeq : undefined;
  const rawParent = Number(params.get("parentMemoSeq"));
  const parentMemoSeq =
    Number.isSafeInteger(rawParent) && rawParent > 0 ? rawParent : undefined;
  const tag = params.get("tag") ?? undefined;

  function setKind(next: MemoKind | undefined): void {
    const copy = new URLSearchParams(params);
    if (next === undefined) copy.delete("kind");
    else copy.set("kind", next);
    setParams(copy, { replace: true });
  }

  return (
    <div className="flex flex-col gap-6">
      <StudentPageHeader
        icon={<NotebookPen />}
        title="随笔"
        description="想法、疑问、易错点随手记；任何设备、离线也行。默认仅本人和授权的 Agent 可见；你可以逐条分享给自己的教师。"
      />
      <section
        aria-label="记一条"
        className="rounded-2xl border border-border bg-card p-4"
      >
        <MemoComposer />
      </section>
      <section aria-label="随笔列表" className="flex flex-col gap-3">
        <div
          role="tablist"
          aria-label="按形态筛选"
          className="flex flex-wrap gap-1 rounded-xl bg-muted p-1"
        >
          {(
            [undefined, ...memoKindSchema.options] as (MemoKind | undefined)[]
          ).map((option) => (
            <button
              key={option ?? "all"}
              type="button"
              role="tab"
              aria-selected={kind === option}
              onClick={() => setKind(option)}
              className={`min-h-9 flex-1 rounded-lg px-2 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 ${
                kind === option
                  ? "bg-card text-primary shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {option === undefined ? "全部" : MEMO_KIND_LABEL[option]}
            </button>
          ))}
        </div>
        {tag !== undefined && (
          <p className="text-sm text-muted-foreground">
            只看标签 #{tag}{" "}
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              onClick={() => {
                const copy = new URLSearchParams(params);
                copy.delete("tag");
                setParams(copy, { replace: true });
              }}
            >
              清除
            </button>
          </p>
        )}
        {parentMemoSeq !== undefined && (
          <p>
            随笔 #{parentMemoSeq} 的关联条目{" "}
            <button
              type="button"
              className="min-h-11 text-primary underline"
              onClick={() => {
                const copy = new URLSearchParams();
                copy.set("seq", String(parentMemoSeq));
                setParams(copy);
              }}
            >
              查看原随笔
            </button>{" "}
            <button
              type="button"
              className="min-h-11"
              onClick={() => setParams({})}
            >
              显示全部
            </button>
          </p>
        )}
        {seq !== undefined && parentMemoSeq === undefined && (
          <p>
            只看随笔 #{seq}{" "}
            <button
              type="button"
              onClick={() => {
                const copy = new URLSearchParams(params);
                copy.delete("seq");
                setParams(copy);
              }}
            >
              显示全部
            </button>
          </p>
        )}
        <MemoList
          filter={{
            ...(parentMemoSeq === undefined
              ? seq === undefined
                ? {}
                : { seq }
              : { parentMemoSeq }),
            ...(kind === undefined ? {} : { kind }),
            ...(tag === undefined ? {} : { tag }),
          }}
        />
      </section>
    </div>
  );
}

export default StudentMemosPage;
