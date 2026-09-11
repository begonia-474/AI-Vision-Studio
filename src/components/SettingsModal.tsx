// 应用偏好 Modal
// 默认模型 / 主题 / 语言 / 资产路径 / 历史保留 / 关于。
// 默认模型、主题、语言均持久化到 localStorage；资产路径 / 历史保留为只读展示。

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTheme, type ThemeMode } from "../theme";
import { switchLanguage, type Lang } from "../i18n";
import { getAppDir } from "../api";
import {
  defaultModelForStudio,
  getUserDefaultModelId,
  modelsForStudio,
  setUserDefaultModelId,
  type Studio,
} from "../models/registry";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { cn } from "../lib/utils";
import { BTN, MDESC, MODAL, SEG, SEG_BTN } from "../lib/classes";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const THEMES: ThemeMode[] = ["dark", "light", "system"];
const LANGS: Lang[] = ["zh-CN", "en-US"];

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [appDir, setAppDir] = useState("");
  // 默认模型：初值 = 用户偏好（localStorage）优先，否则注册表默认；选择即持久化。
  const [defaultImage, setDefaultImage] = useState(
    () => getUserDefaultModelId("image") ?? defaultModelForStudio("image").id,
  );
  const [defaultVideo, setDefaultVideo] = useState(
    () => getUserDefaultModelId("video") ?? defaultModelForStudio("video").id,
  );
  const imageModels = useMemo(() => modelsForStudio("image"), []);
  const videoModels = useMemo(() => modelsForStudio("video"), []);

  const chooseDefault = (studio: Studio, id: string) => {
    setUserDefaultModelId(studio, id);
    if (studio === "image") setDefaultImage(id);
    else setDefaultVideo(id);
  };

  useEffect(() => {
    getAppDir().then(setAppDir).catch(() => setAppDir(""));
  }, []);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={MODAL} showCloseButton={false}>
        <DialogTitle>{t("settings.title")}</DialogTitle>
        <DialogDescription className={MDESC}>{t("settings.desc")}</DialogDescription>

        <div className="flex items-center justify-between gap-3 border-b border-border-2 py-3.5 [&:last-of-type]:border-b-0">
          <div>
            <div className="text-[13px] font-semibold">{t("settings.defaultImage")}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t("settings.defaultImageDesc")}</div>
          </div>
          <Select value={defaultImage} onValueChange={(v) => chooseDefault("image", v)}>
            <SelectTrigger className="h-9 w-[220px] max-w-[55%] border-border-2 bg-soft text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {imageModels.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-xs">
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-border-2 py-3.5 [&:last-of-type]:border-b-0">
          <div>
            <div className="text-[13px] font-semibold">{t("settings.defaultVideo")}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t("settings.defaultVideoDesc")}</div>
          </div>
          <Select value={defaultVideo} onValueChange={(v) => chooseDefault("video", v)}>
            <SelectTrigger className="h-9 w-[220px] max-w-[55%] border-border-2 bg-soft text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {videoModels.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-xs">
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-border-2 py-3.5 [&:last-of-type]:border-b-0">
          <div>
            <div className="text-[13px] font-semibold">{t("settings.theme")}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t("settings.themeDesc")}</div>
          </div>
          <div className={SEG}>
            <ToggleGroup
              type="single"
              variant="outline"
              value={theme}
              onValueChange={(v) => v && setTheme(v as ThemeMode)}
            >
              {THEMES.map((m) => (
                <ToggleGroupItem key={m} value={m} className={SEG_BTN}>
                  {t(`common.${m}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-border-2 py-3.5 [&:last-of-type]:border-b-0">
          <div>
            <div className="text-[13px] font-semibold">{t("settings.language")}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t("settings.languageDesc")}</div>
          </div>
          <div className={SEG}>
            <ToggleGroup
              type="single"
              variant="outline"
              value={i18n.language}
              onValueChange={(l) => l && switchLanguage(l as Lang)}
            >
              {LANGS.map((l) => (
                <ToggleGroupItem key={l} value={l} className={SEG_BTN}>
                  {l === "zh-CN" ? t("lang.zh") : t("lang.en")}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-border-2 py-3.5 [&:last-of-type]:border-b-0">
          <div>
            <div className="text-[13px] font-semibold">{t("settings.assetsPath")}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t("settings.assetsPathDesc")}</div>
          </div>
          <div className="max-w-[55%] break-all text-right font-mono text-xs leading-relaxed text-text-2">
            {appDir ? `${appDir}/outputs/YYYY/MM/` : "…"}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-border-2 py-3.5 [&:last-of-type]:border-b-0">
          <div>
            <div className="text-[13px] font-semibold">{t("settings.history")}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t("settings.historyDesc")}</div>
          </div>
          <div className="font-mono text-xs text-text-2">{t("settings.historyForever")}</div>
        </div>
        <div className="flex items-center justify-between gap-3 py-3.5">
          <div>
            <div className="text-[13px] font-semibold">{t("settings.about")}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t("settings.aboutDesc")}</div>
          </div>
          <div className="font-mono text-xs text-text-2">v0.1.0</div>
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <DialogClose asChild>
            <Button className={cn(BTN, "flex-1")}>
              {t("common.close")}
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
