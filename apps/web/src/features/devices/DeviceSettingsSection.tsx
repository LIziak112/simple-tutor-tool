import type { AccountKind, Device } from "@tutor/contract";
import { useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { PORTALS } from "@/features/auth/portals";
import { useClearStudentSession } from "@/features/auth/student-auth";
import { useClearTeacherSession } from "@/features/auth/teacher-auth";
import type { DeviceOwner } from "@/lib/device-api";
import { formatCnTime } from "@/lib/time";
import { DeviceMergeDialog } from "./DeviceMergeDialog";
import { DeviceRenameDialog } from "./DeviceRenameDialog";
import { DeviceRevokeDialog } from "./DeviceRevokeDialog";
import { useDeviceActions, useDevices } from "./device-queries";

/** 学习与管理视角共用展示；会话清理只作用于当前已认证subject。 */
export function DeviceSettingsSection({
  owner,
  accountKind,
  connectionSettingsHref,
}: {
  owner: DeviceOwner;
  accountKind: AccountKind;
  connectionSettingsHref?: string;
}) {
  const query = useDevices(owner);
  const navigate = useNavigate();
  const clearStudent = useClearStudentSession();
  const clearTeacher = useClearTeacherSession();
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "rename" | "merge" | "revoke"; device: Device }
    | { kind: "unassigned" }
    | null
  >(null);
  const titleId = useId();
  const action = useDeviceActions(owner, async () => {
    const portal = accountKind === "personal" ? "personal" : owner.type;
    const clear = owner.type === "student" ? clearStudent : clearTeacher;
    await clear(() => navigate(PORTALS[portal].loginPath, { replace: true }));
  });
  async function perform(input: Parameters<typeof action.mutateAsync>[0]) {
    const result = await action.mutateAsync(input);
    if (!result.revoked) {
      setNotice(result.message);
      setDialog(null);
    }
  }
  return (
    <section aria-labelledby={titleId} className="space-y-4">
      <div>
        <h2 id={titleId} className="text-lg font-semibold">
          我的设备
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          设备名称用于本人识别，不是硬件认证。清除网站数据或换浏览器会产生新记录。
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        这里只管理浏览器登录；MCP和API token不会因此停用。
        {connectionSettingsHref ? (
          <Link
            className="inline-flex min-h-11 items-center text-primary underline"
            to={connectionSettingsHref}
          >
            前往AI连接设置
          </Link>
        ) : (
          "token请在AI连接设置中处理。"
        )}
      </p>
      {query.isPending && <p role="status">正在加载设备…</p>}
      {query.isError && (
        <div role="alert" className="space-y-2 text-sm">
          <p>{query.error.message}</p>
          <Button
            className="min-h-11"
            type="button"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            重试设备列表
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {query.data && (
        <>
          {query.data.devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚无设备登记记录</p>
          ) : (
            <ul className="space-y-3">
              {query.data.devices.map((device) => (
                <li
                  key={device.deviceId}
                  className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="min-w-0 break-words font-medium">
                      {device.displayName}
                    </h3>
                    {query.data.currentDeviceId === device.deviceId && (
                      <span className="rounded-full bg-muted px-2 py-1 text-xs">
                        当前浏览器
                      </span>
                    )}
                  </div>
                  <p className="break-words text-sm text-muted-foreground">
                    自动名称：{device.automaticName} ·{" "}
                    {device.activeSessionCount}条有效浏览器登录
                  </p>
                  <dl className="space-y-1 text-xs text-muted-foreground">
                    <div>
                      <dt className="inline">首次使用：</dt>
                      <dd className="inline">
                        {formatCnTime(device.firstSeenAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">最近使用：</dt>
                      <dd className="inline">
                        {formatCnTime(device.lastSeenAt)}
                      </dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={action.isPending}
                      aria-label={`改名 ${device.displayName}`}
                      onClick={() => setDialog({ kind: "rename", device })}
                    >
                      改名
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={
                        action.isPending || query.data.devices.length < 2
                      }
                      aria-label={`合并到 ${device.displayName}`}
                      onClick={() => setDialog({ kind: "merge", device })}
                    >
                      合并旧记录到此设备
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={action.isPending}
                      aria-label={`移除登录记录 ${device.displayName}`}
                      onClick={() => setDialog({ kind: "revoke", device })}
                    >
                      移除登录记录
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-sm">
              未分配设备的有效登录：{query.data.unassignedSessionCount}条
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={action.isPending}
              onClick={() => setDialog({ kind: "unassigned" })}
            >
              清理未分配的登录记录
            </Button>
            <p className="text-xs text-muted-foreground">
              清理保留当前登录；实际移除数包含过期记录。
            </p>
          </div>
        </>
      )}
      {dialog?.kind === "rename" && (
        <DeviceRenameDialog
          device={dialog.device}
          pending={action.isPending}
          onClose={() => setDialog(null)}
          onSave={(name) =>
            perform({ kind: "rename", id: dialog.device.deviceId, name })
          }
        />
      )}
      {dialog?.kind === "merge" && (
        <DeviceMergeDialog
          target={dialog.device}
          devices={query.data?.devices ?? []}
          pending={action.isPending}
          onClose={() => setDialog(null)}
          onMerge={(source, allowActive) =>
            perform({
              kind: "merge",
              source,
              target: dialog.device.deviceId,
              allowActive,
            })
          }
        />
      )}
      {(dialog?.kind === "revoke" || dialog?.kind === "unassigned") && (
        <DeviceRevokeDialog
          device={dialog.kind === "revoke" ? dialog.device : null}
          current={
            dialog.kind === "revoke" &&
            query.data?.currentDeviceId === dialog.device.deviceId
          }
          pending={action.isPending}
          onClose={() => setDialog(null)}
          onRevoke={() =>
            perform(
              dialog.kind === "unassigned"
                ? { kind: "unassigned" }
                : {
                    kind: "revoke",
                    id: dialog.device.deviceId,
                    current:
                      query.data?.currentDeviceId === dialog.device.deviceId,
                  },
            )
          }
        />
      )}
    </section>
  );
}
