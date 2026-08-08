// 用户自添加模型 Dialog（通用：任意内置厂商）
// 流程：选厂商 → 选基础模板（继承其尺寸机制/参数分区）→ 填模型 ID/名称 → 可选覆盖模板默认参数。
// 保存到 SQLite user_models，registry 动态注册表刷新后出现在模型列表。

import { useEffect, useMemo, useState } from "react";
import type { ParseKeys } from "i18next";
import { useTranslation } from "react-i18next";
import { saveUserModel } from "../api";
import { PROVIDER_LIST, modelsForStudio, refreshUserModels, type ModelDef, type ParamSectionDef, type Studio } from "../models/registry";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";
import { BTN, MDESC, MODAL } from "../lib/classes";

interface AddModelDialogProps {
  open: boolean;
  onClose: () => void;
  studio: Studio;
}

export function AddModelDialog({ open, onClose, studio }: AddModelDialogProps) {
  const { t } = useTranslation();
  const all = useMemo(() => modelsForStudio(studio), [studio]);

  const [providerId, setProviderId] = useState<string>(PROVIDER_LIST[0]?.id ?? "");
  const [templateId, setTemplateId] = useState<string>("");
  const [modelId, setModelId] = useState("");
  const [name, setName] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 该厂商的内置模型（作模板候选）
  const templates = useMemo(() => all.filter((m) => m.providerId === providerId), [all, providerId]);
  const template: ModelDef | undefined = templates.find((m) => m.id === templateId) ?? templates[0];

  // 模板的 param 分区（默认参数可覆盖项）
  const paramDefs = useMemo(
    () =>
      (template?.sections ?? []).filter(
        (s): s is Extract<ParamSectionDef, { type: "param" }> => s.type === "param",
      ),
    [template],
  );

  // 打开时重置表单并预选第一个厂商/模板
  useEffect(() => {
    if (!open) return;
    setProviderId(PROVIDER_LIST[0]?.id ?? "");
    setTemplateId("");
    setModelId("");
    setName("");
    setParams({});
    setError(null);
  }, [open]);

  // 模板变化时，参数区回填模板默认值
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const d of paramDefs) next[d.key] = d.def ?? "";
    setParams(next);
  }, [paramDefs]);

  const handleSave = async () => {
    const id = modelId.trim();
    if (!id) {
      setError(t("model.addModelIdRequired"));
      return;
    }
    if (!template) {
      setError(t("model.addModelTemplateRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const paramsJson = Object.keys(params).length > 0 ? JSON.stringify(params) : undefined;
      await saveUserModel({
        providerId,
        modelId: id,
        name: name.trim() || id,
        templateModelId: template.id,
        paramsJson,
      });
      await refreshUserModels();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={MODAL} showCloseButton={false}>
        <DialogTitle>{t("model.addModel")}</DialogTitle>
        <DialogDescription className={MDESC}>{t("model.addModelHint")}</DialogDescription>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-text-3">{t("model.addModelProvider")}</label>
            <div className="flex flex-wrap gap-1.5">
              {PROVIDER_LIST.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { setProviderId(p.id); setTemplateId(""); }}
                  className={cn(
                    "cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                    providerId === p.id
                      ? "border-[rgba(59,130,246,.50)] bg-[rgba(59,130,246,.10)] text-foreground"
                      : "border-border-2 bg-chip text-text-3 hover:bg-hover hover:text-foreground",
                  )}
                >
                  {p.i18nName ? t(p.name as ParseKeys) : p.name}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-text-3">{t("model.addModelTemplate")}</label>
            <select
              value={templateId || (template?.id ?? "")}
              onChange={(e) => setTemplateId(e.target.value)}
              className="h-9 cursor-pointer rounded-lg border border-border-2 bg-chip px-2.5 text-xs text-foreground outline-none"
            >
              {templates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.id}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-faint">{t("model.addModelTemplateHint")}</span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-text-3">{t("model.addModelId")}</label>
              <Input
                className="border-border-2 bg-soft text-xs"
                placeholder={t("model.addModelIdPh")}
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-text-3">{t("model.addModelName")}</label>
              <Input
                className="border-border-2 bg-soft text-xs"
                placeholder={t("model.addModelNamePh")}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>

          {paramDefs.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-border-2 bg-chip/60 p-3">
              <div className="text-[11px] font-semibold text-text-3">{t("model.addModelParams")}</div>
              <div className="grid grid-cols-2 gap-2">
                {paramDefs.map((d) => (
                  <div className="flex flex-col gap-1" key={d.key}>
                    <label className="truncate text-[10px] text-faint">{t(d.title as ParseKeys)}</label>
                    <Input
                      className="border-border-2 bg-soft text-xs"
                      type={d.kind === "number" ? "number" : "text"}
                      value={params[d.key] ?? ""}
                      onChange={(e) => setParams((p) => ({ ...p, [d.key]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <div className="text-[11px] leading-relaxed text-destructive">{error}</div>}

          <div className="flex gap-2 pt-1">
            <Button className={cn(BTN, "flex-1")} disabled={saving} onClick={handleSave}>
              {t("common.save")}
            </Button>
            <DialogClose asChild>
              <Button className={cn(BTN, "flex-1")}>{t("common.cancel")}</Button>
            </DialogClose>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
