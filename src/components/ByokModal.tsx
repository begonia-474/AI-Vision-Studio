// BYOK 厂商 Key 管理 Modal
// 四厂卡片：名称 + 状态徽标 + 能力标签 + 帮助文本 + Key 输入 + 保存/测试。
// Key 经 keyring（Windows Credential Manager / DPAPI）加密存储；测试调用各厂商 test_connectivity。
// 数据源 registry.ts PROVIDER_LIST；后端命令 list_providers 给出能力清单。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { deleteApiKey, getApiKey, saveApiKey, testApiKey } from "../api";
import { PROVIDER_LIST } from "../models/registry";

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
      const next: Record<string, CardState> = {};
      for (const p of PROVIDER_LIST) {
        try {
          const k = await getApiKey(p.id);
          next[p.id] = { value: "", status: k ? "set" : "unset" };
        } catch {
          next[p.id] = { value: "", status: "unset" };
        }
      }
      if (active) setCards(next);
    })();
    return () => {
      active = false;
    };
  }, [open]);

  if (!open) return null;

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
        return <span className="badge ok">{t("byok.badgeSet")}</span>;
      case "testing":
        return <span className="badge">{t("byok.badgeTesting")}</span>;
      case "ok":
        return <span className="badge ok">{t("byok.badgeOk")}</span>;
      case "fail":
        return <span className="badge warn">{t("byok.badgeFail")}</span>;
      default:
        return <span className="badge warn">{t("byok.badgeUnset")}</span>;
    }
  };

  return (
    <div className="modal-mask show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>{t("byok.title")}</h2>
        <p className="mdesc">{t("byok.desc")}</p>

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
            <div className="prov-card" key={p.id}>
              <div className="pch">
                <span
                  className="provider-logo"
                  style={{ background: p.color, width: 24, height: 24, borderRadius: 6, display: "grid", placeItems: "center", fontSize: 10 }}
                >
                  {p.abbr}
                </span>
                <h3>{t(p.name)}</h3>
                {badge(c.status)}
                <span className="tag">{caps.join(" · ")}</span>
                {!p.wired && <span className="badge warn">{t("common.notWired")}</span>}
              </div>
              <div className="phelp">{t(p.authHelp)}</div>
              <div className="keyrow">
                <input
                  type="password"
                  placeholder={`${p.id.toUpperCase()}_API_KEY`}
                  value={c.value}
                  onChange={(e) => patch(p.id, { value: e.target.value })}
                />
                <button className="btn" onClick={() => handleSave(p.id)}>
                  {t("common.save")}
                </button>
                <button className="btn" onClick={() => handleTest(p.id)}>
                  {t("common.test")}
                </button>
                {c.status === "set" || c.status === "ok" ? (
                  <button className="btn" onClick={() => handleClear(p.id)}>
                    {t("common.clear")}
                  </button>
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
          <button className="btn" style={{ flex: 1 }} onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
