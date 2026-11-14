import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { sharedMemosApi } from "@/lib/memo-enhancement-api";
import { MemoTime } from "./MemoMetadata";
/** 默认折叠，教师主页首屏不请求随笔；只渲染独立授权投影。 */
export function SharedMemosSection({ studentId }: { studentId: string }) {
  const [open, setOpen] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ["teacher", "shared-memos", studentId],
    queryFn: ({ pageParam }) =>
      sharedMemosApi(studentId, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
    enabled: open,
    retry: false,
  });
  return (
    <section className="flex flex-col gap-3" aria-label="学生分享的随笔">
      <button
        type="button"
        className="min-h-11 w-fit text-sm font-semibold"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        学生分享的随笔
      </button>
      {open && (
        <>
          <p className="text-xs text-muted-foreground">
            这里只显示学生逐条分享的内容；学生可随时撤回。
          </p>
          {query.isPending && <p>正在加载…</p>}
          {query.isError && (
            <button type="button" onClick={() => void query.refetch()}>
              加载失败，重试
            </button>
          )}
          {query.data?.pages
            .flatMap((p) => p.memos)
            .map((m) => {
              const media = `/api/teacher/students/${encodeURIComponent(studentId)}/memos/${encodeURIComponent(m.id)}/media`;
              return (
                <article
                  key={m.id}
                  className="flex flex-col gap-2 rounded border p-3"
                >
                  <p className="text-xs">
                    {m.seq ? `#${m.seq} · ` : ""}
                    <MemoTime recordedAt={m.recordedAt} />
                  </p>
                  {m.text && (
                    <p className="whitespace-pre-wrap text-sm">{m.text}</p>
                  )}
                  {m.kind === "voice" && (
                    // biome-ignore lint/a11y/useMediaCaption: 原始语音由学生逐条授权
                    <audio controls preload="none" src={media} />
                  )}
                  {(m.kind === "image" || m.kind === "ink") && (
                    <img
                      src={media}
                      alt="学生分享的随笔"
                      loading="lazy"
                      className="max-h-72 object-contain"
                    />
                  )}
                  {m.sourceLabel && <p className="text-xs">{m.sourceLabel}</p>}
                  <p className="text-xs">{m.tags.join(" · ")}</p>
                </article>
              );
            })}
          {query.data?.pages[0]?.memos.length === 0 && (
            <p>暂无学生分享的随笔</p>
          )}
          {query.hasNextPage && (
            <button
              type="button"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              加载更早的
            </button>
          )}
        </>
      )}
    </section>
  );
}
