import { type Device, deviceRenameSchema } from "@tutor/contract";
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
import { Input } from "@/components/ui/input";

export function DeviceRenameDialog({
  device,
  pending,
  onClose,
  onSave,
}: {
  device: Device;
  pending: boolean;
  onClose: () => void;
  onSave: (name: string | null) => Promise<void>;
}) {
  const [name, setName] = useState(device.name ?? device.automaticName);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  async function save(value: string | null) {
    const parsed = deviceRenameSchema.safeParse({ name: value });
    if (!parsed.success) {
      setError("名称需为1到80个字；也可恢复自动名称");
      return;
    }
    setError(null);
    try {
      await onSave(parsed.data.name);
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === "AbortError"))
        setError(cause instanceof Error ? cause.message : "名称保存失败");
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
          <DialogTitle>设备改名</DialogTitle>
          <DialogDescription>
            自动名称：{device.automaticName}。自定义名称只用于本人识别设备。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(name);
          }}
          className="space-y-4"
        >
          <label htmlFor={id} className="text-sm font-medium">
            设备名称
          </label>
          <Input
            className="min-h-11"
            id={id}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={pending}
            autoFocus
          />
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
              disabled={pending}
              onClick={() => void save(null)}
            >
              恢复自动名称
            </Button>
            <Button className="min-h-11" type="submit" disabled={pending}>
              保存名称
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
