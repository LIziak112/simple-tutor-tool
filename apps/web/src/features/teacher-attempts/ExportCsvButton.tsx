import { Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  downloadTeacherExportCsv,
  type TeacherExportCsvParams,
} from "@/lib/api";

/**
 * 「导出 CSV」按钮（T3.4，D13）：数据页与详情页共用。
 * 参数由调用方按当前上下文组装（数据页 = URL 筛选映射 exportCsvParamsOf；
 * 详情页 = 该 attempt 的唯一定位组合）。下载经 fetch + blob（同源自动带会话
 * Cookie，与 export.md 下载同口径），失败 alert 中文提示。
 */

export function ExportCsvButton({
  params,
}: {
  params: TeacherExportCsvParams;
}) {
  const [busy, setBusy] = useState(false);

  async function handleExport(): Promise<void> {
    setBusy(true);
    try {
      await downloadTeacherExportCsv(params);
    } catch (err) {
      // 导出是低频动作，失败用 alert 直陈原因（不做内嵌错误态）
      window.alert(err instanceof Error ? err.message : "导出失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="outline"
      className="min-h-11"
      disabled={busy}
      onClick={() => void handleExport()}
    >
      <Download aria-hidden />
      {busy ? "正在导出…" : "导出 CSV"}
    </Button>
  );
}
