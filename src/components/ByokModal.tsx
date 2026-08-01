// BYOK 厂商 Key 管理 Modal
// 内置四厂卡片 + 自定义厂商（魔搭/HF/OpenAI 兼容）卡片，同一 keyring 命名空间。
// Key 经 keyring（Windows Credential Manager / DPAPI）加密存储；测试调用各厂商 test_connectivity。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { deleteApiKey, getApiKey, saveApiKey, testApiKey } from "../api";
import {
  getCustomProviderMeta,
  PROVIDER_LIST,
} from "../models/registry";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface ByokModalProps {
  open: boolean;
  onClose: () => void;
}

type Status = "unset" | "set" | "testing" | "ok" | "fail";

interface CardState {
  value: string; // 输入框值
  status: Status;
  message?: string;
}

export function ByokModal({ open, onClose }: ByokModalProps) {
  const { t } = useTranslation();
  const [cards, setCards] = useState<Record<string, CardState>>({});

  // 打开时拉取各厂商已存 Key（仅判断是否已设置，不回显明文以减少暴露面）
  useEffect(() => {
    if (!open) return;
    let active = true;
    (async () => {
      const ids = [...PROVIDER_LIST.map((p) => p.id), ...Object.keys(getCustomProviderMeta())];
      const next: Record<string, CardState> = {};
      for (const id of ids) {
        try {
          const k = await getApiKey(id);
          next[id] = { value: "", status: k ? "set" : "unset" };
        } catch {
          next[id] = { value: "", status: "unset" };
        }
      }
      if (active) setCards(next);
    })();
    return () => {
      active = false;
    };
  }, [open]);

  const patch = (id: string, delta: Partial<CardState>) =>
    setCards((prev) => ({ ...prev, [id]: { ...prev[id], ...delta } }));

  const handleSave = async (id: string) => {
    const v = cards[id]?.value?.trim();
    if (!v) return;
    try {
      await saveApiKey(id, v);
      patch(id, { value: "", status: "set", message: t("common.saved") });
    } catch (e) {
      patch(id, { status: "fail", message: String(e) });
    }
  };

  const handleTest = async (id: string) => {
    patch(id, { status: "testing", message: undefined });
    try {
      const msg = await testApiKey(id);
      patch(id, { status: "ok", message: msg });
    } catch (e) {
      patch(id, { status: "fail", message: String(e) });
    }
  };

  const handleClear = async (id: string) => {
    try {
      await deleteApiKey(id);
      patch(id, { value: "", status: "unset", message: undefined });
    } catch (e) {
      patch(id, { status: "fail", message: String(e) });
    }
  };

  const badge = (s: Status) => {
    switch (s) {
      case "set":
        return <Badge className="badge ok">{t("byok.badgeSet")}</Badge>;
      case "testing":
        return <Badge className="badge">{t("byok.badgeTesting")}</Badge>;
      case "ok":
        return <Badge className="badge ok">{t("byok.badgeOk")}</Badge>;
      case "fail":
        return <Badge className="badge warn">{t("byok.badgeFail")}</Badge>;
      default:
        return <Badge className="badge warn">{t("byok.badgeUnset")}</Badge>;
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="modal" showCloseButton={false}>
        <DialogTitle>{t("byok.title")}</DialogTitle>
        <DialogDescription className="mdesc">{t("byok.desc")}</DialogDescription>

        {[...PROVIDER_LIST, ...Object.values(getCustomProviderMeta())].map((p) => {
          const c = cards[p.id] ?? { value: "", status: "unset" as Status };
          const caps = p.capabilities
            .map((cap) =>
              cap.startsWith("t2") || cap.startsWith("i2")
                ? cap.endsWith("i")
                  ? t("byok.capImage")
                  : t("byok.capVideo")
                : cap,
            )
            .filter((v, i, a) => a.indexOf(v) === i);
          return (
            <div className="prov-card" key={p.id}>
              <div className="pch">
                <span
                  className="provider-logo"
                  style={{ background: p.color, width: 24, height: 24, borderRadius: 6, display: "grid", placeItems: "center", fontSize: 10 }}
                >
                  {p.abbr}
                </span>
                <h3>{p.i18nName ? t(p.name) : p.name}</h3>
                {badge(c.status)}
                <Badge variant="outline" className="tag">{caps.join(" · ")}</Badge>
                {!p.wired && <Badge variant="outline" className="badge warn">{t("common.notWired")}</Badge>}
              </div>
              <div className="phelp">{p.i18nName ? t(p.authHelp) : p.authHelp}</div>
              <div className="keyrow">
                <Input
                  type="password"
                  placeholder={`${p.id.toUpperCase()}_API_KEY`}
                  value={c.value}
                  onChange={(e) => patch(p.id, { value: e.target.value })}
                />
                <Button className="btn" onClick={() => handleSave(p.id)}>
                  {t("common.save")}
                </Button>
                <Button className="btn" onClick={() => handleTest(p.id)}>
                  {t("common.test")}
                </Button>
                {c.status === "set" || c.status === "ok" ? (
                  <Button className="btn" onClick={() => handleClear(p.id)}>
                    {t("common.clear")}
                  </Button>
                ) : null}
              </div>
              {c.message && (
                <div className="phelp" style={{ marginTop: 8, color: c.status === "fail" ? "var(--danger)" : "var(--success)" }}>
                  {c.message}
                </div>
              )}
            </div>
          );
        })}

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
