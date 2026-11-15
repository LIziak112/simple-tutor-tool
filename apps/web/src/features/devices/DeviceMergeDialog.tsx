import { DEVICE_MERGE_STALE, type Device } from "@tutor/contract";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api-response";

/** 目标由保留设备决定；旧来源不预选，活跃来源明确二次确认。 */
export function DeviceMergeDialog({
  target,
  devices,
  pending,
  onClose,
  onMerge,
}: {
  target: Device;
  devices: readonly Device[];
  pending: boolean;
  onClose: () => void;
  onMerge: (source: string, allowActive: boolean) => Promise<void>;
}) {
  const [selectedSource, setSelectedSource] = useState<Device | null>(null);
  const sourceId = selectedSource?.deviceId ?? "";
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = devices.find((item) => item.deviceId === sourceId);
  const targetAvailable = devices.some(
    (item) => item.deviceId === target.deviceId,
  );
  const active = (source?.activeSessionCount ?? 0) > 0;
  const id = useId();
  async function merge() {
    if (!targetAvailable || source === undefined || (active && !confirmed))
      return;
    setError(null);
    try {
      await onMerge(source.deviceId, active && confirmed);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === DEVICE_MERGE_STALE)
        setConfirmed(false);
      if (!(cause instanceof Error && cause.name === "AbortError"))
        setError(cause instanceof Error ? cause.message : "合并失败");
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>合并设备记录</DialogTitle>
          <DialogDescription>
            保留“{target.displayName}
            ”及其名称，将选择的旧设备记录归入它。清除网站数据或换浏览器会产生新记录。
          </DialogDescription>
        </DialogHeader>
        <label htmlFor={id} className="text-sm font-medium">
          旧设备记录
        </label>
        <select
          id={id}
          className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={sourceId}
          disabled={pending}
          onChange={(event) => {
            setSelectedSource(
              devices.find((item) => item.deviceId === event.target.value) ??
                null,
            );
            setConfirmed(false);
          }}
        >
          <option value="">请选择旧记录，建议选没有有效登录的记录</option>
          {source === undefined && selectedSource !== null && (
            <option value={selectedSource.deviceId} disabled>
              {selectedSource.displayName}（记录已变化，请重新选择）
            </option>
          )}
          {devices
            .filter((item) => item.deviceId !== target.deviceId)
            .sort((a, b) => a.activeSessionCount - b.activeSessionCount)
            .map((item) => (
              <option key={item.deviceId} value={item.deviceId}>
                {item.displayName}（{item.activeSessionCount}条有效登录）
              </option>
            ))}
        </select>
        <p className="text-sm text-muted-foreground">
          合并后两个浏览器共用同一设备记录。后续使用时，一个浏览器的请求可能让另一个浏览器的旧登录失效；合并不可直接拆回。
        </p>
        {active && (
          <label className="flex min-h-11 items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={pending}
            />
            我已了解旧记录仍在使用，合并可能使另一浏览器登录失效
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            className="min-h-11"
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            className="min-h-11"
            type="button"
            disabled={
              pending ||
              !targetAvailable ||
              source === undefined ||
              (active && !confirmed)
            }
            onClick={() => void merge()}
          >
            确认合并
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
