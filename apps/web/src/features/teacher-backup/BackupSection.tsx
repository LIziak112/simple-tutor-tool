import type { BackupRestoreResult } from "@tutor/contract";
import {
  DatabaseBackup,
  Download,
  History,
  Loader2,
  LogIn,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import {
  useBackupSnapshots,
  useDownloadBackup,
  useRestoreBackup,
} from "@/features/teacher-backup/backup-queries";
import { formatCnTime } from "@/lib/time";

/**
 * 设置页「备份与恢复」区（T4.5，D20/D21）：
 * - 下载完整备份（db 快照 + 笔迹 + 共享 + 密钥），成功后显示下载文件名；
 * - 恢复上传：选 zip → 密码确认弹层（影响说明：数据回到压缩包时点、当前登录
 *   可能失效需重新登录、恢复前服务端会自动再做一次快照可回滚）→ 提交；
 *   成功后展示「请重新登录」提示（会话以恢复库为准，sessionWarning 恒 true）；
 * - 最近快照列表（时间 + 大小，来自服务端 24h 自动快照，保留 14 份）。
 * 三态齐全（加载/空/错误）、触控目标 ≥44px（min-h-11）。
 */

/** 字节数 → 中文可读大小（与导出向导同款式；备份是独立特性，本地维护） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function BackupSection() {
  const navigate = useNavigate();
  const snapshotsQuery = useBackupSnapshots();
  const downloadMutation = useDownloadBackup();
  const restoreMutation = useRestoreBackup();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 恢复流转：选文件 → 密码弹层 → 提交 → 结果提示
  const [pendingZip, setPendingZip] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [restoreDone, setRestoreDone] = useState<BackupRestoreResult | null>(
    null,
  );

  function handleFileChosen(file: File | undefined) {
    if (!file) return;
    setPendingZip(file);
    setPassword("");
    setRestoreDone(null);
  }

  function handleRestoreConfirm() {
    if (!pendingZip || password.length === 0) return;
    restoreMutation.mutate(
      { zip: pendingZip, password },
      {
        onSuccess: (result) => {
          setPendingZip(null);
          setPassword("");
          setRestoreDone(result);
        },
      },
    );
  }

  const restoreError =
    restoreMutation.isError && restoreMutation.error instanceof Error
      ? restoreMutation.error.message
      : restoreMutation.isError
        ? "恢复失败，请稍后重试"
        : null;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 text-card-foreground">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <DatabaseBackup aria-hidden className="size-4" />
          备份与恢复
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          系统每天自动保存一份数据库快照（保留最近 14 份）。完整备份还包含手写
          笔迹、共享发布与会话密钥；恢复是整库操作，会将当前数据整体替换为
          压缩包内容。
        </p>
      </div>

      {/* 下载 */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          className="min-h-11 px-5"
          disabled={downloadMutation.isPending}
          onClick={() => downloadMutation.mutate(undefined)}
        >
          {downloadMutation.isPending ? (
            <>
              <Loader2 aria-hidden className="animate-spin" />
              正在打包…
            </>
          ) : (
            <>
              <Download aria-hidden />
              下载完整备份
            </>
          )}
        </Button>
        {downloadMutation.isSuccess && (
          <p className="text-sm text-muted-foreground" role="status">
            已下载 {downloadMutation.data}
          </p>
        )}
        {downloadMutation.isError && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {downloadMutation.error instanceof Error
              ? downloadMutation.error.message
              : "下载失败，请稍后重试"}
          </p>
        )}
      </div>

      {/* 恢复上传 */}
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          aria-label="选择备份压缩包"
          onChange={(event) => {
            handleFileChosen(event.target.files?.[0]);
            // 同一文件再次选择也要触发 onChange（清空 value）
            event.target.value = "";
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            className="min-h-11 px-5"
            onClick={() => fileInputRef.current?.click()}
          >
            <RotateCcw aria-hidden />
            从备份恢复…
          </Button>
          {pendingZip && (
            <p className="text-sm text-muted-foreground">{pendingZip.name}</p>
          )}
        </div>
        {restoreError && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {restoreError}
          </p>
        )}
        {/* 恢复成功提示：会话以恢复库为准，引导重新登录（D21） */}
        {restoreDone && (
          <div
            role="status"
            className="flex flex-col gap-3 rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
          >
            <p className="flex items-start gap-2">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              恢复完成：已写入 {restoreDone.restoredFiles} 个文件，
              数据回到快照时点。当前登录状态以恢复后的数据为准，
              可能已失效——请重新登录。
            </p>
            <div>
              <Button
                className="min-h-11 px-5"
                onClick={() => navigate("/t/login", { replace: true })}
              >
                <LogIn aria-hidden />
                前往登录
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* 最近快照 */}
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <History aria-hidden className="size-4" />
          最近快照
        </h3>
        {snapshotsQuery.isPending && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            正在加载…
          </p>
        )}
        {snapshotsQuery.isError && (
          <p role="alert" className="text-sm text-destructive">
            快照列表加载失败：
            {snapshotsQuery.error instanceof Error
              ? snapshotsQuery.error.message
              : "请稍后重试"}
          </p>
        )}
        {snapshotsQuery.isSuccess &&
          snapshotsQuery.data.snapshots.length === 0 && (
            <p className="text-sm text-muted-foreground">
              暂无快照（下载完整备份时会自动先拍一份）
            </p>
          )}
        {snapshotsQuery.isSuccess &&
          snapshotsQuery.data.snapshots.length > 0 && (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {snapshotsQuery.data.snapshots.map((snapshot) => (
                <li
                  key={snapshot.filename}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                >
                  <span>{formatCnTime(snapshot.createdAt)}</span>
                  <span className="flex items-center gap-3 text-muted-foreground">
                    <span className="font-mono text-xs">
                      {snapshot.filename}
                    </span>
                    <span>{formatBytes(snapshot.sizeBytes)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
      </div>

      {/* 恢复密码确认弹层（D21：影响说明 + 登录密码） */}
      <Dialog
        open={pendingZip !== null}
        onOpenChange={(open) => {
          if (!open && !restoreMutation.isPending) {
            setPendingZip(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <TriangleAlert aria-hidden className="size-4" />
              确认恢复备份？
            </DialogTitle>
            <DialogDescription>
              将使用「{pendingZip?.name ?? ""}」整体替换当前全部数据
              （含全部教师与学生），数据回到该备份的时点，此后产生的变化会丢失。
            </DialogDescription>
          </DialogHeader>
          {/* 影响说明列表：ul 不能嵌在 DialogDescription（渲染为 p）内，
              否则控制台报 invalid nesting（Opus 实测③-2）——独立成块 */}
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <span>请知悉：</span>
            <ul className="list-inside list-disc space-y-1 pl-1">
              <li>恢复前系统会自动再保存一份当前数据的快照，可用于回滚；</li>
              <li>恢复后当前登录可能失效，需要重新登录；</li>
              <li>恢复需输入你的登录密码确认。</li>
            </ul>
          </div>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              handleRestoreConfirm();
            }}
          >
            <Input
              type="password"
              autoComplete="current-password"
              placeholder="登录密码"
              aria-label="登录密码"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={restoreMutation.isPending}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 px-5"
                onClick={() => setPendingZip(null)}
                disabled={restoreMutation.isPending}
              >
                取消
              </Button>
              <Button
                type="submit"
                variant="destructive"
                className="min-h-11 px-5"
                disabled={restoreMutation.isPending || password.length === 0}
              >
                {restoreMutation.isPending ? (
                  <>
                    <Loader2 aria-hidden className="animate-spin" />
                    正在恢复…
                  </>
                ) : (
                  "输入密码并恢复"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
