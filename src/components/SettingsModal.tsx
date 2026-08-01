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
      <DialogContent className="modal" showCloseButton={false}>
        <DialogTitle>{t("settings.title")}</DialogTitle>
        <DialogDescription className="mdesc">{t("settings.desc")}</DialogDescription>

        <div className="set-row">
          <div>
            <div className="sk">{t("settings.defaultImage")}</div>
            <div className="sd">{t("settings.defaultImageDesc")}</div>
          </div>
          <div className="sv">{defaultImage}</div>
        </div>
        <div className="set-row">
          <div>
            <div className="sk">{t("settings.defaultVideo")}</div>
            <div className="sd">{t("settings.defaultVideoDesc")}</div>
          </div>
          <div className="sv">{defaultVideo}</div>
        </div>
        <div className="set-row">
          <div>
            <div className="sk">{t("settings.concurrency")}</div>
            <div className="sd">{t("settings.concurrencyDesc")}</div>
          </div>
          <div className="seg">
            <ToggleGroup
              type="single"
              variant="outline"
              value={String(conc)}
              onValueChange={(v) => v && setConc(Number(v))}
            >
              {CONCURRENCY.map((n) => (
                <ToggleGroupItem key={n} value={String(n)}>
                  {n}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="sk">{t("settings.theme")}</div>
            <div className="sd">{t("settings.themeDesc")}</div>
          </div>
          <div className="seg">
            <ToggleGroup
              type="single"
              variant="outline"
              value={theme}
              onValueChange={(v) => v && setTheme(v as ThemeMode)}
            >
              {THEMES.map((m) => (
                <ToggleGroupItem key={m} value={m}>
                  {t(`common.${m}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="sk">{t("settings.language")}</div>
            <div className="sd">{t("settings.languageDesc")}</div>
          </div>
          <div className="seg">
            <ToggleGroup
              type="single"
              variant="outline"
              value={i18n.language}
              onValueChange={(l) => l && switchLanguage(l as Lang)}
            >
              {LANGS.map((l) => (
                <ToggleGroupItem key={l} value={l}>
                  {l === "zh-CN" ? t("lang.zh") : t("lang.en")}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="sk">{t("settings.assetsPath")}</div>
            <div className="sd">{t("settings.assetsPathDesc")}</div>
          </div>
          <div className="sv">%LOCALAPPDATA%\assets\YYYY\MM\</div>
        </div>
        <div className="set-row">
          <div>
            <div className="sk">{t("settings.history")}</div>
            <div className="sd">{t("settings.historyDesc")}</div>
          </div>
          <div className="sv">{t("settings.historyForever")}</div>
        </div>
        <div className="set-row">
          <div>
            <div className="sk">{t("settings.about")}</div>
            <div className="sd">{t("settings.aboutDesc")}</div>
          </div>
          <div className="sv">v0.1.0</div>
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <DialogClose asChild>
            <Button className="btn" style={{ flex: 1 }}>
              {t("common.close")}
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
