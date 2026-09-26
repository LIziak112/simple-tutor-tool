import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 根测试配置（T1.8 起）：用 projects 区分两种环境，互不影响——
// - node：apps/server 与 packages/* 的原有测试，保持默认 node 环境；
// - web：apps/web 的组件测试（Vitest + Testing Library），jsdom 环境 + 全局 setup
//   （globals 仅为让 @testing-library/react 注册自动 cleanup，测试内仍显式从
//   "vitest" 导入 describe/it/expect）。
//
// resolve.alias：与 apps/web/vite.config.ts 的 @ 别名保持一致，
// 组件测试才能解析组件内部的 "@/components/…" 导入（T1.9 起组件用到别名）。
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "apps/server/src/**/*.test.ts",
            "packages/*/src/**/*.test.ts",
          ],
          // 覆盖率（§7.2：md-dsl 与 grading 单测覆盖率 ≥90% 硬门槛）：
          // 开关由 CLI --coverage 传入（如 packages/grading 的 test:coverage 脚本），
          // 此处只声明 provider 与门槛。include 暂限 grading（T2.5 首个启用门槛的包），
          // md-dsl 启用时再扩为两包数组。
          coverage: {
            provider: "v8",
            include: ["packages/grading/src/**"],
            thresholds: {
              lines: 90,
              branches: 90,
              functions: 90,
              statements: 90,
            },
          },
        },
      },
      {
        test: {
          name: "web",
          root: "apps/web",
          environment: "jsdom",
          include: ["src/**/*.test.{ts,tsx}"],
          setupFiles: ["src/test/setup.ts"],
          globals: true,
        },
      },
    ],
  },
});
