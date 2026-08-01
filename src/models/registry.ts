// 模型注册表（前端侧）—— 数据源 docs/model-registry.md
// 与后端 provider_id 对齐：volcark / kling / wanxiang / minimax 内置；
// custom:<uuid> 为自定义厂商（JSON 配置，协议：modelscope / huggingface / openai-compatible）。
// ModelDropdown 与参数 popover 均读此表动态渲染。

import { useEffect, useReducer } from "react";
import { listCustomProviders } from "../api";
import type {
  CustomModelConfig,
  CustomProviderConfig,
  ProtocolType,
} from "../types";

export type Studio = "image" | "video";
export type Capability = "t2i" | "i2i" | "t2v" | "i2v" | "r2v";

export interface ProviderMeta {
  id: string;
  name: string;
  abbr: string;
  color: string;
  wired: boolean; // 后端是否已接入（仅 wired=true 可真实生成）
  capabilities: Capability[];
  authHelp: string;
  i18nName?: boolean; // name 是否为 i18n key（内置 true；自定义厂商 false，name 即显示名）
}

export interface ModelDef {
  id: string;
  name: string;
  providerId: string;
  studio: Studio;
  capabilities: Capability[];
  aspectRatios: string[];
  qualities: string[]; // 图像画质 / 视频分辨率
  durations?: string[]; // 仅视频
  maxRef?: number; // 参考图上限
  blurb: string; // 模型一句话描述
  custom?: CustomModelConfig; // 自定义厂商模型配置，供生成时透传参数
}

// ============ 厂商元信息 ============
// 内置厂商 name / authHelp 为 i18n key（src/i18n/locales），渲染处需经 t() 转换；
// 自定义厂商为明文显示名（i18nName=false），由动态注册表提供。
export const PROVIDERS: Record<string, ProviderMeta> = {
  volcark: {
    id: "volcark", name: "providers.volcark.name", abbr: "BD", color: "#a855f7", wired: true,
    capabilities: ["t2i", "i2i", "t2v", "i2v"],
    authHelp: "providers.volcark.authHelp",
    i18nName: true,
  },
  kling: {
    id: "kling", name: "providers.kling.name", abbr: "KL", color: "#f43f5e", wired: true,
    capabilities: ["t2v", "i2v"],
    authHelp: "providers.kling.authHelp",
    i18nName: true,
  },
  wanxiang: {
    id: "wanxiang", name: "providers.wanxiang.name", abbr: "AL", color: "#0ea5e9", wired: true,
    capabilities: ["t2i", "i2i", "t2v", "i2v"],
    authHelp: "providers.wanxiang.authHelp",
    i18nName: true,
  },
  minimax: {
    id: "minimax", name: "providers.minimax.name", abbr: "MX", color: "#ec4899", wired: true,
    capabilities: ["t2i", "i2i", "t2v", "i2v"],
    authHelp: "providers.minimax.authHelp",
    i18nName: true,
  },
};

export const PROVIDER_LIST = Object.values(PROVIDERS);

// ============ 图像模型 ============
export const IMAGE_MODELS: ModelDef[] = [
  { id: "doubao-seedream-5-0-pro-260628", name: "Seedream 5.0 Pro", providerId: "volcark", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: ["1:1","3:4","4:3","16:9","9:16"], qualities: ["1K","2K"], maxRef: 10, blurb: "写实电影感，超高细节" },
  { id: "doubao-seedream-5-0-260128", name: "Seedream 5.0 Lite", providerId: "volcark", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: ["1:1","3:4","4:3","16:9","9:16"], qualities: ["2K","3K","4K"], maxRef: 14, blurb: "组图/流式/联网，性价比" },
  { id: "doubao-seedream-4-5-251128", name: "Seedream 4.5", providerId: "volcark", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: ["1:1","3:4","4:3","16:9","9:16"], qualities: ["2K","4K"], maxRef: 14, blurb: "多图参考，组图/流式" },
  { id: "doubao-seedream-4-0-250828", name: "Seedream 4.0", providerId: "volcark", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: ["1:1","3:4","4:3","16:9","9:16"], qualities: ["1K","2K","4K"], maxRef: 14, blurb: "稳定通用，legacy" },
  { id: "wan2.6-t2i", name: "wan2.6-t2i", providerId: "wanxiang", studio: "image", capabilities: ["t2i"], aspectRatios: ["1:1","3:4","4:3","16:9","9:16"], qualities: ["1K","2K"], blurb: "国风水墨，意境留白" },
  { id: "wan2.6-image", name: "wan2.6-image", providerId: "wanxiang", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: ["1:1","3:4","4:3","16:9","9:16"], qualities: ["1K","2K"], maxRef: 1, blurb: "图像编辑，单图参考" },
  { id: "image-01", name: "image-01", providerId: "minimax", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: ["1:1","3:4","4:3","16:9","9:16"], qualities: ["1K","2K"], maxRef: 1, blurb: "机甲赛博，octane 质感" },
  { id: "image-01-live", name: "image-01-live", providerId: "minimax", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: ["1:1","3:4","4:3","16:9","9:16"], qualities: ["1K"], maxRef: 1, blurb: "星云超现实，梦幻氛围" },
];

// ============ 视频模型 ============
export const VIDEO_MODELS: ModelDef[] = [
  { id: "doubao-seedance-2-0-260128", name: "Seedance 2.0", providerId: "volcark", studio: "video", capabilities: ["t2v", "i2v"], aspectRatios: ["16:9","9:16","1:1","4:3","3:4","21:9"], qualities: ["480P","720P","1080P","4K"], durations: ["5","10"], maxRef: 2, blurb: "多模态参考/有声/4k，编辑延长" },
  { id: "doubao-seedance-2-0-fast-260128", name: "Seedance 2.0 Fast", providerId: "volcark", studio: "video", capabilities: ["t2v", "i2v"], aspectRatios: ["16:9","9:16","1:1","4:3","3:4","21:9"], qualities: ["480P","720P"], durations: ["5","10"], maxRef: 2, blurb: "2.0 快速档，480p/720p" },
  { id: "doubao-seedance-2-0-mini-260615", name: "Seedance 2.0 Mini", providerId: "volcark", studio: "video", capabilities: ["t2v", "i2v"], aspectRatios: ["16:9","9:16","1:1","4:3","3:4","21:9"], qualities: ["480P","720P"], durations: ["5","10"], maxRef: 2, blurb: "2.0 轻量档，480p/720p" },
  { id: "doubao-seedance-1-5-pro-251215", name: "Seedance 1.5 Pro", providerId: "volcark", studio: "video", capabilities: ["t2v", "i2v"], aspectRatios: ["16:9","9:16","1:1"], qualities: ["480P","720P","1080P"], durations: ["5","10"], maxRef: 2, blurb: "有声视频，样片模式" },
  { id: "doubao-seedance-1-0-pro-250528", name: "Seedance 1.0 Pro", providerId: "volcark", studio: "video", capabilities: ["t2v", "i2v"], aspectRatios: ["16:9","9:16","1:1"], qualities: ["720P","1080P"], durations: ["3","5","10"], maxRef: 1, blurb: "城市航拍，云层流动" },
  { id: "doubao-seedance-1-0-pro-fast-251015", name: "Seedance 1.0 Pro Fast", providerId: "volcark", studio: "video", capabilities: ["t2v", "i2v"], aspectRatios: ["16:9","9:16","1:1"], qualities: ["720P","1080P"], durations: ["3","5","10"], maxRef: 1, blurb: "1.0 快速档，首帧生视频" },
  { id: "kling-v3", name: "Kling 3.0", providerId: "kling", studio: "video", capabilities: ["t2v", "i2v"], aspectRatios: ["16:9","9:16","1:1"], qualities: ["720P","1080P","4K"], durations: ["5","10"], maxRef: 1, blurb: "烟花绽放，电影运镜" },
  { id: "kling-v2-6", name: "Kling 2.6", providerId: "kling", studio: "video", capabilities: ["t2v", "i2v"], aspectRatios: ["16:9","9:16","1:1"], qualities: ["720P","1080P"], durations: ["5","10"], maxRef: 1, blurb: "毛发飘动，真实质感" },
  { id: "wan2.7-t2v", name: "wan2.7-t2v", providerId: "wanxiang", studio: "video", capabilities: ["t2v"], aspectRatios: ["16:9","9:16","1:1"], qualities: ["720P","1080P"], durations: ["5","10"], blurb: "森林晨雾，缓慢推移" },
  { id: "wan2.7-i2v", name: "wan2.7-i2v", providerId: "wanxiang", studio: "video", capabilities: ["i2v"], aspectRatios: ["16:9","9:16","1:1"], qualities: ["720P","1080P"], durations: ["5","10"], maxRef: 1, blurb: "首帧驱动，发丝飘动" },
  { id: "video-01", name: "Hailuo video-01", providerId: "minimax", studio: "video", capabilities: ["t2v", "i2v"], aspectRatios: ["16:9","9:16","1:1"], qualities: ["768P","1080P"], durations: ["6","10"], maxRef: 1, blurb: "雨中奔跑，慢动作" },
];

// ============ 辅助 ============

// —— 自定义厂商动态注册表 ——
// 配置存后端 SQLite（JSON），此处为前端内存镜像 + 变更订阅，
// 供两个 studio 的模型列表 / ModelDropdown / BYOK 响应式更新。
export const CUSTOM_PREFIX = "custom:";

export const PROTOCOL_COLORS: Record<ProtocolType, string> = {
  modelscope: "#4f46e5",
  huggingface: "#f59e0b",
  "openai-compatible": "#10b981",
};

let customProviders: CustomProviderConfig[] = [];
let customModels: ModelDef[] = [];
let customMeta: Record<string, ProviderMeta> = {};
const listeners = new Set<() => void>();

export function subscribeCustomProviders(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify() {
  listeners.forEach((fn) => fn());
}

/** 前端兜底 id 生成（crypto.randomUUID 在非安全上下文不可用，必须兜底）。 */
export function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** 从后端拉取自定义厂商并同步注册表（新增/删除后调用）。 */
export async function refreshCustomProviders(): Promise<CustomProviderConfig[]> {
  const rows = await listCustomProviders();
  const configs = rows
    .map((r) => {
      try {
        return JSON.parse(r.config_json) as CustomProviderConfig;
      } catch {
        return null;
      }
    })
    .filter((c): c is CustomProviderConfig => c !== null);
  setCustomProviders(configs);
  return configs;
}

export function setCustomProviders(configs: CustomProviderConfig[]) {
  customProviders = configs;
  customMeta = {};
  customModels = [];
  for (const p of configs) {
    const pid = `${CUSTOM_PREFIX}${p.id}`;
    const caps = Array.from(
      new Set(p.models.flatMap((m) => m.capabilities)),
    ) as Capability[];
    customMeta[pid] = {
      id: pid,
      name: p.name,
      abbr: p.name.slice(0, 2).toUpperCase(),
      color: PROTOCOL_COLORS[p.protocol] ?? "#64748b",
      wired: true,
      capabilities: caps,
      authHelp: p.base_url,
      i18nName: false,
    };
    customModels.push(...p.models.map((m) => toModelDef(p, m)));
  }
  notify();
}

export function getCustomProviders(): CustomProviderConfig[] {
  return customProviders;
}

export function getCustomProviderMeta(): Record<string, ProviderMeta> {
  return customMeta;
}

/** 订阅自定义厂商变更；列表变化时触发重渲染。 */
export function useCustomProviders(): CustomProviderConfig[] {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeCustomProviders(force), []);
  return customProviders;
}

/** 内置 + 自定义厂商元信息统一查找。 */
export function providerMeta(pid: string): ProviderMeta {
  return (
    PROVIDERS[pid] ??
    customMeta[pid] ?? {
      id: pid,
      name: pid,
      abbr: pid.slice(0, 2).toUpperCase(),
      color: "#64748b",
      wired: true,
      capabilities: [],
      authHelp: "",
      i18nName: false,
    }
  );
}

/** 厂商显示名（内置为 i18n key，自定义为明文）。 */
export function providerDisplayName(pid: string, t: (k: string) => string): string {
  const p = providerMeta(pid);
  return p.i18nName ? t(p.name) : p.name;
}

export function toModelDef(p: CustomProviderConfig, m: CustomModelConfig): ModelDef {
  const caps = m.capabilities.filter((x): x is Capability =>
    x === "t2i" || x === "i2i" || x === "t2v" || x === "i2v",
  );
  const isVid = caps.includes("t2v") || caps.includes("i2v");
  return {
    id: m.repo_id,
    name: m.name || m.repo_id,
    providerId: `${CUSTOM_PREFIX}${p.id}`,
    studio: isVid ? "video" : "image",
    capabilities: caps,
    aspectRatios: m.size_presets.length > 0 ? m.size_presets : ["1024x1024"],
    qualities: ["默认"],
    durations: isVid ? ["5", "10"] : undefined,
    maxRef: caps.includes("i2v") || caps.includes("i2i") ? 1 : 0,
    blurb: `${p.name} · ${m.repo_id}`,
    custom: m,
  };
}

export function modelsForStudio(studio: Studio, custom: ModelDef[] = customModels): ModelDef[] {
  const builtin = studio === "image" ? IMAGE_MODELS : VIDEO_MODELS;
  const caps = studio === "image" ? ["t2i", "i2i"] : ["t2v", "i2v"];
  const extra = custom.filter((m) => m.capabilities.some((c) => caps.includes(c)));
  return [...builtin, ...extra];
}

export function getModel(studio: Studio, id: string): ModelDef | undefined {
  return modelsForStudio(studio).find((m) => m.id === id);
}

/** 比例 → 原厂 size 串。volcark(Seedream) 用像素 `宽x高`（2K 档），由适配器 image[] 直传；
 *  其余厂商不读 size 字段，改用 GenRequest.aspect_ratio，此处回退为比例原值占位。 */
export function aspectToSize(providerId: string, ar: string): string {
  if (providerId === "volcark") {
    const map: Record<string, string> = {
      "1:1": "2048x2048", "3:4": "1536x2048", "4:3": "2048x1536",
      "16:9": "2048x1152", "9:16": "1152x2048",
    };
    return map[ar] ?? "2048x2048";
  }
  return ar;
}
