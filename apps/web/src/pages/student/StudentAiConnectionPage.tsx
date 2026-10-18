import { AiConnectionManager } from "@/features/student-ai/AiConnectionManager";

/**
 * 学生「连接 AI」设置页(/s/settings/ai,SAI-18)。账号守卫与学生布局由
 * /s 路由外壳负责(同手写手感页);管理逻辑全在 AiConnectionManager
 * (首次知情、三通道配置、测试与默认通道)。从题卡带 ?from= 进入时,
 * 保存成功后的回跳入口由管理组件内提供。
 */
export default function StudentAiConnectionPage() {
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-6 pb-8 sm:space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">连接 AI</h1>
        <p className="text-sm text-muted-foreground">
          选择自己的 AI，在题目旁提问、获得启发与复盘。
        </p>
      </header>
      <AiConnectionManager />
    </div>
  );
}
