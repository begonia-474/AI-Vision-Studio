// BYOK 厂商 Key 管理 Modal
// 内置厂商卡片（volcark/wanxiang/kling/minimax/modelscope），同一 keyring 命名空间。
// Key 经 keyring（Windows Credential Manager / DPAPI）加密存储；测试调用各厂商 test_connectivity。

import { useEffect, useState } from "react";
import type { ParseKeys } from "i18next";
import { useTranslation } from "react-i18next";
import { deleteApiKey, getApiKey, getWorkspaceId, saveApiKey, saveWorkspaceId, testApiKey } from "../api";
import { PROVIDER_LIST } from "../models/registry";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";
import { BADGE, BADGE_OK, BADGE_WARN, BTN, MDESC, MODAL, PROVIDER_LOGO, TAG } from "../lib/classes";

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
  // WorkspaceId（仅 wanxiang）：回显明文（非机密），随弹窗打开加载
  const [ws, setWs] = useState("");
  const [wsMsg, setWsMsg] = useState<string | null>(null);

  // 打开时拉取各厂商已存 Key（仅判断是否已设置，不回显明文以减少暴露面）
  useEffect(() => {
    if (!open) return;
    let active = true;
    (async () => {
      const ids = PROVIDER_LIST.map((p) => p.id);
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
    getWorkspaceId("wanxiang")
      .then((v) => active && setWs(v ?? ""))
      .catch(() => active && setWs(""));
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

  const handleSaveWs = async () => {
    try {
      await saveWorkspaceId("wanxiang", ws.trim());
      setWsMsg(t("common.saved"));
      window.setTimeout(() => setWsMsg(null), 2000);
    } catch (e) {
      setWsMsg(String(e));
    }
  };

  const badge = (s: Status) => {
    switch (s) {
      case "set":
        return <Badge className={cn(BADGE, BADGE_OK)}>{t("byok.badgeSet")}</Badge>;
      case "testing":
        return <Badge className={BADGE}>{t("byok.badgeTesting")}</Badge>;
      case "ok":
        return <Badge className={cn(BADGE, BADGE_OK)}>{t("byok.badgeOk")}</Badge>;
      case "fail":
        return <Badge className={cn(BADGE, BADGE_WARN)}>{t("byok.badgeFail")}</Badge>;
      default:
        return <Badge className={cn(BADGE, BADGE_WARN)}>{t("byok.badgeUnset")}</Badge>;
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={MODAL} showCloseButton={false}>
        <DialogTitle>{t("byok.title")}</DialogTitle>
        <DialogDescription className={MDESC}>{t("byok.desc")}</DialogDescription>

        {PROVIDER_LIST.map((p) => {
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
            <div className="mb-3 rounded-md border border-border-2 bg-chip p-4" key={p.id}>
              <div className="mb-1 flex flex-wrap items-center gap-2.5">
                <span
                  className={cn(PROVIDER_LOGO, "text-[10px]")}
                  style={{ background: p.color, width: 24, height: 24, borderRadius: 6, display: "grid", placeItems: "center", fontSize: 10 }}
                >
                  {p.abbr}
                </span>
                <h3 className="m-0 flex-1 text-sm font-bold">{p.i18nName ? t(p.name as ParseKeys) : p.name}</h3>
                {badge(c.status)}
                <Badge variant="outline" className={TAG}>{caps.join(" · ")}</Badge>
                {!p.wired && <Badge variant="outline" className={cn(BADGE, BADGE_WARN)}>{t("common.notWired")}</Badge>}
              </div>
              <div className="my-1 mb-3 text-[11px] leading-relaxed text-muted-foreground">{p.i18nName ? t(p.authHelp as ParseKeys) : p.authHelp}</div>
              <div className="flex gap-2">
                <Input
                  type="password"
                  className="flex-1 border-border-2 bg-soft text-[13px] focus:border-[rgba(59,130,246,.50)]"
                  placeholder={`${p.id.toUpperCase()}_API_KEY`}
                  value={c.value}
                  onChange={(e) => patch(p.id, { value: e.target.value })}
                />
                <Button className={BTN} onClick={() => handleSave(p.id)}>
                  {t("common.save")}
                </Button>
                <Button className={BTN} onClick={() => handleTest(p.id)}>
                  {t("common.test")}
                </Button>
                {c.status === "set" || c.status === "ok" ? (
                  <Button className={BTN} onClick={() => handleClear(p.id)}>
                    {t("common.clear")}
                  </Button>
                ) : null}
              </div>
              {c.message && (
                <div className="mt-2 text-[11px] leading-relaxed" style={{ color: c.status === "fail" ? "var(--danger)" : "var(--success)" }}>
                  {c.message}
                </div>
              )}
              {p.id === "wanxiang" && (
                <div className="mt-2.5 border-t border-border-2 pt-2.5">
                  <div className="mb-1 text-[10px] font-semibold text-text-3">{t("byok.workspaceId")}</div>
                  <div className="flex gap-2">
                    <Input
                      className="flex-1 border-border-2 bg-soft font-mono text-[13px] focus:border-[rgba(59,130,246,.50)]"
                      placeholder={t("byok.workspacePh")}
                      value={ws}
                      onChange={(e) => setWs(e.target.value)}
                    />
                    <Button className={BTN} onClick={handleSaveWs}>
                      {t("common.save")}
                    </Button>
                  </div>
                  <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{t("byok.workspaceHint")}</div>
                  {wsMsg && (
                    <div className="mt-1 text-[11px] font-semibold text-success">{wsMsg}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}

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
