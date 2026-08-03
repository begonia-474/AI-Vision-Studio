// 模型注册表（前端侧）—— 本文件为内置模型的单一数据源
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

// ============ 参数弹层分区声明 ============
// 哩布风格：弹层内容按模型声明式渲染，不同模型呈现不同分区。
// title 为 i18n key；options 缺省时按 key 取模型字段（quality→qualities，batch→1..min(maxRef,4)）。
// 生图模式（mode）：单图=1 张（API 无 n 参数），组图=sequential auto + max_images（张数区）。
export type ParamKey = "ar" | "quality" | "duration" | "batch" | "mode";

export type ParamSectionDef =
  | {
      type: "segmented";
      key: "quality" | "batch" | "mode";
      title: string;
      options?: string[]; // 缺省 quality→model.qualities，batch→1..min(maxRef,4)，mode→[single,group]
      /** 选项为 i18n key，渲染时经 t() 转换（如生图模式的单图/组图） */
      i18n?: boolean;
    }
  | {
      type: "ratio";
      key: "ar";
      title: string;
      options?: string[]; // 缺省取 model.aspectRatios
      /** 比例网格下方附加 W/H 自定义尺寸输入 + 锁定（仅 pixel-size 厂商，如 volcark） */
      size?: boolean;
    }
  | { type: "size"; key: "size"; title: string } // 独立 W/H 自定义尺寸分区（自定义厂商提交 size="WxH"）
  | {
      type: "param";
      key: string; // 接口字段名（自定义厂商自由参数，运行时调整）
      title: string; // 分区标题（直接显示，非 i18n key）
      kind: "number" | "text";
      def?: string;
    }
  | { type: "duration"; key: "duration"; title: string }; // 刻度 slider（durations 数组索引）+ 数值输入联动

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
  /** 参数弹层分区声明；缺省时按 studio/厂商推导（defaultSections） */
  sections?: ParamSectionDef[];
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
// volcark(Seedream) 走像素尺寸（size 字段），声明 size 区；其余厂商只走 aspect_ratio，
// sections 缺省时由 defaultSections 按 studio 推导。
// 生图模式（mode）：5.0 pro 仅单图（官方不支持组图），无 mode/张数区；
// lite/4.5/4.0 支持组图：mode 开关（单图/组图）+ 张数区（组图张数，max_images）。
// 比例 9 个对齐哩布（含 2:3/3:2/9:21/21:9，官方像素表均有档位值）。
const SEEDREAM_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "9:21", "21:9"];
const seedreamSectionsPro: ParamSectionDef[] = [
  { type: "segmented", key: "quality", title: "prompt.resolution" },
  { type: "ratio", key: "ar", title: "prompt.imageSize", size: true },
  { type: "segmented", key: "batch", title: "prompt.imageCount" },
];
const seedreamSectionsMulti: ParamSectionDef[] = [
  { type: "segmented", key: "mode", title: "prompt.imageMode", options: ["single", "group"], i18n: true },
  { type: "segmented", key: "quality", title: "prompt.resolution" },
  { type: "ratio", key: "ar", title: "prompt.imageSize", size: true },
  { type: "segmented", key: "batch", title: "prompt.imageCount" },
];

export const IMAGE_MODELS: ModelDef[] = [
  { id: "doubao-seedream-5-0-pro-260628", name: "Seedream 5.0 Pro", providerId: "volcark", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: SEEDREAM_RATIOS, qualities: ["1K","2K"], maxRef: 10, blurb: "写实电影感，超高细节", sections: seedreamSectionsPro },
  { id: "doubao-seedream-5-0-260128", name: "Seedream 5.0 Lite", providerId: "volcark", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: SEEDREAM_RATIOS, qualities: ["2K","3K","4K"], maxRef: 14, blurb: "组图/流式/联网，性价比", sections: seedreamSectionsMulti },
  { id: "doubao-seedream-4-5-251128", name: "Seedream 4.5", providerId: "volcark", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: SEEDREAM_RATIOS, qualities: ["2K","4K"], maxRef: 14, blurb: "多图参考，组图/流式", sections: seedreamSectionsMulti },
  { id: "doubao-seedream-4-0-250828", name: "Seedream 4.0", providerId: "volcark", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: SEEDREAM_RATIOS, qualities: ["1K","2K","4K"], maxRef: 14, blurb: "稳定通用，legacy", sections: seedreamSectionsMulti },
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

/** sections 缺省推导：视频 → 比例+质量+时长；图像 → 比例+质量（maxRef>1 再附张数）。 */
export function defaultSections(m: ModelDef): ParamSectionDef[] {
  if (m.studio === "video") {
    return [
      { type: "ratio", key: "ar", title: "prompt.videoRatio" },
      { type: "segmented", key: "quality", title: "prompt.videoQuality" },
      { type: "duration", key: "duration", title: "prompt.videoDuration" },
    ];
  }
  const s: ParamSectionDef[] = [
    { type: "ratio", key: "ar", title: "prompt.aspectRatio" },
    { type: "segmented", key: "quality", title: "prompt.resolution" },
  ];
  if ((m.maxRef ?? 4) > 1) s.push({ type: "segmented", key: "batch", title: "prompt.imageCount" });
  return s;
}

/** "2048x2048" → { w, h }（解析失败回退 2K 方形）。 */
export function parseSizePx(size: string): { w: number; h: number } {
  const m = /^(\d+)x(\d+)$/.exec(size);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 2048, h: 2048 };
}

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

  // 参数模块 → 模型字段 + sections（popover 分区按用户勾选渲染）。
  // 无模块时 sections 缺省，由 defaultSections 按 studio 推导。
  let ar = m.size_presets.length > 0 ? m.size_presets : ["1024x1024"];
  let qualities = ["默认"];
  let durations = isVid ? ["5", "10"] : undefined;
  let sections: ParamSectionDef[] | undefined;
  if (m.param_modules && m.param_modules.length > 0) {
    const s: ParamSectionDef[] = [];
    for (const mod of m.param_modules) {
      if (mod.type === "ratio") {
        if (mod.options.length > 0) ar = mod.options;
        s.push({ type: "ratio", key: "ar", title: "prompt.aspectRatio", options: ar });
      } else if (mod.type === "quality") {
        if (mod.options.length > 0) qualities = mod.options;
        s.push({ type: "segmented", key: "quality", title: "prompt.resolution", options: qualities });
      } else if (mod.type === "duration") {
        if (mod.options.length > 0) durations = mod.options;
        s.push({ type: "duration", key: "duration", title: "prompt.videoDuration" });
      } else if (mod.type === "size") {
        s.push({ type: "size", key: "size", title: "prompt.customSize" });
      } else if (mod.type === "param") {
        s.push({ type: "param", key: mod.key, title: mod.label, kind: mod.kind, def: mod.def });
      } else {
        s.push({ type: "segmented", key: "batch", title: "prompt.imageCount" });
      }
    }
    sections = s;
  }

  return {
    id: m.repo_id,
    name: m.name || m.repo_id,
    providerId: `${CUSTOM_PREFIX}${p.id}`,
    studio: isVid ? "video" : "image",
    capabilities: caps,
    aspectRatios: ar,
    qualities,
    durations,
    maxRef: caps.includes("i2v") || caps.includes("i2i") ? 1 : 0,
    blurb: `${p.name} · ${m.repo_id}`,
    custom: m,
    sections,
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

/** 官方像素表（对照 docs/model-api 图片生成 API 文档方式1 映射表）。
 *  5.0 pro 独立（1K/2K）；lite/4.5/4.0 共用（1K/2K/3K/4K）。
 *  9:21 文档无直给值，取 21:9 转置（总像素合规，见 volcarkPixelBounds）。 */
const PRO_PX: Record<string, Record<string, string>> = {
  "1K": {
    "1:1": "1024x1024", "4:3": "1152x864", "3:4": "864x1152", "16:9": "1424x800", "9:16": "800x1424",
    "3:2": "1248x832", "2:3": "832x1248", "21:9": "1568x672", "9:21": "672x1568",
  },
  "2K": {
    "1:1": "2048x2048", "4:3": "2368x1776", "3:4": "1776x2368", "16:9": "2816x1584", "9:16": "1584x2816",
    "3:2": "2496x1664", "2:3": "1664x2496", "21:9": "3136x1344", "9:21": "1344x3136",
  },
};
const COMMON_PX: Record<string, Record<string, string>> = {
  "1K": {
    "1:1": "1024x1024", "4:3": "1152x864", "3:4": "864x1152", "16:9": "1280x720", "9:16": "720x1280",
    "3:2": "1248x832", "2:3": "832x1248", "21:9": "1512x648", "9:21": "648x1512",
  },
  "2K": {
    "1:1": "2048x2048", "4:3": "2304x1728", "3:4": "1728x2304", "16:9": "2848x1600", "9:16": "1600x2848",
    "3:2": "2496x1664", "2:3": "1664x2496", "21:9": "3136x1344", "9:21": "1344x3136",
  },
  "3K": {
    "1:1": "3072x3072", "4:3": "3456x2592", "3:4": "2592x3456", "16:9": "4096x2304", "9:16": "2304x4096",
    "3:2": "3744x2496", "2:3": "2496x3744", "21:9": "4704x2016", "9:21": "2016x4704",
  },
  "4K": {
    "1:1": "4096x4096", "4:3": "4704x3520", "3:4": "3520x4704", "16:9": "5504x3040", "9:16": "3040x5504",
    "3:2": "4992x3328", "2:3": "3328x4992", "21:9": "6240x2656", "9:21": "2656x6240",
  },
};

/** 比例 → 原厂 size 串（UI 展示与自定义尺寸回退基准，与后端 volcark.rs 官方像素表一致）。
 *  volcark(Seedream)：方式2 像素 `宽x高`，按 model+quality+ratio 查官方表（5.0 pro 与 lite/4.5/4.0 表不同）；
 *  其余厂商不读 size 字段，回退为比例原值占位。 */
export function aspectToSize(providerId: string, modelId: string, ar: string, quality?: string): string {
  if (providerId !== "volcark") return ar;
  const q = quality ?? "2K";
  const table = modelId.includes("5-0-pro") ? PRO_PX : COMMON_PX;
  return table[q]?.[ar] ?? table["2K"]?.[ar] ?? "2048x2048";
}

/** W/H 自定义尺寸总像素区间：
 *  自定义厂商通用 [512², 4096²]；volcark 官方区间：pro [921600, 4624220]，5.0 lite/4.5 [3686400, 16777216]，4.0 [921600, 16777216]。 */
export function volcarkPixelBounds(model: ModelDef): { min: number; max: number } {
  if (model.custom) return { min: 512 * 512, max: 4096 * 4096 };
  if (model.id.includes("5-0-pro")) return { min: 921600, max: 4624220 };
  if (model.id.includes("4-0")) return { min: 921600, max: 16777216 };
  return { min: 3686400, max: 16777216 }; // 5.0 lite / 4.5
}
