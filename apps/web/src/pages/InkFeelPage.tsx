import {
  DEFAULT_INK_PROFILE_CONFIG,
  type InkProfile,
  type InkProfileConfig,
} from "@tutor/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { Button } from "@/components/ui/button";
import { createAtramentSurface } from "@/features/ink/engine/atrament-adapter";
import { InkStore } from "@/features/ink/engine/history";
import type { ToolAwareSurface } from "@/features/ink/engine/surface";
import {
  deleteInkProfileApi,
  fetchInkProfiles,
  saveInkProfileApi,
} from "@/features/ink/ink-profile-api";
import {
  bindInkProfileAccount,
  clearInkProfileSelection,
  getInkProfileSelection,
  type InkProfileAccount,
  reconcileInkProfiles,
  selectInkProfile,
  useInkProfileSelection,
} from "@/features/ink/ink-profile-store";
import { createFeelSurface } from "@/features/ink/lab/feel-surface";
import { PaperPresentation } from "@/features/ink/PaperPresentation";
import { ApiError, fetchStudentMe, fetchTeacherMe } from "@/lib/api";

const control =
  "min-h-11 rounded-md border border-input bg-background px-3 text-sm";
const PRESETS = [
  { name: "标准硬笔", config: DEFAULT_INK_PROFILE_CONFIG },
  {
    name: "跟手硬笔",
    config: {
      ...DEFAULT_INK_PROFILE_CONFIG,
      renderer: "freehand" as const,
      smoothing: 0.3,
    },
  },
  {
    name: "自然压感",
    config: {
      ...DEFAULT_INK_PROFILE_CONFIG,
      renderer: "freehand" as const,
      thinning: 0.6,
      smoothing: 0.55,
      streamline: 0.38,
    },
  },
  {
    name: "等宽书写",
    config: {
      ...DEFAULT_INK_PROFILE_CONFIG,
      renderer: "freehand" as const,
      thinning: 0,
      smoothing: 0.3,
    },
  },
];

export default function InkFeelPage({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const { pathname } = useLocation();
  const device = useInkProfileSelection();
  const [account, setAccount] = useState<InkProfileAccount | null>(null);
  const accountRef = useRef<InkProfileAccount | null>(null);
  const [profiles, setProfiles] = useState<InkProfile[]>([]);
  const [selected, setSelected] = useState<InkProfile | null>(null);
  const [config, setConfig] = useState<InkProfileConfig>(
    DEFAULT_INK_PROFILE_CONFIG,
  );
  const [name, setName] = useState("");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const same = (a: InkProfileAccount) =>
    accountRef.current?.id === a.id && accountRef.current.role === a.role;
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        let a: InkProfileAccount;
        if (pathname.startsWith("/t/")) {
          a = { role: "teacher", id: (await fetchTeacherMe()).id };
        } else {
          try {
            a = { role: "student", id: (await fetchStudentMe()).id };
          } catch (e) {
            if (
              !(e instanceof ApiError && e.code === "UNAUTHORIZED") ||
              pathname.startsWith("/s/")
            )
              throw e;
            a = { role: "teacher", id: (await fetchTeacherMe()).id };
          }
        }
        if (!active) return;
        accountRef.current = a;
        setAccount(a);
        bindInkProfileAccount(a);
        const list = await fetchInkProfiles(a);
        if (!active) return;
        setProfiles(list);
        reconcileInkProfiles(list);
        if (!dirtyRef.current) {
          const choice = list.find(
            (p) => p.id === getInkProfileSelection().profileId,
          );
          setSelected(choice ?? null);
          setName(choice?.name ?? "");
          setConfig(choice?.config ?? getInkProfileSelection().config);
        }
      } catch (e) {
        if (active && !(e instanceof ApiError && e.code === "UNAUTHORIZED"))
          setError(e instanceof Error ? e.message : "读取失败，请重试");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
      accountRef.current = null;
    };
  }, [pathname]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const navigation = (e: MouseEvent) => {
      if (
        e.target instanceof Element &&
        e.target.closest("a[href]") &&
        dirtyRef.current &&
        !window.confirm("调整尚未保存，放弃调整并离开？")
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", before);
    document.addEventListener("click", navigation, true);
    return () => {
      window.removeEventListener("beforeunload", before);
      document.removeEventListener("click", navigation, true);
    };
  }, []);
  function edit(next: InkProfileConfig) {
    setConfig(next);
    setDirty(true);
    setStatus("");
  }
  function choose(id: string) {
    if (dirty && !window.confirm("调整尚未保存，放弃调整并切换？")) return;
    const p = profiles.find((item) => item.id === id);
    setSelected(p ?? null);
    setName(p?.name ?? "");
    setConfig(p?.config ?? DEFAULT_INK_PROFILE_CONFIG);
    setDirty(false);
    setError("");
    setStatus("");
  }
  async function refresh() {
    if (!account) return;
    try {
      const list = await fetchInkProfiles(account);
      if (same(account)) {
        setProfiles(list);
        reconcileInkProfiles(list);
        setError("");
        if (!dirtyRef.current && selected) {
          const current = list.find((p) => p.id === selected.id);
          setSelected(current ?? null);
          setName(current?.name ?? "");
          setConfig(current?.config ?? DEFAULT_INK_PROFILE_CONFIG);
        }
      }
    } catch (e) {
      if (same(account)) setError(e instanceof Error ? e.message : "读取失败");
    }
  }
  function apply(p: InkProfile | null = selected, saved = false) {
    try {
      if (p) selectInkProfile(p);
      else clearInkProfileSelection();
      setStatus(
        saved ? "配置已保存到账号，并在本设备使用" : "本设备已选用配置",
      );
    } catch {
      setError(
        `${saved ? "配置已保存到账号，但" : ""}浏览器未能记住设备选择，请检查存储权限。`,
      );
    }
  }
  async function save(asNew: boolean) {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      const p = await saveInkProfileApi(
        account,
        { name, config },
        asNew ? undefined : selected?.id,
        selected?.revision,
      );
      if (!same(account)) return;
      setProfiles((list) => [...list.filter((item) => item.id !== p.id), p]);
      setSelected(p);
      setName(p.name);
      setDirty(false);
      setStatus("配置已保存到账号");
      apply(p, true);
    } catch (e) {
      if (same(account))
        setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !account ||
      !selected ||
      !window.confirm("删除这份配置？笔迹不会删除。")
    )
      return;
    setBusy(true);
    try {
      await deleteInkProfileApi(account, selected.id);
      if (!same(account)) return;
      const next = profiles.filter((p) => p.id !== selected.id);
      setProfiles(next);
      reconcileInkProfiles(next);
      setSelected(null);
      setName("");
      setConfig(DEFAULT_INK_PROFILE_CONFIG);
      setDirty(false);
      setStatus("配置已删除");
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }
  const Container = embedded ? "section" : "main";
  return (
    <Container
      className={`mx-auto max-w-4xl space-y-5 ${embedded ? "" : "p-4 sm:p-6"}`}
    >
      <header>
        {embedded && (
          <Link
            to="/s/settings"
            className="mb-3 inline-flex min-h-11 items-center rounded-md text-sm text-muted-foreground outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            ← 返回学生设置
          </Link>
        )}
        <h1 className="text-2xl font-semibold">手写手感</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          边写边调整，找到舒服的手感，再保存成自己的配置。
        </p>
      </header>
      <section
        aria-label="我的配置"
        className="space-y-3 rounded-xl border border-border p-4"
      >
        {loading ? (
          <p role="status">正在读取配置…</p>
        ) : account ? (
          <>
            <div className="flex flex-wrap gap-2">
              <label className="flex flex-1 items-center gap-3 text-sm">
                我的配置
                <select
                  aria-label="我的配置"
                  className={`${control} min-w-0 flex-1`}
                  disabled={busy}
                  value={selected?.id ?? ""}
                  onChange={(e) => choose(e.target.value)}
                >
                  <option value="">默认手感／新配置</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="outline"
                className="h-11"
                disabled={busy}
                onClick={() => void refresh()}
              >
                刷新列表
              </Button>
              {selected && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => choose(selected.id)}
                >
                  重新载入配置
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              本设备正在使用：{device.name}
              。配置随账号同步，每台设备可以选择不同配置。
            </p>
          </>
        ) : (
          <p className="text-sm leading-6">
            可以先试写。
            <Link className="text-primary underline" to="/s/login">
              登录学生账号
            </Link>
            或
            <Link className="text-primary underline" to="/t/login">
              登录教师账号
            </Link>
            后，即可保存配置并在其他设备使用。
          </p>
        )}
      </section>
      <TrialPaper config={config} />
      <section
        aria-label="调整手感"
        className="space-y-4 rounded-xl border border-border p-4"
      >
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.name}
              className="h-11"
              variant="outline"
              onClick={() => edit({ ...p.config })}
            >
              {p.name}
            </Button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            线条平滑 {config.smoothing.toFixed(2)}
            <input
              aria-label="线条平滑"
              type="range"
              className="block min-h-11 w-full accent-primary"
              min="0"
              max={config.renderer === "atrament" ? 1.5 : 1}
              step="0.05"
              value={config.smoothing}
              onChange={(e) =>
                edit({ ...config, smoothing: Number(e.target.value) })
              }
            />
            <span className="text-xs text-muted-foreground">
              较低更跟手，较高更圆润。
            </span>
          </label>
          <label className="flex items-center gap-3 text-sm">
            书写方式
            <select
              className={`${control} flex-1`}
              value={config.inputMode}
              onChange={(e) =>
                edit({
                  ...config,
                  inputMode: e.target.value as InkProfileConfig["inputMode"],
                })
              }
            >
              <option value="pen">笔写／手指滚动</option>
              <option value="finger">手指也可书写</option>
            </select>
          </label>
          <label className="flex items-center gap-3 text-sm">
            默认颜色
            <select
              className={`${control} flex-1`}
              value={config.color}
              onChange={(e) =>
                edit({
                  ...config,
                  color: e.target.value as InkProfileConfig["color"],
                })
              }
            >
              <option value="black">黑色</option>
              <option value="blue">蓝色</option>
              <option value="red">红色</option>
            </select>
          </label>
          <label className="flex items-center gap-3 text-sm">
            默认粗细
            <select
              className={`${control} flex-1`}
              value={config.size}
              onChange={(e) =>
                edit({
                  ...config,
                  size: e.target.value as InkProfileConfig["size"],
                })
              }
            >
              <option value="thin">细笔</option>
              <option value="medium">中笔</option>
              <option value="thick">粗笔</option>
            </select>
          </label>
        </div>
        {config.renderer === "freehand" && (
          <details>
            <summary className="cursor-pointer py-3 text-sm">
              进一步调整笔感
            </summary>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  { key: "thinning", label: "压感变化", min: 0, max: 1 },
                  { key: "streamline", label: "轨迹稳定", min: 0, max: 1 },
                  { key: "sizeScale", label: "笔宽倍率", min: 0.5, max: 2 },
                ] as const
              ).map((item) => (
                <label className="text-sm" key={item.key}>
                  {item.label} {config[item.key].toFixed(2)}
                  <input
                    aria-label={item.label}
                    className="block min-h-11 w-full accent-primary"
                    type="range"
                    min={item.min}
                    max={item.max}
                    step="0.05"
                    value={config[item.key]}
                    onChange={(e) =>
                      edit({ ...config, [item.key]: Number(e.target.value) })
                    }
                  />
                </label>
              ))}
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={config.prediction}
                  onChange={(e) =>
                    edit({ ...config, prediction: e.target.checked })
                  }
                />
                增强跟手感
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={config.simulatePressure}
                  onChange={(e) =>
                    edit({ ...config, simulatePressure: e.target.checked })
                  }
                />
                鼠标模拟压感
              </label>
            </div>
          </details>
        )}
        <label className="flex flex-wrap items-center gap-3 text-sm">
          配置名称
          <input
            className={`${control} min-w-0 flex-1`}
            maxLength={40}
            placeholder="例如：平板硬笔、手机手指"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            className="h-11"
            disabled={!account || busy || !name.trim()}
            onClick={() => void save(!selected)}
          >
            {selected ? "保存修改" : "保存为新配置"}
          </Button>
          {selected && (
            <Button
              className="h-11"
              variant="outline"
              disabled={!account || busy || !name.trim()}
              onClick={() => void save(true)}
            >
              另存为新配置
            </Button>
          )}
          <Button
            className="h-11"
            variant="outline"
            disabled={!account || busy || dirty}
            onClick={() => apply()}
          >
            在本设备使用
          </Button>
          {selected && (
            <Button
              className="h-11"
              variant="ghost"
              disabled={busy}
              onClick={() => void remove()}
            >
              删除配置
            </Button>
          )}
        </div>
        {dirty && (
          <p className="text-xs text-muted-foreground">
            调整尚未保存，实际作答继续使用已选配置。
          </p>
        )}
        {status && <p role="status">{status}</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
    </Container>
  );
}

function TrialPaper({ config }: { config: InkProfileConfig }) {
  const host = useRef<HTMLDivElement>(null);
  const store = useRef(new InkStore());
  const surface = useRef<ToolAwareSurface | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const update = useCallback(
    () =>
      setHistory({
        undo: surface.current?.canUndo() ?? false,
        redo: surface.current?.canRedo() ?? false,
      }),
    [],
  );
  useEffect(() => {
    if (!host.current) return;
    const active =
      config.renderer === "freehand"
        ? createFeelSurface(config, { store: store.current })
        : createAtramentSurface({
            store: store.current,
            smoothing: config.smoothing,
            inputMode: config.inputMode,
          });
    surface.current = active;
    active.mount(host.current);
    active.setInputMode?.(config.inputMode);
    active.setTool({ type: "pen", color: config.color, size: config.size });
    setTool("pen");
    update();
    const off = active.onChange(update);
    return () => {
      active.finish?.();
      off();
      active.destroy();
      surface.current = null;
    };
  }, [config, update]);
  return (
    <section aria-label="试写">
      <PaperPresentation
        fullscreen={fullscreen}
        label="全屏试写"
        heading="试写手感"
        onClose={() => {
          surface.current?.finish?.();
          setFullscreen(false);
        }}
      >
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              className="h-11"
              variant={tool === "pen" ? "default" : "outline"}
              onClick={() => {
                surface.current?.setTool({
                  type: "pen",
                  color: config.color,
                  size: config.size,
                });
                setTool("pen");
              }}
            >
              笔
            </Button>
            <Button
              className="h-11"
              variant={tool === "eraser" ? "default" : "outline"}
              onClick={() => {
                surface.current?.setTool({ type: "eraser" });
                setTool("eraser");
              }}
            >
              整笔橡皮
            </Button>
            <Button
              className="h-11"
              variant="outline"
              disabled={!history.undo}
              onClick={() => surface.current?.undo()}
            >
              撤销
            </Button>
            <Button
              className="h-11"
              variant="outline"
              disabled={!history.redo}
              onClick={() => surface.current?.redo()}
            >
              重做
            </Button>
            <Button
              className="h-11"
              variant="outline"
              onClick={() => surface.current?.clear()}
            >
              清空试写
            </Button>
            {!fullscreen && (
              <Button
                className="h-11"
                variant="outline"
                onClick={() => {
                  surface.current?.finish?.();
                  setFullscreen(true);
                }}
              >
                全屏试写
              </Button>
            )}
          </div>
          <div
            data-testid="feel-paper"
            ref={host}
            className="relative h-[400px] w-full overflow-hidden rounded-xl border border-border bg-white"
          />
          <p className="text-xs leading-5 text-muted-foreground">
            写几个字、数学符号和连笔，比较轻重与转折。试写笔迹不会作为作答提交。
          </p>
        </div>
      </PaperPresentation>
    </section>
  );
}
