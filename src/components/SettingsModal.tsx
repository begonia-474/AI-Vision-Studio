// 应用偏好 Modal
// 默认模型 / 并发 / 主题 / 语言 / 资产路径 / 历史保留 / 关于。
// 主题与语言已持久化到 localStorage；其余为只读展示（后端尚未持久化偏好）。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useTheme, type ThemeMode } from "../theme";
import { switchLanguage, type Lang } from "../i18n";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { cn } from "../lib/utils";
import { BTN, MDESC, MODAL, SEG, SEG_BTN } from "../lib/classes";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  defaultImage: string;
  defaultVideo: string;
}

const CONCURRENCY = [2, 4, 6, 8];
const THEMES: ThemeMode[] = ["dark", "light", "system"];
const LANGS: Lang[] = ["zh-CN", "en-US"];

export function SettingsModal({ open, onClose, defaultImage, defaultVideo }: SettingsModalProps) {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [conc, setConc] = useState(4);

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
          <div className="font-mono text-xs text-text-2">{defaultImage}</div>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-border-2 py-3.5 [&:last-of-type]:border-b-0">
          <div>
            <div className="text-[13px] font-semibold">{t("settings.defaultVideo")}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t("settings.defaultVideoDesc")}</div>
          </div>
          <div className="font-mono text-xs text-text-2">{defaultVideo}</div>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-border-2 py-3.5 [&:last-of-type]:border-b-0">
          <div>
            <div className="text-[13px] font-semibold">{t("settings.concurrency")}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t("settings.concurrencyDesc")}</div>
          </div>
          <div className={SEG}>
            <ToggleGroup
              type="single"
              variant="outline"
              value={String(conc)}
              onValueChange={(v) => v && setConc(Number(v))}
            >
              {CONCURRENCY.map((n) => (
                <ToggleGroupItem key={n} value={String(n)} className={SEG_BTN}>
                  {n}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
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
          <div className="font-mono text-xs text-text-2">%LOCALAPPDATA%\assets\YYYY\MM\</div>
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
