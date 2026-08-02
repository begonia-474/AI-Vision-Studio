// 自定义厂商管理 Modal
// 平台型服务（协议统一、模型众多）：选定协议类型 + Base URL，再按模型 ID 添加模型。
// 模型参数按协议以"中文标签"的具名表单展示（代码内完成 标签→接口字段名 映射），
// 高级参数区保留自由键值对（供熟悉接口的用户补充字段）。
// 厂商配置整体以 JSON 存后端 SQLite；保存后同步 registry 动态注册表。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { deleteCustomProvider, listCustomProviders, saveCustomProvider } from "../api";
import { PROTOCOL_COLORS, refreshCustomProviders, uid } from "../models/registry";
import type { CustomModelConfig, CustomProviderConfig, ProtocolType } from "../types";
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

/** 常用参数具名字段：中文标签 → 协议接口字段名 的映射表。
 *  用户只填中文标签的输入框，接口字段名由这里决定，无需知道 API 细节。 */
interface ParamSpec {
  key: string;
  label: string; // i18n key：customProvider.field.<label>
  type: "number" | "text" | "select";
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
}

const PARAM_SPECS: Record<ProtocolType, ParamSpec[]> = {
  modelscope: [
    { key: "steps", label: "steps", type: "number", min: 1, max: 100 },
    { key: "guidance", label: "guidance", type: "number", min: 1, max: 20, step: 0.1 },
    { key: "seed", label: "seed", type: "number" },
    { key: "negative_prompt", label: "negativePrompt", type: "text" },
  ],
  huggingface: [
    { key: "num_inference_steps", label: "steps", type: "number", min: 1, max: 100 },
    { key: "guidance_scale", label: "guidance", type: "number", min: 1, max: 20, step: 0.1 },
    { key: "seed", label: "seed", type: "number" },
    { key: "negative_prompt", label: "negativePrompt", type: "text" },
  ],
  "openai-compatible": [
    { key: "quality", label: "quality", type: "select", options: [{ value: "standard", label: "standard" }, { value: "hd", label: "hd" }] },
    { key: "style", label: "style", type: "text" },
  ],
};

interface KvRow {
  id: number;
  key: string;
  value: string;
}

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
  const [labeledDraft, setLabeledDraft] = useState<Record<string, string>>({});
  const [kvDraft, setKvDraft] = useState<KvRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const kvSeq = useRef(0);

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

  // 进入模型编辑时，从已有 params 装载具名/高级两套草稿
  useEffect(() => {
    if (modelIdx == null) return;
    const m = form.models[modelIdx];
    if (!m) return;
    const specKeys = new Set(PARAM_SPECS[form.protocol].map((s) => s.key));
    const labeled: Record<string, string> = {};
    const kv: KvRow[] = [];
    for (const [k, v] of Object.entries(m.params)) {
      const s = v == null ? "" : String(v);
      if (specKeys.has(k)) labeled[k] = s;
      else kv.push({ id: ++kvSeq.current, key: k, value: s });
    }
    setLabeledDraft(labeled);
    setKvDraft(kv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelIdx]);

  const setLabeled = (key: string, value: string) =>
    setLabeledDraft((d) => ({ ...d, [key]: value }));

  const updateKv = (next: KvRow[]) => setKvDraft(next);

  const confirmModel = () => {
    if (modelIdx == null) return;
    const m = form.models[modelIdx];
    if (!m || !m.repo_id.trim() || !m.name.trim()) return;
    // 具名字段（数字留空/非法则不写入）
    const params: Record<string, string | number | null> = {};
    for (const spec of PARAM_SPECS[form.protocol]) {
      const v = labeledDraft[spec.key]?.trim();
      if (!v) continue;
      if (spec.type === "number") {
        const n = Number(v);
        if (Number.isFinite(n)) params[spec.key] = n;
      } else {
        params[spec.key] = v;
      }
    }
    // 高级键值对（键和值都非空才写入）
    for (const r of kvDraft) {
      const k = r.key.trim();
      const v = r.value.trim();
      if (!k || !v) continue;
      params[k] = Number.isFinite(Number(v)) ? Number(v) : v;
    }
    patchModel(modelIdx, { params });
    setModelIdx(null);
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
  const modelFormValid =
    modelForm != null && !!modelForm.repo_id.trim() && !!modelForm.name.trim();
  const specs = PARAM_SPECS[form.protocol];

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

              <label className={cmField}>
                <span className={cmFieldLabel}>{t("customProvider.sizePresets")}</span>
                <input className={cmInput} value={modelForm.size_presets.join(", ")} onChange={(e) => patchModel(modelIdx!, { size_presets: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} placeholder={t("customProvider.sizePh")} />
              </label>

              {/* 常用参数：中文标签具名表单（标签→接口字段名由 PARAM_SPECS 映射） */}
              <div className={cmField}>
                <span className={cmFieldLabel}>{t("customProvider.params")}</span>
                <div className="flex flex-col gap-2">
                  {specs.map((spec) => (
                    <label className="flex items-center gap-2.5" key={spec.key}>
                      <span className="shrink-0 flex-[0_0_96px] text-[11px] font-semibold text-text-3">{t(`customProvider.field.${spec.label}`)}</span>
                      {spec.type === "select" ? (
                        <select
                          className={cmSelect}
                          value={labeledDraft[spec.key] ?? ""}
                          onChange={(e) => setLabeled(spec.key, e.target.value)}
                        >
                          <option value="">{t("customProvider.fieldNone")}</option>
                          {spec.options?.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className={cmSelect}
                          type={spec.type === "number" ? "number" : "text"}
                          min={spec.min}
                          max={spec.max}
                          step={spec.step}
                          value={labeledDraft[spec.key] ?? ""}
                          placeholder={spec.type === "number" ? "30" : ""}
                          onChange={(e) => setLabeled(spec.key, e.target.value)}
                        />
                      )}
                    </label>
                  ))}
                </div>
              </div>

              {/* 高级参数：自由键值对（熟悉接口的用户补充字段） */}
              <div className={cmField}>
                <span className={cmFieldLabel}>{t("customProvider.advanced")}</span>
                <p className="m-0 mb-1.5 text-[10px] text-muted-foreground">{t("customProvider.advancedHint")}</p>
                <div className="flex flex-col gap-1.5">
                  {kvDraft.map((row) => (
                    <div className="flex gap-1.5" key={row.id}>
                      <input
                        className={cn(cmInput, "font-mono flex-[0_0_45%] px-2.5 py-1.5 text-[11px]")}
                        value={row.key}
                        placeholder={t("customProvider.kvKeyPh")}
                        onChange={(e) =>
                          updateKv(kvDraft.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))
                        }
                      />
                      <input
                        className={cn(cmInput, "font-mono flex-1 px-2.5 py-1.5 text-[11px]")}
                        value={row.value}
                        placeholder={t("customProvider.kvValPh")}
                        onChange={(e) =>
                          updateKv(kvDraft.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))
                        }
                      />
                      <button
                        type="button"
                        className="grid size-[26px] shrink-0 cursor-pointer place-items-center rounded-md border border-border-2 bg-chip text-[13px] leading-none text-muted-foreground transition-all duration-150 hover:border-[rgba(239,68,68,.40)] hover:text-destructive"
                        title={t("customProvider.kvDel")}
                        onClick={() => updateKv(kvDraft.filter((r) => r.id !== row.id))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="self-start cursor-pointer rounded-md border border-dashed border-border-3 bg-transparent px-3 py-1.5 text-[11px] font-semibold text-muted-foreground transition-all duration-150 hover:border-[rgba(59,130,246,.40)] hover:text-primary"
                    onClick={() =>
                      updateKv([...kvDraft, { id: ++kvSeq.current, key: "", value: "" }])
                    }
                  >
                    ＋ {t("customProvider.addParam")}
                  </button>
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
