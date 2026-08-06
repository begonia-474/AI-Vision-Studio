// 自定义厂商管理页（全页视图，替代原弹窗）
// 主从布局：左侧厂商列表，右侧编辑器（两级）：
//   厂商表单（基本信息 + 模型列表）→ 模型编辑器（分节：基本信息 / 支持能力 / 参数模块 / 自定义参数）。
// 厂商配置以 JSON 存后端 SQLite；保存后同步 registry 动态注册表。

import { useCallback, useEffect, useState } from "react";
import type { ParseKeys } from "i18next";
import { useTranslation } from "react-i18next";
import { deleteCustomProvider, listCustomProviders, saveCustomProvider } from "../api";
import { PROTOCOL_COLORS, refreshCustomProviders, uid } from "../models/registry";
import type { CustomModelConfig, CustomParamModule, CustomProviderConfig, ProtocolType } from "../types";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { BTN, BTN_PRIMARY, CM_BADGE, CM_BADGE_ACCENT, G_CHIP, G_CHIP_ON } from "../lib/classes";
import { IconBox, IconChevron, IconTrash } from "../lib/icons";

interface ProvidersPageProps {
  /** 返回上一工作室（图像 / 视频 / 图库） */
  onBack: () => void;
}

const PROTOCOLS: ProtocolType[] = ["modelscope", "huggingface", "openai-compatible"];

/** 各协议允许的能力：任务式全能力；直接推理/兼容式仅文生图（同步协议，视频/参考图未支持）。 */
const PROTOCOL_CAPS: Record<ProtocolType, string[]> = {
  modelscope: ["t2i", "i2i", "t2v", "i2v"],
  huggingface: ["t2i"],
  "openai-compatible": ["t2i"],
};

/** 常用参数预设（按协议）：下拉一键添加，字段名/标签/类型/默认值预填，可再改。 */
interface ParamPreset {
  key: string;
  labelKey: string;
  kind: "number" | "text";
  def: string;
}

const PARAM_PRESETS: Record<ProtocolType, ParamPreset[]> = {
  modelscope: [
    { key: "steps", labelKey: "customProvider.preset.steps", kind: "number", def: "30" },
    { key: "guidance", labelKey: "customProvider.preset.guidance", kind: "number", def: "7.5" },
    { key: "seed", labelKey: "customProvider.preset.seed", kind: "number", def: "" },
    { key: "negative_prompt", labelKey: "customProvider.preset.negativePrompt", kind: "text", def: "" },
  ],
  huggingface: [
    { key: "num_inference_steps", labelKey: "customProvider.preset.steps", kind: "number", def: "30" },
    { key: "guidance_scale", labelKey: "customProvider.preset.guidance", kind: "number", def: "7.5" },
    { key: "seed", labelKey: "customProvider.preset.seed", kind: "number", def: "" },
    { key: "negative_prompt", labelKey: "customProvider.preset.negativePrompt", kind: "text", def: "" },
  ],
  "openai-compatible": [
    { key: "quality", labelKey: "customProvider.preset.quality", kind: "text", def: "standard" },
    { key: "style", labelKey: "customProvider.preset.style", kind: "text", def: "" },
  ],
};

interface FormState {
  id: string | null;
  name: string;
  protocol: ProtocolType;
  baseUrl: string;
  models: CustomModelConfig[];
}

const EMPTY_MODEL: CustomModelConfig = {
  repo_id: "",
  name: "",
  capabilities: [],
  size_presets: [],
  params: {},
};

/** 参数模块定义（勾选后出现在生成弹层 popover）。 */
const MODULE_DEFS: { type: CustomParamModule["type"]; labelKey: string }[] = [
  { type: "ratio", labelKey: "customProvider.module.ratio" },
  { type: "quality", labelKey: "customProvider.module.quality" },
  { type: "duration", labelKey: "customProvider.module.duration" },
  { type: "batch", labelKey: "customProvider.module.batch" },
  { type: "size", labelKey: "customProvider.module.size" },
];

/** 生图常用预置值（勾选模块时预填，用户可改）。 */
const DEFAULT_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16"];
const DEFAULT_IMAGE_QUALITIES = ["1K", "2K", "4K"];
const DEFAULT_VIDEO_QUALITIES = ["480P", "720P", "1080P"];
const DEFAULT_DURATIONS = ["5", "10"];

/** 预置模块模板：一键填充常用组合。 */
const MODULE_TEMPLATES: Record<string, CustomParamModule[]> = {
  tplImageBasic: [
    { type: "ratio", options: [...DEFAULT_RATIOS] },
    { type: "batch" },
  ],
  tplImageStandard: [
    { type: "ratio", options: [...DEFAULT_RATIOS] },
    { type: "quality", options: [...DEFAULT_IMAGE_QUALITIES] },
    { type: "batch" },
    { type: "size" },
  ],
  tplVideoStandard: [
    { type: "ratio", options: [...DEFAULT_RATIOS] },
    { type: "quality", options: [...DEFAULT_VIDEO_QUALITIES] },
    { type: "duration", options: [...DEFAULT_DURATIONS] },
  ],
};

/** 勾选模块时的默认选项：ratio 优先沿用 size_presets；quality 按图像/视频预置档位。 */
const defaultModule = (
  type: CustomParamModule["type"],
  presets: string[],
  isVid: boolean,
): CustomParamModule => {
  if (type === "ratio") return { type, options: presets.length > 0 ? presets : [...DEFAULT_RATIOS] };
  if (type === "quality") return { type, options: isVid ? [...DEFAULT_VIDEO_QUALITIES] : [...DEFAULT_IMAGE_QUALITIES] };
  if (type === "duration") return { type, options: [...DEFAULT_DURATIONS] };
  if (type === "size") return { type: "size" };
  return { type: "batch" };
};

const EMPTY_FORM: FormState = {
  id: null,
  name: "",
  protocol: "modelscope",
  baseUrl: "",
  models: [],
};

/** 分节卡片：编号 + 标题（+ 可选说明），承载配置分组。 */
function Section({
  index,
  title,
  hint,
  extra,
  children,
}: {
  index: string;
  title: string;
  hint?: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border-2 bg-card p-5">
      <header className="mb-3.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[rgba(59,130,246,.12)] text-[11px] font-bold text-primary">{index}</span>
          <h3 className="m-0 truncate text-[13px] font-bold text-foreground">{title}</h3>
        </div>
        {extra}
      </header>
      {hint && <p className="m-0 mb-3 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
      {children}
    </section>
  );
}

export function ProvidersPage({ onBack }: ProvidersPageProps) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<CustomProviderConfig[]>([]);
  const [mode, setMode] = useState<"list" | "form" | "model">("list");
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });
  const [modelIdx, setModelIdx] = useState<number | null>(null); // 正在编辑的模型下标
  const [modulesDraft, setModulesDraft] = useState<CustomParamModule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async (selectFirst = false) => {
    try {
      const list = (await listCustomProviders()).map((r) => JSON.parse(r.config_json) as CustomProviderConfig);
      setProviders(list);
      if (selectFirst) {
        if (list.length > 0) {
          const p = list[0];
          setForm({ id: p.id, name: p.name, protocol: p.protocol, baseUrl: p.base_url, models: p.models });
          setModelIdx(null);
          setMode("form");
        } else {
          setForm({ ...EMPTY_FORM });
          setMode("list");
        }
      }
    } catch {
      /* 忽略 */
    }
  }, []);

  useEffect(() => {
    load(true);
  }, [load]);

  // 进入模型编辑时，从已有 param_modules 装载模块草稿
  // 渲染期比较模式（React 官方 "adjusting state when a prop changes"）：
  // 仅当切换编辑目标时重置草稿，编辑中的手动改动不被覆盖。
  const [prevEditIdx, setPrevEditIdx] = useState<number | null>(null);
  if (modelIdx !== prevEditIdx) {
    setPrevEditIdx(modelIdx);
    if (modelIdx != null) setModulesDraft(form.models[modelIdx]?.param_modules ?? []);
  }

  /** 未保存标记：表单内容与已保存快照不一致。 */
  const dirty = useCallback(() => {
    const snap = form.id ? providers.find((p) => p.id === form.id) : null;
    const cur = { name: form.name, protocol: form.protocol, baseUrl: form.baseUrl, models: form.models };
    const base = snap
      ? { name: snap.name, protocol: snap.protocol, baseUrl: snap.base_url, models: snap.models }
      : { name: "", protocol: "modelscope", baseUrl: "", models: [] as CustomModelConfig[] };
    return JSON.stringify(cur) !== JSON.stringify(base);
  }, [form, providers]);

  const pickProtocol = (p: ProtocolType) => {
    setForm((f) => ({
      ...f,
      protocol: p,
      models: f.models.map((m) => ({
        ...m,
        capabilities: m.capabilities.filter((c) => PROTOCOL_CAPS[p].includes(c)),
      })),
    }));
  };

  const selectProvider = (p: CustomProviderConfig) => {
    setForm({ id: p.id, name: p.name, protocol: p.protocol, baseUrl: p.base_url, models: p.models });
    setModelIdx(null);
    setError(null);
    setMode("form");
  };

  const startNewProvider = () => {
    setForm({ ...EMPTY_FORM });
    setModelIdx(null);
    setError(null);
    setMode("form");
  };

  const toList = () => {
    setModelIdx(null);
    setError(null);
    setMode("list");
  };

  // —— 模型子编辑 ——

  const startAddModel = () => {
    setForm((f) => ({ ...f, models: [...f.models, { ...EMPTY_MODEL }] }));
    setModelIdx(form.models.length);
    setMode("model");
  };
  const startEditModel = (i: number) => {
    setModelIdx(i);
    setMode("model");
  };

  const patchModel = (i: number, delta: Partial<CustomModelConfig>) =>
    setForm((f) => ({
      ...f,
      models: f.models.map((m, idx) => (idx === i ? { ...m, ...delta } : m)),
    }));

  const confirmModel = () => {
    if (modelIdx == null) return;
    const m = form.models[modelIdx];
    if (!m || !m.repo_id.trim() || !m.name.trim()) return;
    // 自由参数模块（param）的默认值 → params（请求透传的字段默认值）。
    const params: Record<string, string | number | null> = {};
    for (const mod of modulesDraft) {
      if (mod.type !== "param") continue;
      const k = mod.key.trim();
      if (!k) continue;
      const d = mod.def ?? "";
      if (d === "") continue;
      params[k] = mod.kind === "number" && Number.isFinite(Number(d)) ? Number(d) : d;
    }
    patchModel(modelIdx, { params, param_modules: modulesDraft });
    setModelIdx(null);
    setMode("form");
  };

  const removeModel = (i: number) => {
    const m = form.models[i];
    if (m && (m.repo_id.trim() || m.name.trim())) {
      if (!window.confirm(t("customProvider.modelDeleteConfirm", { name: m.name || m.repo_id }))) return;
    }
    setForm((f) => ({ ...f, models: f.models.filter((_, idx) => idx !== i) }));
    if (modelIdx === i) {
      setModelIdx(null);
      setMode("form");
    }
  };

  /** 常用参数预设一键添加（同 key 已存在则覆盖）。 */
  const addPreset = (key: string) => {
    const preset = PARAM_PRESETS[form.protocol].find((p) => p.key === key);
    if (!preset) return;
    const mod: CustomParamModule = {
      type: "param",
      key: preset.key,
      label: t(preset.labelKey as ParseKeys),
      kind: preset.kind,
      def: preset.def,
    };
    setModulesDraft((d) => {
      const i = d.findIndex((x) => x.type === "param" && x.key === preset.key);
      return i >= 0 ? d.map((x, idx) => (idx === i ? mod : x)) : [...d, mod];
    });
  };

  // —— 厂商保存 / 删除 ——

  const save = async () => {
    if (!form.name.trim() || form.models.length === 0) return;
    const cfg: CustomProviderConfig = {
      id: form.id ?? uid(),
      name: form.name.trim(),
      protocol: form.protocol,
      base_url: form.baseUrl.trim().replace(/\/+$/, ""),
      models: form.models,
    };
    try {
      await saveCustomProvider(cfg.id, JSON.stringify(cfg, null, 2));
      await refreshCustomProviders();
      setError(null);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      await load(true);
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? "保存失败");
    }
  };

  const remove = async (p: CustomProviderConfig) => {
    if (!window.confirm(t("customProvider.deleteConfirm", { name: p.name }))) return;
    try {
      await deleteCustomProvider(p.id);
      await refreshCustomProviders();
      await load(true);
    } catch (e) {
      setError(String(e));
    }
  };

  const modelForm = modelIdx != null ? form.models[modelIdx] : null;
  const isVidModel = modelForm?.capabilities.some((c) => c === "t2v" || c === "i2v") ?? false;
  const modelFormValid =
    modelForm != null && !!modelForm.repo_id.trim() && !!modelForm.name.trim();
  const formValid = !!form.name.trim() && form.models.length > 0 && mode !== "model";

  const field = "flex flex-col gap-1.5";
  const fieldLabel = "text-[11px] font-semibold text-text-3";
  const input =
    "resize-none rounded-md border border-border-2 bg-soft px-3 py-2 text-xs text-foreground outline-none transition-colors duration-150 focus:border-[rgba(59,130,246,.50)]";
  const select =
    "rounded-md border border-border-2 bg-soft px-3 py-2 text-xs text-foreground outline-none focus:border-[rgba(59,130,246,.50)]";
  const itemBtn =
    "flex h-[26px] cursor-pointer items-center justify-center rounded-md border border-border-2 bg-chip px-2.5 text-[10px] font-semibold text-text-2 transition-colors duration-150 hover:border-[rgba(59,130,246,.40)] hover:text-primary";
  const itemBtnDanger =
    "flex h-[26px] cursor-pointer items-center justify-center rounded-md border border-border-2 bg-chip px-2.5 text-[10px] font-semibold transition-colors duration-150 hover:border-[rgba(239,68,68,.40)] hover:text-destructive";

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* 顶栏：返回 + 标题 */}
      <header className="flex h-[68px] shrink-0 items-center gap-4 border-b border-border-1 px-6">
        <button
          className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg border border-border-2 bg-soft text-text-3 transition-colors duration-150 hover:bg-hover-2 hover:text-foreground"
          title={t("customProvider.backToStudio")}
          aria-label={t("customProvider.backToStudio")}
          onClick={onBack}
        >
          <IconChevron className="-rotate-90" size={16} />
        </button>
        <div className="min-w-0">
          <h1 className="m-0 truncate text-[15px] font-bold tracking-tight">{t("customProvider.title")}</h1>
          <p className="m-0 mt-0.5 truncate text-[11px] text-muted-foreground">{t("customProvider.desc")}</p>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左列：厂商列表 */}
        <aside className="flex w-[300px] shrink-0 flex-col border-r border-border-1 bg-card-shade/40">
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <span className="text-[11px] font-bold uppercase tracking-[.08em] text-faint">{t("customProvider.list")}</span>
            <span className="text-[10px] text-faint-2">{providers.length}</span>
          </div>
          <div className="scrollbar-none flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-3">
            {providers.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border-2 p-4 text-center text-[11px] leading-relaxed text-muted-foreground">{t("customProvider.emptyList")}</div>
            ) : (
              providers.map((p) => {
                const active = form.id === p.id && mode !== "list";
                return (
                  <div
                    className={cn(
                      "group relative flex items-center gap-2 rounded-xl border p-3 transition-all duration-150",
                      active
                        ? "border-[rgba(59,130,246,.40)] bg-[rgba(59,130,246,.08)]"
                        : "border-transparent hover:bg-hover",
                    )}
                    key={p.id}
                  >
                    <button className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => selectProvider(p)}>
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-semibold text-foreground">{p.name}</span>
                        <span className={cn(CM_BADGE, CM_BADGE_ACCENT)} style={{ color: PROTOCOL_COLORS[p.protocol] }}>
                          {t(`customProvider.protocolShort.${p.protocol}`)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">{p.base_url || "—"}</span>
                        <span className="shrink-0 text-[10px] text-faint-2">{p.models.length} {t("customProvider.modelsCount")}</span>
                      </div>
                    </button>
                    <button
                      className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-faint-2 opacity-0 transition-all duration-150 hover:text-destructive group-hover:opacity-100"
                      title={t("customProvider.delete")}
                      aria-label={t("customProvider.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(p);
                      }}
                    >
                      <IconTrash size={13} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <div className="border-t border-border-1 p-3">
            <Button className={cn(BTN, "w-full")} onClick={startNewProvider}>
              ＋ {t("customProvider.add")}
            </Button>
          </div>
        </aside>

        {/* 右列：编辑器 */}
        <main className="flex min-w-0 flex-1 flex-col bg-background">
          {mode === "list" && (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <div className="grid size-14 place-items-center rounded-2xl border border-border-2 bg-chip">
                <IconBox size={26} className="text-primary" />
              </div>
              <h2 className="m-0 text-base font-bold text-foreground">{t("customProvider.empty")}</h2>
              <p className="m-0 max-w-[400px] text-xs leading-relaxed text-muted-foreground">{t("customProvider.desc")}</p>
              <Button className={cn(BTN_PRIMARY, "mt-2")} onClick={startNewProvider}>
                ＋ {t("customProvider.add")}
              </Button>
            </div>
          )}

          {mode === "form" && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto p-6">
                <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 text-[11px] text-faint-2">
                      <button
                        className="flex shrink-0 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-faint-2 transition-colors duration-150 hover:text-primary"
                        onClick={toList}
                      >
                        <IconChevron className="-rotate-90" size={12} /> {t("customProvider.backToList")}
                      </button>
                      <span>/</span>
                      <span className="truncate font-semibold text-text-2">{form.name.trim() || t("customProvider.newProvider")}</span>
                    </div>
                    {dirty() && (
                      <span className="shrink-0 rounded-full border border-[rgba(245,158,11,.35)] bg-[rgba(245,158,11,.10)] px-2.5 py-1 text-[10px] font-semibold text-warn">
                        {t("customProvider.unsaved")}
                      </span>
                    )}
                  </div>

                  {/* 厂商基本信息 */}
                  <Section index="1" title={t("customProvider.sectionBasic")}>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className={field}>
                        <span className={fieldLabel}>{t("customProvider.name")} *</span>
                        <input className={input} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder={t("customProvider.namePh")} />
                      </label>
                      <label className={field}>
                        <span className={fieldLabel}>{t("customProvider.protocol")}</span>
                        <select className={select} value={form.protocol} onChange={(e) => pickProtocol(e.target.value as ProtocolType)}>
                          {PROTOCOLS.map((p) => (
                            <option key={p} value={p}>{t(`customProvider.protocolName.${p}`)}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label className={cn(field, "mt-3")}>
                      <span className={fieldLabel}>{t("customProvider.baseUrl")} *</span>
                      <input className={input} value={form.baseUrl} onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))} placeholder="https://..." />
                    </label>
                    <p className="m-0 mt-2 text-[10px] leading-relaxed text-muted-foreground">{t(`customProvider.protocolHint.${form.protocol}`)}</p>
                  </Section>

                  {/* 模型列表 */}
                  <Section
                    index="2"
                    title={`${t("customProvider.models")}（${form.models.length}）`}
                    extra={
                      <Button className={BTN} size="sm" onClick={startAddModel}>
                        ＋ {t("customProvider.addModel")}
                      </Button>
                    }
                  >
                    {form.models.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border-2 py-8 text-center text-[11px] text-muted-foreground">{t("customProvider.emptyModels")}</div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {form.models.map((m, i) => (
                          <div
                            className="flex items-center justify-between gap-2.5 rounded-xl border border-border-2 bg-chip px-3.5 py-3 transition-colors duration-150 hover:border-[rgba(59,130,246,.25)]"
                            key={`${m.repo_id}_${i}`}
                          >
                            <div className="flex min-w-0 flex-col">
                              <span className="text-xs font-semibold text-foreground">
                                {m.name || m.repo_id || "?"}
                                <span className={CM_BADGE}>{m.capabilities.length > 0 ? m.capabilities.join(" / ") : "—"}</span>
                              </span>
                              <span className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{m.repo_id || t("customProvider.repoIdPh")}</span>
                            </div>
                            <div className="flex shrink-0 gap-1.5">
                              <button className={itemBtn} onClick={() => startEditModel(i)}>{t("customProvider.edit")}</button>
                              <button className={cn(itemBtnDanger, "hover:border-[rgba(239,68,68,.40)] hover:text-destructive")} onClick={() => removeModel(i)}>{t("customProvider.delete")}</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Section>
                </div>
              </div>

              {/* 底部操作条 */}
              <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-2 px-6 py-3">
                <div className="flex min-w-0 items-center gap-2.5 text-[11px]">
                  {error && <span className="truncate text-destructive">{error}</span>}
                  {saved && <span className="shrink-0 font-semibold text-success animate-[fadeInUp_.2s]">✓ {t("common.saved")}</span>}
                </div>
                <div className="flex shrink-0 gap-2.5">
                  <Button className={BTN} onClick={toList}>{t("common.cancel")}</Button>
                  <Button className={BTN_PRIMARY} disabled={!formValid} onClick={save}>{t("customProvider.save")}</Button>
                </div>
              </div>
            </div>
          )}

          {mode === "model" && modelForm && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto p-6">
                <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 text-[11px] text-faint-2">
                      <button
                        className="flex shrink-0 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-faint-2 transition-colors duration-150 hover:text-primary"
                        onClick={() => {
                          setModelIdx(null);
                          setMode("form");
                        }}
                      >
                        <IconChevron className="-rotate-90" size={12} /> {t("customProvider.backToProvider")}
                      </button>
                      <span>/</span>
                      <span className="truncate font-semibold text-text-2">{t("customProvider.modelEdit")}</span>
                      <span className={CM_BADGE}>{modelForm.name || modelForm.repo_id || "?"}</span>
                    </div>
                    <button
                      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent p-1 text-[10px] font-semibold text-faint-2 transition-colors duration-150 hover:text-destructive"
                      onClick={() => removeModel(modelIdx!)}
                    >
                      <IconTrash size={12} /> {t("customProvider.deleteModel")}
                    </button>
                  </div>

                  {/* 模型基本信息 */}
                  <Section index="1" title={t("customProvider.sectionBasic")}>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className={field}>
                        <span className={fieldLabel}>{t("customProvider.repoId")} *</span>
                        <input className={input} value={modelForm.repo_id} onChange={(e) => patchModel(modelIdx!, { repo_id: e.target.value })} placeholder={t("customProvider.repoIdPh")} />
                      </label>
                      <label className={field}>
                        <span className={fieldLabel}>{t("customProvider.name")} *</span>
                        <input className={input} value={modelForm.name} onChange={(e) => patchModel(modelIdx!, { name: e.target.value })} placeholder={t("customProvider.namePh")} />
                      </label>
                    </div>
                  </Section>

                  {/* 支持能力 */}
                  <Section index="2" title={t("customProvider.capabilities")}>
                    <div className="flex flex-wrap gap-2">
                      {PROTOCOL_CAPS[form.protocol].map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={cn(G_CHIP, "h-8", modelForm.capabilities.includes(c) && G_CHIP_ON)}
                          onClick={() =>
                            patchModel(modelIdx!, {
                              capabilities: modelForm.capabilities.includes(c)
                                ? modelForm.capabilities.filter((x) => x !== c)
                                : [...modelForm.capabilities, c],
                            })
                          }
                        >
                          {t(`gallery.capability.${c}` as ParseKeys)}
                        </button>
                      ))}
                    </div>
                  </Section>

                  {/* 参数模块 */}
                  <Section
                    index="3"
                    title={t("customProvider.paramModules")}
                    hint={t("customProvider.paramModulesHint")}
                    extra={
                      <div className="flex shrink-0 flex-wrap justify-end gap-1">
                        <button type="button" className="h-6 cursor-pointer rounded-md border border-border-2 bg-chip px-2 text-[10px] font-semibold text-text-2 transition-colors duration-150 hover:border-[rgba(59,130,246,.40)] hover:text-primary" onClick={() => setModulesDraft(MODULE_TEMPLATES.tplImageBasic)}>{t("customProvider.tplImageBasic")}</button>
                        <button type="button" className="h-6 cursor-pointer rounded-md border border-border-2 bg-chip px-2 text-[10px] font-semibold text-text-2 transition-colors duration-150 hover:border-[rgba(59,130,246,.40)] hover:text-primary" onClick={() => setModulesDraft(MODULE_TEMPLATES.tplImageStandard)}>{t("customProvider.tplImageStandard")}</button>
                        <button type="button" className="h-6 cursor-pointer rounded-md border border-border-2 bg-chip px-2 text-[10px] font-semibold text-text-2 transition-colors duration-150 hover:border-[rgba(59,130,246,.40)] hover:text-primary" onClick={() => setModulesDraft(MODULE_TEMPLATES.tplVideoStandard)}>{t("customProvider.tplVideoStandard")}</button>
                        <button type="button" className="h-6 cursor-pointer rounded-md border border-border-2 bg-chip px-2 text-[10px] font-semibold text-text-2 transition-colors duration-150 hover:border-[rgba(239,68,68,.40)] hover:text-destructive" onClick={() => setModulesDraft([])}>{t("customProvider.tplNone")}</button>
                      </div>
                    }
                  >
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {MODULE_DEFS.map((def) => {
                        const mod = modulesDraft.find((m) => m.type === def.type);
                        return (
                          <div key={def.type} className="rounded-xl border border-border-2 bg-chip/60 p-3">
                            <label className="flex cursor-pointer items-center gap-2">
                              <input
                                type="checkbox"
                                className="size-3.5 cursor-pointer accent-[var(--accent)]"
                                checked={!!mod}
                                onChange={(e) =>
                                  setModulesDraft((d) =>
                                    e.target.checked
                                      ? [...d, defaultModule(def.type, modelForm.size_presets, isVidModel)]
                                      : d.filter((m) => m.type !== def.type),
                                  )
                                }
                              />
                              <span className="text-xs font-semibold text-text-2">{t(def.labelKey as ParseKeys)}</span>
                            </label>
                            {mod && mod.type !== "batch" && mod.type !== "size" && mod.type !== "param" && (
                              <input
                                className={cn(input, "mt-2 px-2.5 py-1.5 font-mono text-[11px]")}
                                value={mod.options.join(", ")}
                                placeholder={t("customProvider.moduleOptionsPh")}
                                onChange={(e) =>
                                  setModulesDraft((d) =>
                                    d.map((m) =>
                                      m.type === mod.type
                                        ? { ...m, options: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) }
                                        : m,
                                    ),
                                  )
                                }
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </Section>

                  {/* 自定义参数 */}
                  <Section
                    index="4"
                    title={t("customProvider.paramModulesFree")}
                    hint={t("customProvider.paramModulesFreeHint")}
                    extra={
                      <div className="flex shrink-0 items-center gap-1.5">
                        <select
                          className={cn(select, "px-2 py-1 text-[10px]")}
                          value=""
                          onChange={(e) => {
                            if (e.target.value) addPreset(e.target.value);
                          }}
                        >
                          <option value="">{t("customProvider.presetAdd")}</option>
                          {PARAM_PRESETS[form.protocol].map((p) => (
                            <option key={p.key} value={p.key}>{t(p.labelKey as ParseKeys)}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="cursor-pointer rounded-md border border-dashed border-border-3 bg-transparent px-2.5 py-1 text-[10px] font-semibold text-muted-foreground transition-all duration-150 hover:border-[rgba(59,130,246,.40)] hover:text-primary"
                          onClick={() =>
                            setModulesDraft((d) => [
                              ...d,
                              { type: "param", key: "", label: "", kind: "number", def: "" },
                            ])
                          }
                        >
                          ＋ {t("customProvider.addParam")}
                        </button>
                      </div>
                    }
                  >
                    {modulesDraft.filter((m) => m.type === "param").length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border-2 py-6 text-center text-[11px] text-muted-foreground">{t("customProvider.emptyParams")}</div>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {modulesDraft
                          .filter((m) => m.type === "param")
                          .map((mod, i) => {
                            const idx = modulesDraft.findIndex((x) => x === mod);
                            return (
                              <div className="flex flex-wrap items-center gap-1.5" key={`${mod.key}_${i}`}>
                                <input
                                  className={cn(input, "font-mono w-[30%] px-2.5 py-1.5 text-[11px]")}
                                  value={mod.key}
                                  placeholder={t("customProvider.pmKeyPh")}
                                  onChange={(e) =>
                                    setModulesDraft((d) =>
                                      d.map((x, j) => (j === idx ? { ...x, key: e.target.value } : x)),
                                    )
                                  }
                                />
                                <input
                                  className={cn(input, "w-[26%] px-2.5 py-1.5 text-[11px]")}
                                  value={mod.label}
                                  placeholder={t("customProvider.pmLabelPh")}
                                  onChange={(e) =>
                                    setModulesDraft((d) =>
                                      d.map((x, j) => (j === idx ? { ...x, label: e.target.value } : x)),
                                    )
                                  }
                                />
                                <select
                                  className={cn(select, "w-[18%] px-2 py-1.5 text-[11px]")}
                                  value={mod.kind}
                                  onChange={(e) =>
                                    setModulesDraft((d) =>
                                      d.map((x, j) =>
                                        j === idx ? { ...x, kind: e.target.value as "number" | "text" } : x,
                                      ),
                                    )
                                  }
                                >
                                  <option value="number">{t("customProvider.pmKindNumber")}</option>
                                  <option value="text">{t("customProvider.pmKindText")}</option>
                                </select>
                                <input
                                  className={cn(input, "flex-1 min-w-[60px] px-2.5 py-1.5 text-[11px]")}
                                  value={mod.def ?? ""}
                                  placeholder={t("customProvider.pmDefPh")}
                                  onChange={(e) =>
                                    setModulesDraft((d) =>
                                      d.map((x, j) => (j === idx ? { ...x, def: e.target.value } : x)),
                                    )
                                  }
                                />
                                <button
                                  type="button"
                                  className="grid size-[26px] shrink-0 cursor-pointer place-items-center rounded-md border border-border-2 bg-chip text-[13px] leading-none text-muted-foreground transition-all duration-150 hover:border-[rgba(239,68,68,.40)] hover:text-destructive"
                                  title={t("customProvider.kvDel")}
                                  onClick={() => setModulesDraft((d) => d.filter((x) => x !== mod))}
                                >
                                  ×
                                </button>
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </Section>
                </div>
              </div>

              {/* 底部操作条 */}
              <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-2 px-6 py-3">
                <span className="text-[11px] text-faint-2">{modelFormValid ? "" : t("customProvider.modelRequiredHint")}</span>
                <div className="flex shrink-0 gap-2.5">
                  <Button className={BTN} onClick={() => { setModelIdx(null); setMode("form"); }}>{t("common.cancel")}</Button>
                  <Button className={BTN_PRIMARY} disabled={!modelFormValid} onClick={confirmModel}>{t("customProvider.done")}</Button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
