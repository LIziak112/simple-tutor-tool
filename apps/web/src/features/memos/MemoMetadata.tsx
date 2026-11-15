import { useMutation, useQuery } from "@tanstack/react-query";
import type { Memo } from "@tutor/contract";
import { useContext, useState } from "react";
import { Link } from "react-router";
import { useDevices } from "@/features/devices/device-queries";
import { LearningPrincipalContext } from "@/features/learning-context/learning-principal";
import {
  usePortalClients,
  usePortalRoutes,
} from "@/features/runtime/portal-runtime";

import { formatRelativeTime } from "@/lib/time";
import {
  memoAbsoluteTime,
  memoSourceHref,
  memoSourceLabel,
} from "./memo-display";
import { MEMO_DEVICE_LABEL } from "./memo-format";

export function MemoTime({ recordedAt }: { recordedAt: string }) {
  if (!Number.isFinite(new Date(recordedAt).getTime()))
    return <span>时间不详</span>;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return (
    <>
      <time dateTime={recordedAt} title={`本设备时间：${zone}`}>
        {memoAbsoluteTime(recordedAt, navigator.language, zone)}
      </time>
      <span>（{formatRelativeTime(recordedAt)}）</span>
    </>
  );
}
export function MemoDeviceName({ memo }: { memo: Memo }) {
  const account = useContext(LearningPrincipalContext);
  // 同一列表所有卡片共用一次本人设备查询，失败保留旧设备类型。
  const query = useDevices({ type: "student", id: account ?? "unknown" });
  const device = query.data?.devices.find((d) => d.deviceId === memo.deviceId);
  return (
    <span>
      ·{" "}
      {device?.displayName ??
        (memo.source === "agent"
          ? "MCP Agent"
          : MEMO_DEVICE_LABEL[memo.device])}
    </span>
  );
}
export function MemoSource({ memo }: { memo: Memo }) {
  const routes = usePortalRoutes();

  const { memoSourceTargetApi } = usePortalClients();

  const account = useContext(LearningPrincipalContext);
  const [resolve, setResolve] = useState(false);
  const query = useQuery({
    queryKey: ["student", "memo-source", account, memo.id],
    queryFn: () => memoSourceTargetApi(memo.id),
    enabled: resolve,
    retry: false,
    staleTime: 0,
  });
  const label = memoSourceLabel(memo);
  if (label === null) return null;
  const href = query.data ? memoSourceHref(routes, query.data) : null;
  return (
    <div className="text-xs break-words">
      {href ? (
        <Link to={href} className="text-primary underline">
          {label}
        </Link>
      ) : (
        <button
          type="button"
          className="min-h-11 text-primary underline"
          onClick={() => {
            setResolve(true);
            if (resolve) void query.refetch();
          }}
          disabled={query.isFetching}
        >
          {label} ·{" "}
          {query.isFetching
            ? "确认来源…"
            : query.isError
              ? "来源待联网确认"
              : query.data?.kind === "unavailable"
                ? "来源当前不可用"
                : "查看来源"}
        </button>
      )}
      {query.data?.kind === "attempt" && query.data.replaced && (
        <span>（已定位到最近一次作答）</span>
      )}
    </div>
  );
}
export function MemoSharing({ memo }: { memo: Memo }) {
  const { memoShareStateApi, revokeMemoShareApi, shareMemoApi } =
    usePortalClients();

  const account = useContext(LearningPrincipalContext);
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["student", "memo-share", account, memo.id],
    queryFn: () => memoShareStateApi(memo.id),
    enabled: open,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async () => {
      if (query.data?.teacherId) return revokeMemoShareApi(memo.id);
      if (query.data?.availableTeacherId)
        return shareMemoApi(memo.id, query.data.availableTeacherId);
      throw new Error("当前没有可分享的归属教师");
    },
    onSuccess: () => query.refetch(),
  });
  return (
    <div className="text-xs">
      <button
        type="button"
        className="min-h-11 underline"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        分享设置
      </button>
      {open && (
        <div className="flex flex-col gap-2">
          <p>
            默认仅本人可见。分享后，你的归属教师可查看这一条的正文、媒体、标签和来源说明；可随时撤回。
          </p>
          {query.data && (
            <button
              type="button"
              className="min-h-11 w-fit rounded border px-3"
              disabled={mutation.isPending || !query.data.availableTeacherId}
              onClick={() => mutation.mutate()}
            >
              {query.data.teacherId ? "撤回分享" : "确认分享给我的教师"}
            </button>
          )}
          {(query.isError || mutation.isError) && (
            <p role="alert">分享设置失败，请重试</p>
          )}
        </div>
      )}
    </div>
  );
}
