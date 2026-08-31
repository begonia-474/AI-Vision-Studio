// 厂商 API Key 是否已设置（掩码存在即已设置）。
// 供空状态「配置 API Key」入口判断：未配置时展示引导按钮，配置后自动隐藏。
// rev 变化（如 BYOK 弹层关闭）时重新校验，无需全量状态订阅。

import { useEffect, useState } from "react";
import { getApiKey } from "../api";

export function useProviderKeyReady(providerId: string, rev: number): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    setReady(null);
    getApiKey(providerId)
      .then((k) => {
        if (alive) setReady(k != null && k.length > 0);
      })
      .catch(() => {
        if (alive) setReady(false);
      });
    return () => {
      alive = false;
    };
  }, [providerId, rev]);

  return ready;
}