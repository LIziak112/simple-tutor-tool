import { readFileSync } from "node:fs";
import { createServer } from "vite";

// 真机测试使用独立端口，可通过现有 PEM 证书开启 HTTPS；不生成或提交私钥。
const certificatePath = process.env.INK_FEEL_TLS_PEM;
const certificate = certificatePath ? readFileSync(certificatePath) : null;
const server = await createServer({
  server: {
    host: "0.0.0.0",
    port: Number(process.env.INK_FEEL_PORT ?? 5201),
    strictPort: true,
    ...(certificate ? { https: { key: certificate, cert: certificate } } : {}),
  },
});
await server.listen();
server.printUrls();
