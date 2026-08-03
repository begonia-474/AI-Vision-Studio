// 自定义厂商管理 Modal
// 平台型服务（协议统一、模型众多）：选定协议类型 + Base URL，再按模型 ID 添加模型。
// 模型参数按协议以"中文标签"的具名表单展示（代码内完成 标签→接口字段名 映射），
// 高级参数区保留自由键值对（供熟悉接口的用户补充字段）。
// 厂商配置整体以 JSON 存后端 SQLite；保存后同步 registry 动态注册表。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { deleteCustomProvider, listCustomProviders, saveCustomProvider } from "../api";
import { PROTOCOL_COLORS, refreshCustomProviders, uid } from "../models/registry";
import type { CustomModelConfig, CustomParamModule, CustomProviderConfig, ProtocolType } from "../types";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { BTN, BTN_PRIMARY, CM_BADGE, CM_BADGE_ACCENT, G_CHIP, G_CHIP_ON, MDESC, MODAL } from "../lib/classes";

interface CustomProviderModalProps {
  open: boolean;
  onClose: () => void;
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

export function CustomProviderModal({ open, onClose }: CustomProviderModalProps) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<CustomProviderConfig[]>([]);
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });
  const [modelIdx, setModelIdx] = useState<number | null>(null); // 正在编辑的模型下标
  const [modulesDraft, setModulesDraft] = useState<CustomParamModule[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setProviders(
        (await listCustomProviders()).map((r) => JSON.parse(r.config_json) as CustomProviderConfig),
      );
    } catch {
      /* 忽略 */
    }
  };

  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY_FORM });
      setModelIdx(null);
      setError(null);
      load();
    }
  }, [open]);

  const pickProtocol = (p: ProtocolType) => {
    setForm((f) => ({
      ...f,
      protocol: p,
      models: f.models.map((m) => ({
        ...m,
        capabilities: m.capabilities.filter((c) => PROTOCOL_CAPS[p].includes(c)),
      })),
    }));
    setModelIdx(null);
  };

  // —— 模型子编辑 ——

  const startAddModel = () => {
    setForm((f) => ({ ...f, models: [...f.models, { ...EMPTY_MODEL }] }));
    setModelIdx(form.models.length);
  };
  const startEditModel = (i: number) => setModelIdx(i);

  const patchModel = (i: number, delta: Partial<CustomModelConfig>) =>
    setForm((f) => ({
      ...f,
      models: f.models.map((m, idx) => (idx === i ? { ...m, ...delta } : m)),
    }));

  // 进入模型编辑时，从已有 param_modules 装载模块草稿
  useEffect(() => {
    if (modelIdx == null) return;
    const m = form.models[modelIdx];
    if (!m) return;
    setModulesDraft(m.param_modules ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelIdx]);

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
  };

  /** 常用参数预设一键添加（同 key 已存在则覆盖）。 */
  const addPreset = (key: string) => {
    const preset = PARAM_PRESETS[form.protocol].find((p) => p.key === key);
    if (!preset) return;
    const mod: CustomParamModule = {
      type: "param",
      key: preset.key,
      label: t(preset.labelKey),
      kind: preset.kind,
      def: preset.def,
    };
    setModulesDraft((d) => {
      const i = d.findIndex((x) => x.type === "param" && x.key === preset.key);
      return i >= 0 ? d.map((x, idx) => (idx === i ? mod : x)) : [...d, mod];
    });
  };

  const removeModel = (i: number) =>
    setForm((f) => ({ ...f, models: f.models.filter((_, idx) => idx !== i) }));

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
      await load();
      setForm({ ...EMPTY_FORM, protocol: cfg.protocol });
      setModelIdx(null);
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? "保存失败");
    }
  };

  const remove = async (p: CustomProviderConfig) => {
    if (!window.confirm(t("customProvider.deleteConfirm", { name: p.name }))) return;
    try {
      await deleteCustomProvider(p.id);
      await refreshCustomProviders();
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  const startEditProvider = (p: CustomProviderConfig) => {
    setForm({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.base_url,
      models: p.models,
    });
    setModelIdx(null);
  };

  const modelForm = modelIdx != null ? form.models[modelIdx] : null;
  const isVidModel = modelForm?.capabilities.some((c) => c === "t2v" || c === "i2v") ?? false;
  const modelFormValid =
    modelForm != null && !!modelForm.repo_id.trim() && !!modelForm.name.trim();

  const cmField = "flex flex-col gap-1.5";
  const cmFieldLabel = "text-[11px] font-semibold text-text-3";
  const cmInput =
    "resize-none rounded-md border border-border-2 bg-soft px-2.5 py-[7px] text-xs text-foreground outline-none transition-colors duration-150 focus:border-[rgba(59,130,246,.50)]";
  const cmSelect =
    "rounded-md border border-border-2 bg-soft px-2.5 py-[7px] text-xs text-foreground outline-none focus:border-[rgba(59,130,246,.50)]";
  const cmItem = "flex items-center justify-between gap-2.5 rounded-md border border-border-2 bg-chip px-3 py-2";
  const cmItemBtn = cn(BTN, "h-[26px] px-2.5 text-[10px]");

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={cn(MODAL, "w-[94vw] max-w-[700px]")} showCloseButton={false}>
        <DialogTitle>{t("customProvider.title")}</DialogTitle>
        <DialogDescription className={MDESC}>{t("customProvider.desc")}</DialogDescription>

        {error && <div className="mb-3 rounded-md border border-[rgba(239,68,68,.30)] bg-[rgba(239,68,68,.10)] px-3 py-2 text-[11px] text-destructive">{error}</div>}

        {/* —— 厂商列表 —— */}
        <div className="mb-2 flex items-center justify-between text-xs font-bold text-text-2">
          <span>{t("customProvider.list")}</span>
          <Button
            className={BTN}
            size="sm"
            onClick={() => {
              setForm({ ...EMPTY_FORM });
              setModelIdx(null);
            }}
          >
            ＋ {t("customProvider.add")}
          </Button>
        </div>
        <div className="mb-4 flex max-h-[180px] flex-col gap-1.5 overflow-y-auto pr-1">
          {providers.length === 0 ? (
            <div className="rounded-md border border-dashed border-border-2 py-4 text-center text-[11px] text-muted-foreground">{t("customProvider.emptyList")}</div>
          ) : (
            providers.map((p) => (
              <div className={cn(cmItem, form.id === p.id && "border-[rgba(59,130,246,.45)]")} key={p.id}>
                <div className="flex min-w-0 flex-col">
                  <span className="text-xs font-semibold">
                    {p.name}
                    <span className={cn(CM_BADGE, CM_BADGE_ACCENT)} style={{ color: PROTOCOL_COLORS[p.protocol] }}>
                      {t(`customProvider.protocolName.${p.protocol}`)}
                    </span>
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {p.base_url} · {p.models.length} {t("customProvider.modelsCount")}
                  </span>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button className={cmItemBtn} onClick={() => startEditProvider(p)}>{t("customProvider.edit")}</button>
                  <button className={cmItemBtn} style={{ color: "var(--danger)", borderColor: "rgba(239,68,68,.35)" }} onClick={() => remove(p)}>{t("customProvider.delete")}</button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* —— 厂商表单 —— */}
        <div className="flex flex-col gap-2.5 border-t border-border-2 pt-3.5">
          <div className="grid grid-cols-2 gap-2.5">
            <label className={cmField}>
              <span className={cmFieldLabel}>{t("customProvider.name")} *</span>
              <input className={cmInput} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder={t("customProvider.namePh")} />
            </label>
            <label className={cmField}>
              <span className={cmFieldLabel}>{t("customProvider.protocol")}</span>
              <select
                className={cmSelect}
                value={form.protocol}
                onChange={(e) => pickProtocol(e.target.value as ProtocolType)}
              >
                {PROTOCOLS.map((p) => (
                  <option key={p} value={p}>{t(`customProvider.protocolName.${p}`)}</option>
                ))}
              </select>
            </label>
          </div>

          <label className={cmField}>
            <span className={cmFieldLabel}>{t("customProvider.baseUrl")} *</span>
            <input
              className={cmInput}
              value={form.baseUrl}
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
              placeholder="https://..."
            />
          </label>
          <p className="m-0 text-[10px] text-muted-foreground">{t(`customProvider.protocolHint.${form.protocol}`)}</p>

          {/* 模型子列表 */}
          <div className="mb-2 flex items-center justify-between text-xs font-bold text-text-2">
            <span>{t("customProvider.models")}</span>
            <Button className={BTN} size="sm" onClick={startAddModel}>
              ＋ {t("customProvider.addModel")}
            </Button>
          </div>
          <div className="flex max-h-[160px] flex-col gap-1.5 overflow-y-auto pr-1">
            {form.models.length === 0 ? (
              <div className="rounded-md border border-dashed border-border-2 py-4 text-center text-[11px] text-muted-foreground">{t("customProvider.emptyModels")}</div>
            ) : (
              form.models.map((m, i) => (
                <div className={cn(cmItem, modelIdx === i && "border-[rgba(59,130,246,.45)]")} key={`${m.repo_id}_${i}`}>
                  <div className="flex min-w-0 flex-col">
                    <span className="text-xs font-semibold">
                      {m.name || m.repo_id}
                      <span className={CM_BADGE}>{m.capabilities.join(" / ")}</span>
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">{m.repo_id}</span>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <button className={cmItemBtn} onClick={() => startEditModel(i)}>{t("customProvider.edit")}</button>
                    <button className={cmItemBtn} style={{ color: "var(--danger)", borderColor: "rgba(239,68,68,.35)" }} onClick={() => removeModel(i)}>{t("customProvider.delete")}</button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* 模型子表单（选中模型时展开） */}
          {modelForm && (
            <div className="mt-1 flex flex-col gap-2.5 rounded-xl border border-[rgba(59,130,246,.25)] bg-chip p-3">
              <div className="mb-2 flex items-center justify-between text-xs font-bold text-text-2">
                <span>
                  {t("customProvider.modelEdit")}
                  <span className={CM_BADGE}>{modelForm.name || modelForm.repo_id || "?"}</span>
                </span>
                <Button className={BTN} size="sm" disabled={!modelFormValid} onClick={confirmModel}>
                  {t("customProvider.done")}
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <label className={cmField}>
                  <span className={cmFieldLabel}>{t("customProvider.repoId")} *</span>
                  <input className={cmInput} value={modelForm.repo_id} onChange={(e) => patchModel(modelIdx!, { repo_id: e.target.value })} placeholder={t("customProvider.repoIdPh")} />
                </label>
                <label className={cmField}>
                  <span className={cmFieldLabel}>{t("customProvider.name")} *</span>
                  <input className={cmInput} value={modelForm.name} onChange={(e) => patchModel(modelIdx!, { name: e.target.value })} placeholder={t("customProvider.namePh")} />
                </label>
              </div>

              <div className={cmField}>
                <span className={cmFieldLabel}>{t("customProvider.capabilities")}</span>
                <div className="flex flex-wrap gap-2">
                  {PROTOCOL_CAPS[form.protocol].map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={cn(G_CHIP, "h-7", modelForm.capabilities.includes(c) && G_CHIP_ON)}
                      onClick={() =>
                        patchModel(modelIdx!, {
                          capabilities: modelForm.capabilities.includes(c)
                            ? modelForm.capabilities.filter((x) => x !== c)
                            : [...modelForm.capabilities, c],
                        })
                      }
                    >
                      {t(`gallery.capability.${c}`)}
                    </button>
                  ))}
                </div>
              </div>

              {/* 参数模块：勾选 popover 分区 + 选项 + 预置模板（尺寸预设已并入比例模块选项） */}
              <div className={cmField}>
                <div className="flex items-center justify-between gap-2">
                  <span className={cmFieldLabel}>{t("customProvider.paramModules")}</span>
                  <div className="flex flex-wrap gap-1">
                    <button type="button" className="h-6 cursor-pointer rounded-md border border-border-2 bg-chip px-2 text-[10px] font-semibold text-text-2 transition-colors hover:border-[rgba(59,130,246,.40)] hover:text-primary" onClick={() => setModulesDraft(MODULE_TEMPLATES.tplImageBasic)}>{t("customProvider.tplImageBasic")}</button>
                    <button type="button" className="h-6 cursor-pointer rounded-md border border-border-2 bg-chip px-2 text-[10px] font-semibold text-text-2 transition-colors hover:border-[rgba(59,130,246,.40)] hover:text-primary" onClick={() => setModulesDraft(MODULE_TEMPLATES.tplImageStandard)}>{t("customProvider.tplImageStandard")}</button>
                    <button type="button" className="h-6 cursor-pointer rounded-md border border-border-2 bg-chip px-2 text-[10px] font-semibold text-text-2 transition-colors hover:border-[rgba(59,130,246,.40)] hover:text-primary" onClick={() => setModulesDraft(MODULE_TEMPLATES.tplVideoStandard)}>{t("customProvider.tplVideoStandard")}</button>
                    <button type="button" className="h-6 cursor-pointer rounded-md border border-border-2 bg-chip px-2 text-[10px] font-semibold text-text-2 transition-colors hover:border-[rgba(239,68,68,.40)] hover:text-destructive" onClick={() => setModulesDraft([])}>{t("customProvider.tplNone")}</button>
                  </div>
                </div>
                <p className="m-0 text-[10px] text-muted-foreground">{t("customProvider.paramModulesHint")}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {MODULE_DEFS.map((def) => {
                    const mod = modulesDraft.find((m) => m.type === def.type);
                    return (
                      <div key={def.type} className="rounded-md border border-border-2 bg-chip/60 p-2">
                        <label className="flex cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            className="size-3 cursor-pointer accent-[var(--accent)]"
                            checked={!!mod}
                            onChange={(e) =>
                              setModulesDraft((d) =>
                                e.target.checked
                                  ? [...d, defaultModule(def.type, modelForm.size_presets, isVidModel)]
                                  : d.filter((m) => m.type !== def.type),
                              )
                            }
                          />
                          <span className="text-[11px] font-semibold text-text-2">{t(def.labelKey)}</span>
                        </label>
                        {mod && mod.type !== "batch" && mod.type !== "size" && mod.type !== "param" && (
                          <input
                            className={cn(cmInput, "mt-1.5 px-2.5 py-1.5 font-mono text-[11px]")}
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
              </div>

              {/* 自定义参数模块：运行时在 popover 里调整的自由参数（steps/guidance/seed 等） */}
              <div className={cmField}>
                <div className="flex items-center justify-between gap-2">
                  <span className={cmFieldLabel}>{t("customProvider.paramModulesFree")}</span>
                  <div className="flex items-center gap-1.5">
                    <select
                      className={cn(cmSelect, "px-2 py-1 text-[10px]")}
                      value=""
                      onChange={(e) => {
                        if (e.target.value) addPreset(e.target.value);
                      }}
                    >
                      <option value="">{t("customProvider.presetAdd")}</option>
                      {PARAM_PRESETS[form.protocol].map((p) => (
                        <option key={p.key} value={p.key}>{t(p.labelKey)}</option>
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
                </div>
                <p className="m-0 text-[10px] text-muted-foreground">{t("customProvider.paramModulesFreeHint")}</p>
                <div className="flex flex-col gap-1.5">
                  {modulesDraft
                    .filter((m) => m.type === "param")
                    .map((mod, i) => {
                      const idx = modulesDraft.findIndex((x) => x === mod);
                      return (
                        <div className="flex flex-wrap items-center gap-1.5" key={`${mod.key}_${i}`}>
                          <input
                            className={cn(cmInput, "font-mono w-[30%] px-2.5 py-1.5 text-[11px]")}
                            value={mod.key}
                            placeholder={t("customProvider.pmKeyPh")}
                            onChange={(e) =>
                              setModulesDraft((d) =>
                                d.map((x, j) => (j === idx ? { ...x, key: e.target.value } : x)),
                              )
                            }
                          />
                          <input
                            className={cn(cmInput, "w-[26%] px-2.5 py-1.5 text-[11px]")}
                            value={mod.label}
                            placeholder={t("customProvider.pmLabelPh")}
                            onChange={(e) =>
                              setModulesDraft((d) =>
                                d.map((x, j) => (j === idx ? { ...x, label: e.target.value } : x)),
                              )
                            }
                          />
                          <select
                            className={cn(cmSelect, "w-[18%] px-2 py-1.5 text-[11px]")}
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
                            className={cn(cmInput, "flex-1 min-w-[60px] px-2.5 py-1.5 text-[11px]")}
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
                            onClick={() =>
                              setModulesDraft((d) => d.filter((x) => x !== mod))
                            }
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2.5">
          <DialogClose asChild>
            <Button className={BTN}>{t("common.close")}</Button>
          </DialogClose>
          <Button
            className={BTN_PRIMARY}
            disabled={!form.name.trim() || form.models.length === 0 || modelIdx != null}
            onClick={save}
          >
            {t("customProvider.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
