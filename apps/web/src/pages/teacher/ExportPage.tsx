import { useSearchParams } from "react-router";
import { ExportWizard } from "@/features/export/ExportWizard";

/**
 * /t/export 导出中心（T4.4）：「导出给 AI」五步向导页。
 * 入口在学情总览页与学生画像页（画像入口带 ?studentId= 预填该生），
 * T4.7 起侧边栏「导出」同指此页。向导状态在 ExportWizard 内部。
 */
export function ExportPage() {
  const [searchParams] = useSearchParams();
  const initialStudentId = searchParams.get("studentId");
  return <ExportWizard initialStudentId={initialStudentId} />;
}

// 供 App.tsx 路由级懒加载
export default ExportPage;
