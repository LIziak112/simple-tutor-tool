import type {
  AiConnectionCreateRequest,
  AiConnectionModelsRequest,
} from "@tutor/contract";
import { CheckCircle2, Download, Loader2, PlugZap } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import {
  useProbeStudentAiConnection,
  useStudentAiConnectionModels,
} from "./ai-connection-queries";

export type InappConnectionValues = Pick<
  Extract<AiConnectionCreateRequest, { channel: "inapp" }>,
  "baseUrl" | "apiKey" | "model" | "imageCapability"
>;

interface Props {
  readonly values: InappConnectionValues;
  readonly connectionId: string | null;
  readonly savedBaseUrl: string | null;
  readonly onChange: (patch: Partial<InappConnectionValues>) => void;
}

function normalizedAddress(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function diagnosticError(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "暂时无法连接服务，请检查网络和接口地址后重试。填写的内容已保留。";
}

/** 诊断结果绑定请求时的输入；修改地址、密钥或模型后不再展示旧结论。 */
export function InappConnectionFields({
  values,
  connectionId,
  savedBaseUrl,
  onChange,
}: Props) {
  const id = useId();
  const credentialVersion = useRef(0);
  const probeVersion = useRef(0);
  const modelsMutation = useStudentAiConnectionModels();
  const probeMutation = useProbeStudentAiConnection();
  const [modelSearch, setModelSearch] = useState("");
  const [modelResult, setModelResult] = useState<{
    key: string;
    models?: string[];
    error?: string;
  } | null>(null);
  const [probeResult, setProbeResult] = useState<{
    key: string;
    ok: boolean;
    text: string;
  } | null>(null);
  const baseUrl = normalizedAddress(values.baseUrl);
  const hasEndpointSuffix = /\/(chat\/completions|models)$/.test(baseUrl ?? "");
  const changedAddress =
    connectionId !== null && baseUrl !== normalizedAddress(savedBaseUrl ?? "");
  const needsNewKey = changedAddress && values.apiKey.length === 0;
  const credentialsReady =
    baseUrl !== null &&
    !hasEndpointSuffix &&
    !needsNewKey &&
    (values.apiKey.length > 0 || connectionId !== null);
  const credentialKey = JSON.stringify([
    connectionId,
    values.baseUrl,
    values.apiKey,
  ]);
  const probeKey = JSON.stringify([credentialKey, values.model]);
  const currentModels = modelResult?.key === credentialKey ? modelResult : null;
  const currentProbe = probeResult?.key === probeKey ? probeResult : null;
  const filteredModels =
    currentModels?.models?.filter((model) =>
      model.toLowerCase().includes(modelSearch.toLowerCase()),
    ) ?? [];

  function change(patch: Partial<InappConnectionValues>) {
    if ("baseUrl" in patch || "apiKey" in patch) {
      credentialVersion.current += 1;
      setModelResult(null);
    }
    if ("baseUrl" in patch || "apiKey" in patch || "model" in patch) {
      probeVersion.current += 1;
      setProbeResult(null);
    }
    onChange(patch);
  }

  function requestCredentials(): AiConnectionModelsRequest {
    return {
      baseUrl: values.baseUrl.trim(),
      ...(connectionId === null ? {} : { connectionId }),
      ...(values.apiKey.length === 0 ? {} : { apiKey: values.apiKey }),
    };
  }

  async function getModels() {
    const version = credentialVersion.current;
    setModelResult(null);
    try {
      const result = await modelsMutation.mutateAsync(requestCredentials());
      if (version !== credentialVersion.current) return;
      setModelResult({ key: credentialKey, models: result.models });
      setModelSearch("");
    } catch (error) {
      if (version !== credentialVersion.current) return;
      setModelResult({ key: credentialKey, error: diagnosticError(error) });
    }
  }

  async function testDraft() {
    const version = probeVersion.current;
    setProbeResult(null);
    try {
      const result = await probeMutation.mutateAsync({
        ...requestCredentials(),
        model: values.model.trim(),
      });
      const ok = result.verifyStatus === "verified";
      if (version !== probeVersion.current) return;
      setProbeResult({
        key: probeKey,
        ok,
        text: ok
          ? `测试通过 · ${result.durationMs} 毫秒。已收到所选模型的回复，请保存连接后使用。`
          : (result.message ??
            "测试未通过，请检查地址、密钥和模型名称后重试。"),
      });
    } catch (error) {
      if (version !== probeVersion.current) return;
      setProbeResult({
        key: probeKey,
        ok: false,
        text: diagnosticError(error),
      });
    }
  }

  return (
    <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="min-w-0 space-y-7">
        <section aria-labelledby={`${id}-service`} className="space-y-4">
          <h3
            id={`${id}-service`}
            className="flex items-center gap-2.5 font-medium"
          >
            <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs text-primary">
              1
            </span>
            填写 AI 服务信息
          </h3>
          <div className="space-y-4 sm:pl-8.5">
            <div className="space-y-1.5">
              <label htmlFor={`${id}-address`} className="text-sm font-medium">
                接口地址
              </label>
              <Input
                id={`${id}-address`}
                type="url"
                aria-label="接口地址"
                aria-describedby={`${id}-address-help`}
                autoComplete="url"
                placeholder="https://api.example.com/v1"
                value={values.baseUrl}
                onChange={(event) => change({ baseUrl: event.target.value })}
              />
              <p
                id={`${id}-address-help`}
                className="text-xs leading-relaxed text-muted-foreground"
              >
                粘贴服务商提供的 API 地址，通常以 /v1 结尾；不是聊天网页地址。
              </p>
              {hasEndpointSuffix && (
                <p role="alert" className="text-sm text-destructive">
                  请填写服务根地址，去掉末尾的 /chat/completions 或 /models。
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-key`} className="text-sm font-medium">
                API Key{" "}
                <span className="font-normal text-muted-foreground">
                  （访问密钥）
                </span>
              </label>
              <Input
                id={`${id}-key`}
                type="password"
                aria-label="API Key"
                aria-describedby={`${id}-key-help`}
                autoComplete="new-password"
                placeholder={
                  connectionId === null
                    ? "粘贴服务商提供的密钥"
                    : "留空继续使用已保存的密钥"
                }
                value={values.apiKey}
                onChange={(event) => change({ apiKey: event.target.value })}
              />
              <p
                id={`${id}-key-help`}
                className={`text-xs leading-relaxed ${needsNewKey ? "text-destructive" : "text-muted-foreground"}`}
              >
                {needsNewKey
                  ? "接口地址已更改，请重新填写 API Key，原密钥不会发送到新地址。"
                  : connectionId === null
                    ? "从服务商的控制台获取。保存后加密存储，不显示原密钥。"
                    : "已保存的密钥不会回显。留空可保留，填写新密钥则在保存后替换。"}
              </p>
            </div>
          </div>
        </section>
        <section
          aria-labelledby={`${id}-model`}
          className="space-y-4 border-t border-border pt-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3
              id={`${id}-model`}
              className="flex items-center gap-2.5 font-medium"
            >
              <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs text-primary">
                2
              </span>
              选择要使用的模型
            </h3>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={!credentialsReady || modelsMutation.isPending}
              onClick={() => void getModels()}
            >
              {modelsMutation.isPending ? (
                <Loader2 aria-hidden className="motion-safe:animate-spin" />
              ) : (
                <Download aria-hidden />
              )}
              {modelsMutation.isPending ? "正在获取模型…" : "获取模型列表"}
            </Button>
          </div>
          <div className="space-y-3 sm:pl-8.5">
            {!credentialsReady && (
              <p className="text-xs text-muted-foreground">
                先填写有效的接口地址和 API Key，即可获取模型。
              </p>
            )}
            {currentModels?.error && (
              <p role="alert" className="text-sm text-destructive">
                {currentModels.error}
              </p>
            )}
            {currentModels?.models !== undefined && (
              <div className="space-y-2">
                <p role="status" className="text-sm text-muted-foreground">
                  {currentModels.models.length > 0
                    ? `已获取 ${currentModels.models.length} 个模型。选择对话模型后，请继续测试。`
                    : "服务商返回了空列表。可手动填写模型名称，或检查密钥权限后重新获取。"}
                </p>
                {currentModels.models.length > 0 && (
                  <>
                    {currentModels.models.length > 6 && (
                      <Input
                        aria-label="筛选模型"
                        placeholder="搜索模型名称"
                        value={modelSearch}
                        onChange={(event) => setModelSearch(event.target.value)}
                      />
                    )}
                    <label className="flex flex-col gap-1.5 text-sm">
                      <span>选择可用模型</span>
                      <select
                        aria-label="选择可用模型"
                        className="min-h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        value={
                          filteredModels.includes(values.model)
                            ? values.model
                            : ""
                        }
                        onChange={(event) => {
                          if (event.target.value)
                            change({ model: event.target.value });
                        }}
                      >
                        <option value="">
                          {filteredModels.length === 0
                            ? "没有匹配的模型，换个关键词试试"
                            : "从列表选择模型"}
                        </option>
                        {filteredModels.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <label
                htmlFor={`${id}-model-name`}
                className="text-sm font-medium"
              >
                模型名称
              </label>
              <Input
                id={`${id}-model-name`}
                aria-label="模型名称"
                aria-describedby={`${id}-model-help`}
                placeholder="从列表选择，或输入服务商提供的名称"
                value={values.model}
                onChange={(event) => change({ model: event.target.value })}
              />
              <p
                id={`${id}-model-help`}
                className="text-xs leading-relaxed text-muted-foreground"
              >
                不支持获取列表的服务，也可以手动填写。模型名称需与服务商提供的一致。
              </p>
            </div>
          </div>
        </section>
        <section
          aria-labelledby={`${id}-test`}
          className="space-y-3 border-t border-border pt-6"
        >
          <h3
            id={`${id}-test`}
            className="flex items-center gap-2.5 font-medium"
          >
            <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs text-primary">
              3
            </span>
            确认模型能正常回复
          </h3>
          <div className="space-y-3 sm:pl-8.5">
            <p className="text-sm leading-relaxed text-muted-foreground">
              发送一句固定测试文字，确认地址、密钥和所选模型可用。不发送题目；可能产生少量
              API 费用。
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={
                !credentialsReady ||
                !values.model.trim() ||
                probeMutation.isPending
              }
              onClick={() => void testDraft()}
            >
              {probeMutation.isPending ? (
                <Loader2 aria-hidden className="motion-safe:animate-spin" />
              ) : (
                <PlugZap aria-hidden />
              )}
              {probeMutation.isPending ? "正在等待模型回复…" : "测试当前配置"}
            </Button>
            {currentProbe && (
              <p
                role={currentProbe.ok ? "status" : "alert"}
                className={`flex items-start gap-2 rounded-lg p-3 text-sm leading-relaxed ${currentProbe.ok ? "bg-primary/5 text-foreground" : "bg-destructive/5 text-destructive"}`}
              >
                {currentProbe.ok && (
                  <CheckCircle2
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-primary"
                  />
                )}
                {currentProbe.text}
              </p>
            )}
            {!currentProbe && (
              <p className="text-xs text-muted-foreground">
                当前填写的配置尚未测试。修改地址、密钥或模型后，请重新测试。
              </p>
            )}
          </div>
        </section>
        <details className="border-t border-border pt-4">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
            高级设置
          </summary>
          <label className="mt-2 flex flex-col gap-2 text-sm">
            <span>所选模型的图片能力</span>
            <select
              aria-label="图片能力"
              className="min-h-11 rounded-lg border border-input bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-ring"
              value={values.imageCapability ?? "unknown"}
              onChange={(event) =>
                change({
                  imageCapability:
                    event.target.value === "supported"
                      ? "supported"
                      : event.target.value === "unsupported"
                        ? "unsupported"
                        : "unknown",
                })
              }
            >
              <option value="unknown">尚不确定</option>
              <option value="supported">服务商确认支持图片</option>
              <option value="unsupported">仅支持文字</option>
            </select>
            <span className="text-xs leading-relaxed text-muted-foreground">
              用于判断能否发送书写图片。连接测试只检查文字回复，不代表支持图片。
            </span>
          </label>
        </details>
      </div>
      <aside className="min-w-0 space-y-5 self-start rounded-xl bg-muted/50 p-5 text-sm">
        <div className="space-y-2">
          <h3 className="font-medium">准备这两样就能开始</h3>
          <p className="leading-relaxed text-muted-foreground">
            向 AI 服务商获取接口地址和 API Key。订阅聊天会员通常不等于开通
            API，请以服务商说明为准。
          </p>
        </div>
        <div className="space-y-3 border-t border-border pt-4">
          <h3 className="font-medium">实际请求地址</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            系统在接口地址后追加以下路径，不会自动添加 /v1。
          </p>
          <dl className="space-y-3 text-xs">
            <div>
              <dt className="mb-1 text-muted-foreground">获取模型 · GET</dt>
              <dd className="break-all font-mono leading-relaxed">
                {baseUrl ? `${baseUrl}/models` : "填写接口地址后显示"}
              </dd>
            </div>
            <div>
              <dt className="mb-1 text-muted-foreground">测试和提问 · POST</dt>
              <dd className="break-all font-mono leading-relaxed">
                {baseUrl ? `${baseUrl}/chat/completions` : "填写接口地址后显示"}
              </dd>
            </div>
          </dl>
        </div>
        <div className="space-y-2 border-t border-border pt-4">
          <h3 className="font-medium">怎样才算配置完成？</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            获取模型只说明拿到了列表。测试通过说明本次模型能够回复；保存后才能在题目旁使用。保存不会自动调用
            AI。
          </p>
        </div>
      </aside>
    </div>
  );
}
