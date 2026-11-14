import type { Device } from "@tutor/contract";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function DeviceRevokeDialog({
  device,
  current,
  pending,
  onClose,
  onRevoke,
}: {
  device: Device | null;
  current: boolean;
  pending: boolean;
  onClose: () => void;
  onRevoke: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  async function revoke() {
    setError(null);
    try {
      await onRevoke();
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === "AbortError"))
        setError(cause instanceof Error ? cause.message : "移除登录记录失败");
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
          <DialogTitle>移除浏览器登录记录？</DialogTitle>
          <DialogDescription>
            {device
              ? `设备：${device.displayName}。`
              : "清理未能登记设备的旧登录，当前浏览器登录会保留。"}
            移除后对应旧登录不能继续请求，重新登录仍可使用。
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          {current
            ? "这会退出当前视角。"
            : "仅处理当前账号、当前视角的浏览器登录；若包含当前浏览器，会退出当前视角。"}
          请先确认需要保留的工作已保存；本机未同步随笔和草稿不会被删除。
        </p>
        <p className="text-sm text-muted-foreground">
          个人账号的另一视角不受影响。MCP、API token
          和分享链接不会因此撤销；如需停用，请前往相应的AI连接设置。
        </p>
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
            variant="destructive"
            onClick={() => void revoke()}
            disabled={pending}
          >
            确认移除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
