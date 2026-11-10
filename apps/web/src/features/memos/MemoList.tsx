import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { Memo, MemoKind, MemoListQuery } from "@tutor/contract";
import {
  formatMemoDuration,
  MEMO_KIND_LABEL,
  memoMediaUrl,
} from "@tutor/contract";
import { Bot, CloudOff, Loader2, MapPin, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  StudentEmptyState,
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";
import { deleteMemoApi, listMemosApi } from "@/lib/memo-api";
import { formatRelativeTime } from "@/lib/time";
import {
  MEMO_DEVICE_LABEL,
  memoAnchorHref,
  memoAnchorLabel,
} from "./memo-format";
import {
  discardMemoOutboxItem,
  type MemoOutboxItem,
  onMemoSynced,
  useMemoOutbox,
} from "./memo-outbox";

/** 随笔列表的 react-query key（页面与随手记浮层共用，补传成功后统一失效） */
export const MEMO_LIST_KEY = ["student", "memos"] as const;

/**
 * 随笔列表（模块 5 第一步）：本机待传条目置顶（灰底、带「待补传 / 上传失败」），
 * 其下是服务端记录时间倒序的游标分页；每条按形态渲染（文字 / <audio> / <img>），
 * 带锚（可点回当时的题 / 讲义）、标签、时间、设备、Agent 转记标识与删除。
 */
export function MemoList({ filter = {} }: { filter?: MemoListQuery }) {
  const queryClient = useQueryClient();
  const outbox = useMemoOutbox();
  const query = useInfiniteQuery({
    queryKey: [...MEMO_LIST_KEY, filter],
    queryFn: ({ pageParam }) =>
      listMemosApi({
        ...filter,
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  useEffect(
    () =>
      onMemoSynced(() => {
        void queryClient.invalidateQueries({ queryKey: MEMO_LIST_KEY });
      }),
    [queryClient],
  );
  const remove = useMutation({
    mutationFn: (id: string) => deleteMemoApi(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MEMO_LIST_KEY }),
  });

  if (query.isPending) return <StudentListSkeleton label="正在加载随笔" />;
  if (query.isError) {
    return (
      <StudentErrorPanel
        title="随笔加载失败"
        message={
          query.error instanceof Error ? query.error.message : "请稍后重试"
        }
        onRetry={() => void query.refetch()}
      />
    );
  }
  const memos = query.data.pages.flatMap((page) => page.memos);
  const matchesFilter = (item: MemoOutboxItem): boolean =>
    (filter.kind === undefined || item.kind === filter.kind) &&
    (filter.tag === undefined || item.tags.includes(filter.tag));
  const pending = outbox.filter(matchesFilter);

  if (memos.length === 0 && pending.length === 0) {
    return (
      <StudentEmptyState
        title="还没有随笔"
        description="想法、疑问、易错点，随手记下来；联网后自动同步，Agent 也能读到。"
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {pending.map((item) => (
        <PendingMemoCard key={item.clientId} item={item} />
      ))}
      <ul className="flex flex-col gap-3">
        {memos.map((memo) => (
          <li key={memo.id}>
            <MemoCard
              memo={memo}
              deleting={remove.isPending && remove.variables === memo.id}
              onDelete={() => remove.mutate(memo.id)}
            />
          </li>
        ))}
      </ul>
      {remove.isError && (
        <p role="alert" className="text-sm text-destructive">
          {remove.error instanceof Error ? remove.error.message : "删除失败"}
        </p>
      )}
      {query.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage && (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          )}
          加载更早的
        </Button>
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: MemoKind }) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      {MEMO_KIND_LABEL[kind]}
    </span>
  );
}

function MemoCard({
  memo,
  deleting,
  onDelete,
}: {
  memo: Memo;
  deleting: boolean;
  onDelete: () => void;
}) {
  const anchorLabel = memoAnchorLabel(memo.anchor);
  const anchorHref = memoAnchorHref(memo.anchor);
  const mediaUrl = memoMediaUrl(memo.id);
  return (
    <article className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <KindBadge kind={memo.kind} />
        {memo.source === "agent" && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary">
            <Bot aria-hidden className="size-3" />
            Agent 转记
          </span>
        )}
        <time dateTime={memo.recordedAt}>
          {formatRelativeTime(memo.recordedAt)}
        </time>
        <span>· {MEMO_DEVICE_LABEL[memo.device]}</span>
        {memo.media?.durationSec != null && (
          <span>· {formatMemoDuration(memo.media.durationSec)}</span>
        )}
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="删除这条随笔"
          disabled={deleting}
          onClick={onDelete}
        >
          {deleting ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
          ) : (
            <Trash2 aria-hidden className="size-3.5" />
          )}
        </Button>
      </div>
      {memo.kind === "voice" && (
        // biome-ignore lint/a11y/useMediaCaption: 随笔原声回放；转写由 Agent 另记一条
        <audio controls preload="none" src={mediaUrl} className="w-full" />
      )}
      {(memo.kind === "image" || memo.kind === "ink") && (
        <a href={mediaUrl} target="_blank" rel="noreferrer">
          <img
            src={mediaUrl}
            alt={memo.kind === "ink" ? "手写随笔" : "图片随笔"}
            loading="lazy"
            className="max-h-72 rounded-lg border border-border bg-white object-contain"
          />
        </a>
      )}
      {memo.text !== null && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed">
          {memo.text}
        </p>
      )}
      {(anchorLabel !== null || memo.tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {anchorLabel !== null &&
            (anchorHref !== null ? (
              <Link
                to={anchorHref}
                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
              >
                <MapPin aria-hidden className="size-3" />
                {anchorLabel}
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <MapPin aria-hidden className="size-3" />
                {anchorLabel}
              </span>
            ))}
          {memo.tags.map((tag) => (
            <span key={tag} className="rounded-full bg-muted px-2 py-0.5">
              #{tag}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function PendingMemoCard({ item }: { item: MemoOutboxItem }) {
  const failed = item.failedMessage !== undefined;
  return (
    <article
      aria-label={failed ? "上传失败的随笔" : "待补传的随笔"}
      className={`flex flex-col gap-2 rounded-xl border border-dashed p-3 ${
        failed
          ? "border-destructive/40 bg-destructive/5"
          : "border-border bg-muted/40"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <KindBadge kind={item.kind} />
        <span className="inline-flex items-center gap-1">
          <CloudOff aria-hidden className="size-3" />
          {failed ? "上传失败" : "待补传（联网后自动）"}
        </span>
        <time dateTime={item.recordedAt}>
          {formatRelativeTime(item.recordedAt)}
        </time>
        <span className="flex-1" />
        {failed && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void discardMemoOutboxItem(item.clientId)}
          >
            丢弃
          </Button>
        )}
      </div>
      {item.text !== undefined && item.text !== "" && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed">
          {item.text}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {item.failedMessage}
        </p>
      )}
    </article>
  );
}
