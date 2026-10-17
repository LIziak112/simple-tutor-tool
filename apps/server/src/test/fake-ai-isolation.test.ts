import { expect, it } from "vitest";
import { startFakeAiProvider } from "../../../../e2e/fake-ai-provider.ts";

it("并行 AI 用例的剧本、捕获和重置按凭据隔离", async () => {
  const close = await startFakeAiProvider(0);
  try {
    const control = async (scope: string, path: string, body?: unknown) =>
      fetch(`${close.url}/${path}?scope=${scope}`, {
        method: "POST",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    await control("a", "script", { body: "A 独占回信" });
    await control("b", "script", { body: "B 独占回信" });
    await control("b", "reset");
    const send = (scope: string) =>
      fetch(`${close.url}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${scope}` },
        body: "{}",
      });
    const [a, b] = await Promise.all([send("a"), send("b")]);
    expect(await a.text()).toBe("A 独占回信");
    expect(await b.text()).not.toContain("A 独占回信");
    const captures = (await fetch(`${close.url}/requests?scope=a`).then((r) =>
      r.json(),
    )) as { requests: { headers: Record<string, string> }[] };
    expect(captures.requests).toHaveLength(1);
    expect(captures.requests[0]?.headers.authorization).toBe("Bearer a");
  } finally {
    await close();
  }
});
