import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { fetchPublicConfig } from "./lib/api";
import { setupEruda } from "./lib/debug";
import { maybeRegisterServiceWorker, registerServiceWorker } from "./lib/pwa";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

// 开发环境且 URL 带 ?debug=1 时注入 Eruda 页内控制台（iPad 真机调试用）
void setupEruda();

// PWA（T2.12）：先问服务端 /api/public/config，PUBLIC_URL 为 https 才注册 SW；
// 纯 HTTP（公网 IP 部署、备案前）不注册，一切功能照常。失败静默（SW 是增强能力）
void maybeRegisterServiceWorker(
  () => fetchPublicConfig().catch(() => null),
  registerServiceWorker,
);

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("缺少 #root 挂载点，请检查 index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
