import { AiConnectionManager } from "@/features/student-ai/AiConnectionManager";

/**
 * 学生「连接 AI」设置页(/s/settings/ai,SAI-18)。账号守卫与学生布局由
 * /s 路由外壳负责(同手写手感页);管理逻辑全在 AiConnectionManager
 * (首次知情、三通道配置、测试与默认通道)。从题卡带 ?from= 进入时,
 * 保存成功后的回跳入口由管理组件内提供。
 */
export default function StudentAiConnectionPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">连接 AI</h1>
        <p className="text-sm text-muted-foreground">
          配置求助时使用的 AI 服务。所有连接与偏好都保存在你的账号下,
          可随时查看、测试或删除。
        </p>
      </header>
      <AiConnectionManager />
    </div>
  );
}
