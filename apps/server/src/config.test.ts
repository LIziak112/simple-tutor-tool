import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateSecretKey, readConfig } from "./config";

describe("readConfig：环境变量读取（§0.3 约定）", () => {
  it("全部缺省时给出默认值：PORT 8787、DATA_DIR ./data、PUBLIC_URL http://localhost:8787", () => {
    const config = readConfig({});
    expect(config.port).toBe(8787);
    expect(config.dataDir).toBe(resolve("./data"));
    expect(config.publicUrl).toBe("http://localhost:8787");
    expect(config.isProduction).toBe(false);
  });

  it("环境变量可覆盖，DATA_DIR 转绝对路径、PUBLIC_URL 去尾部斜杠、NODE_ENV=production 生效", () => {
    const config = readConfig({
      PORT: "9000",
      DATA_DIR: "some-data",
      PUBLIC_URL: "https://tutor.example.com/",
      NODE_ENV: "production",
    });
    expect(config.port).toBe(9000);
    expect(config.dataDir).toBe(resolve("some-data"));
    expect(config.publicUrl).toBe("https://tutor.example.com");
    expect(config.isProduction).toBe(true);
  });

  it("PORT 非法（非整数/超范围）时快速失败，错误信息指向 PORT", () => {
    expect(() => readConfig({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => readConfig({ PORT: "0" })).toThrow(/PORT/);
    expect(() => readConfig({ PORT: "70000" })).toThrow(/PORT/);
  });
});

describe("loadOrCreateSecretKey：会话密钥（§0.3 约定）", () => {
  it("首次生成 32 字节 hex 密钥并落盘 secret.key，再次读取复用同一密钥", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tutor-secret-"));
    try {
      const first = loadOrCreateSecretKey(dir);
      expect(first).toMatch(/^[0-9a-f]{64}$/);

      const onDisk = (await readFile(join(dir, "secret.key"), "utf8")).trim();
      expect(onDisk).toBe(first);

      // 第二次调用不得重新生成（重启后密钥必须稳定）
      expect(loadOrCreateSecretKey(dir)).toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("数据目录不存在时自动创建；密钥文件内容损坏时重新生成", async () => {
    const base = await mkdtemp(join(tmpdir(), "tutor-secret2-"));
    try {
      const dir = join(base, "nested", "data");
      const key = loadOrCreateSecretKey(dir);
      expect(key).toMatch(/^[0-9a-f]{64}$/);

      // 模拟密钥文件被手工写坏
      await writeFile(join(dir, "secret.key"), "garbage", "utf8");
      const regenerated = loadOrCreateSecretKey(dir);
      expect(regenerated).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
