// 模型注册表（前端侧）。
// 领域数据（内置模型能力/尺寸/官方像素表/像素区间）的唯一事实源已下沉到 Rust
// （src-tauri/src/registry.rs）：启动时经 `list_builtin_models` 一次性拉取缓存，
// 前端只保留渲染期同步的薄函数（查表/滑杆上限）与 UI 元信息（logo/品牌色/i18n 文案）。
// 用户自添加模型：以任意内置模型为模板（继承其尺寸机制/参数分区/默认参数），
// 仅替换 model id 与显示名，可覆盖模板的默认参数。ModelSelectModal 与参数 popover 均读此表动态渲染。

import { useEffect, useReducer, useState } from "react";
import type { ParseKeys, TFunction } from "i18next";
import { deleteUserModel, listBuiltinModels, listUserModels } from "../api";
import type { BuiltinModel, BuiltinRegistry, CustomConfig, UserModelRow } from "../types";
// 供应商品牌图标（lobehub/lobe-icons，MIT）：透明底彩色 logo，渲染处 object-contain
import volcengineLogo from "../assets/providers/volcengine-color.svg";
import klingLogo from "../assets/providers/kling-color.svg";
import qwenLogo from "../assets/providers/qwen-color.svg";
import minimaxLogo from "../assets/providers/minimax-color.svg";
import modelscopeLogo from "../assets/providers/modelscope-color.svg";

export type Studio = import("../types").Studio;
export type Capability = "t2i" | "i2i" | "t2v" | "i2v" | "r2v";

// 参数弹层分区声明：由 Rust 侧 ParamSectionDto 生成（ts-rs），与后端数据同源。
export type ParamSectionDef = import("../types").ParamSection;
// 内置模型定义：由 Rust 侧 BuiltinModelDto 生成（含 sizeTable/pxBounds 等预计算字段）。
export type ModelDef = BuiltinModel;

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  abbr: string;
  color: string;
  /** 品牌 logo（lobehub 彩色 SVG，透明底）；内置厂商恒有，用户自添加模型挂靠内置厂商亦有 */
  logo?: string;
  wired: boolean; // 后端是否已接入（仅 wired=true 可真实生成）
  capabilities: Capability[];
  authHelp: string;
  i18nName?: boolean; // name 是否为 i18n key（内置 true；兜底路径 false，name 即显示名）
}

// ============ 厂商 id 常量 ============
// 与后端 providers/*.rs 的 PROVIDER_ID 常量一一对应（volcark/kling/wanxiang/minimax/modelscope）。
// 审计#19：分支逻辑改用命名常量，杜绝裸字符串拼写漂移；模型声明的 providerId 字段
// 由 ProviderId 类型兜底（拼错 tsc 立即报错）。
export const PROVIDER_IDS = {
  volcark: "volcark",
  kling: "kling",
  wanxiang: "wanxiang",
  minimax: "minimax",
  modelscope: "modelscope",
} as const;
export type ProviderId = (typeof PROVIDER_IDS)[keyof typeof PROVIDER_IDS];

// ============ 厂商元信息（UI 层，留在前端） ============
// 内置厂商 name / authHelp 为 i18n key（src/i18n/locales），渲染处需经 t() 转换；
// i18nName=false 仅出现在 providerMeta 兜底路径（DB 异常行防御）。
export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  volcark: {
    id: "volcark", name: "providers.volcark.name", abbr: "BD", color: "#a855f7", wired: true,
    capabilities: ["t2i", "i2i", "t2v", "i2v"],
    authHelp: "providers.volcark.authHelp",
    i18nName: true,
    logo: volcengineLogo,
  },
  kling: {
    id: "kling", name: "providers.kling.name", abbr: "KL", color: "#f43f5e", wired: true,
    capabilities: ["t2v", "i2v"],
    authHelp: "providers.kling.authHelp",
    i18nName: true,
    logo: klingLogo,
  },
  wanxiang: {
    id: "wanxiang", name: "providers.wanxiang.name", abbr: "AL", color: "#0ea5e9", wired: true,
    capabilities: ["t2i", "i2i", "t2v", "i2v"],
    authHelp: "providers.wanxiang.authHelp",
    i18nName: true,
    logo: qwenLogo,
  },
  minimax: {
    id: "minimax", name: "providers.minimax.name", abbr: "MX", color: "#ec4899", wired: true,
    capabilities: ["t2i", "i2i", "t2v", "i2v"],
    authHelp: "providers.minimax.authHelp",
    i18nName: true,
    logo: minimaxLogo,
  },
  modelscope: {
    id: "modelscope", name: "providers.modelscope.name", abbr: "MS", color: "#4f46e5", wired: true,
    capabilities: ["t2i", "i2i", "t2v", "i2v"],
    authHelp: "providers.modelscope.authHelp",
    i18nName: true,
    logo: modelscopeLogo,
  },
};

export const PROVIDER_LIST = Object.values(PROVIDERS);

// ============ 内置模型缓存（领域数据在 Rust，启动时一次性拉取） ============

let builtinModels: ModelDef[] = [];
let defaultImage = "";
let defaultVideo = "";
let hydrated = false;
let userModels: ModelDef[] = [];
let userModelRows: UserModelRow[] = [];
const listeners = new Set<() => void>();

export function subscribeUserModels(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notifyUserModels() {
  listeners.forEach((fn) => fn());
}

/** 无后端（`npm run dev` 前端-only，invoke 必 reject）时的最小回退模型表：保证界面可渲染。
 *  生产路径始终由 Rust `list_builtin_models` 提供完整注册表；此表仅在拉取失败时兜底，
 *  数据为简化版（sizeTable 留空，modelSize 按厂商类型回退基准像素），勿在此扩充业务规则。 */
const FALLBACK_MODELS: BuiltinModel[] = [
  {
    id: "wan2.7-image-pro",
    name: "wan2.7-image-pro",
    providerId: "wanxiang",
    studio: "image",
    capabilities: ["t2i", "i2i"],
    aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"],
    qualities: ["1K", "2K", "4K"],
    maxRef: 9,
    maxBatch: 12,
    edit: true,
    blurb: "文生图4K（无后端回退模型）",
    sizeTable: [],
    pxBounds: { min: 262144, max: 16777216 },
  },
  {
    id: "doubao-seedance-2-0-fast-260128",
    name: "Seedance 2.0 Fast",
    providerId: "volcark",
    studio: "video",
    capabilities: ["t2v", "i2v"],
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    qualities: ["480P", "720P"],
    durations: ["5", "10"],
    maxRef: 2,
    blurb: "2.0 快速档（无后端回退模型）",
    sizeTable: [],
    pxBounds: { min: 3686400, max: 16777216 },
  },
];

const FALLBACK_DEFAULTS: Record<Studio, string> = {
  image: "wan2.7-image-pro",
  video: "doubao-seedance-2-0-fast-260128",
};

/** 启动拉取内置模型注册表（含默认模型 id）。幂等，重复调用以最新为准；
 *  命令异常（无后端 dev 模式）时回退最小模型表并标记就绪——绝不允许「已就绪但空表」
 *  的状态（defaultModelForStudio 会拿到 undefined 崩溃）。 */
export async function hydrateRegistry(): Promise<void> {
  try {
    const r: BuiltinRegistry = await listBuiltinModels();
    builtinModels = r.models;
    defaultImage = r.defaultImage;
    defaultVideo = r.defaultVideo;
  } catch {
    builtinModels = FALLBACK_MODELS;
    defaultImage = FALLBACK_DEFAULTS.image;
    defaultVideo = FALLBACK_DEFAULTS.video;
  }
  hydrated = true;
  notifyUserModels();
}

/** 注册表是否已就绪（App 启动门控；就绪前不渲染依赖模型列表的工作区）。 */
export function useRegistryReady(): boolean {
  const [ready, setReady] = useState(hydrated);
  useEffect(() => {
    if (hydrated) setReady(true);
    return subscribeUserModels(() => setReady(hydrated));
  }, []);
  return ready;
}

// —— 用户自添加模型（动态注册表）——
// 配置存后端 SQLite（user_models），此处为前端内存镜像 + 变更订阅，
// 供两个 studio 的模型列表 / ModelSelectModal 响应式更新。

/** 用户模型行 → ModelDef：克隆模板（尺寸机制/sections/参数结构），
 *  替换 id/name/custom.repo_id，params_json 覆盖模板默认参数（含 sections param def）。 */
function toUserModelDef(row: UserModelRow): ModelDef | null {
  const tmpl = builtinModels.find((m) => m.id === row.template_model_id);
  if (!tmpl) return null;
  let params: Record<string, string | number | null> = {};
  if (row.params_json) {
    try {
      const p = JSON.parse(row.params_json) as Record<string, unknown>;
      params = Object.fromEntries(
        Object.entries(p).filter(([, v]) => v !== null && v !== undefined && v !== ""),
      ) as Record<string, string | number | null>;
    } catch {
      params = {};
    }
  }
  const custom = tmpl.custom
    ? {
        ...tmpl.custom,
        repo_id: row.model_id,
        name: row.name,
        params: { ...tmpl.custom.params, ...params },
      }
    : undefined;
  const sections = tmpl.sections?.map((s) =>
    s.type === "param" && params[s.key] !== undefined
      ? { ...s, def: String(params[s.key]) }
      : s,
  );
  return {
    ...tmpl,
    id: row.model_id,
    name: row.name,
    // 用户模型挂靠内置模板，厂商以模板为准（DB 行 provider_id 异常时也不破坏 ProviderId 类型）。
    providerId: tmpl.providerId,
    templateModelId: row.template_model_id,
    custom: custom as CustomConfig | null,
    sections,
    // 用户模型无简介；「自定义」后缀由展示层用 t() 拼接（registry 无 i18n 上下文）
    blurb: row.name,
  };
}

/** 启动/增删后调用：拉取用户模型并同步注册表。 */
export async function refreshUserModels(): Promise<void> {
  const rows = await listUserModels().catch(() => []);
  userModelRows = rows;
  userModels = rows.map(toUserModelDef).filter((m): m is ModelDef => m !== null);
  notifyUserModels();
}

/** 按模型 id 删除用户模型（定位 DB 行后删除并刷新）。 */
export async function removeUserModel(modelId: string): Promise<void> {
  const row = userModelRows.find((r) => r.model_id === modelId);
  if (!row) return;
  await deleteUserModel(row.id);
  await refreshUserModels();
}

/** 订阅用户模型变更；列表变化时触发重渲染。 */
export function useUserModels(): ModelDef[] {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeUserModels(force), []);
  return userModels;
}

/** 厂商元信息查找；未知 pid 兜底到灰色缩写（仅 DB 异常行防御，正常路径不可达）。 */
export function providerMeta(pid: string): ProviderMeta {
  return (
    PROVIDERS[pid as ProviderId] ?? {
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

/** 厂商显示名（内置为 i18n key）。 */
export function providerDisplayName(pid: string, t: TFunction): string {
  const p = providerMeta(pid);
  return p.i18nName ? t(p.name as ParseKeys) : p.name;
}

export function modelsForStudio(studio: Studio): ModelDef[] {
  const caps = studio === "image" ? ["t2i", "i2i"] : ["t2v", "i2v"];
  const builtin = builtinModels.filter((m) => m.studio === studio);
  const extra = userModels.filter((m) => m.capabilities.some((c) => caps.includes(c)));
  return [...builtin, ...extra];
}

/** 工作室默认模型：按显式 id 定位（领域数据来自 Rust registry），内置模型缺失时回退列表首个；
 *  列表也空时兜底到回退表（正常不可达——hydrateRegistry 保证每工作室至少一个模型）。 */
export function defaultModelForStudio(studio: Studio): ModelDef {
  const all = modelsForStudio(studio);
  const id = studio === "image" ? defaultImage : defaultVideo;
  return (
    all.find((m) => m.id === id) ??
    all[0] ??
    FALLBACK_MODELS.find((m) => m.studio === studio)!
  );
}

export function getModel(studio: Studio, id: string): ModelDef | undefined {
  return modelsForStudio(studio).find((m) => m.id === id);
}

// ============ 渲染期同步薄函数（数据来自缓存；规则权威在 Rust registry.rs） ============

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

/** 比例 → 原厂 size 串（占位卡展示与自定义尺寸回退基准）。
 *  全 (quality × ratio) 组合由 Rust 预计算进 sizeTable，此处纯查表（规则权威在 registry.rs）。
 *  quality 缺省取模型默认档位；查表未命中按厂商类型兜底。 */
export function modelSize(m: ModelDef, ar: string, quality?: string): string {
  const q = quality ?? m.defaultQuality ?? m.qualities[0];
  const hit = m.sizeTable.find((e) => e.quality === q && e.ratio === ar);
  if (hit) return hit.px;
  // 像素厂商回退 2K 方形；其余厂商 size 字段为比例原值（仅展示用）。
  if (
    m.providerId === PROVIDER_IDS.volcark ||
    m.providerId === PROVIDER_IDS.wanxiang ||
    m.providerId === PROVIDER_IDS.modelscope
  ) {
    return "2048x2048";
  }
  return ar;
}

/** 模型是否声明了指定参数分区（新参数状态仅在分区存在时提交/回填）。 */
export function hasSection(m: ModelDef, key: ParamSectionDef["key"]): boolean {
  return m.sections?.some((s) => s.key === key) ?? false;
}

/** 是否为 Seedream 5.0 Pro（内置或以其为模板的自添加模型）。
 *  Draw 交互编辑 / 透明背景 / 图层拆分等专属能力按模板 ID 判断。 */
export function isSeedreamProModel(m: ModelDef): boolean {
  return (
    m.providerId === PROVIDER_IDS.volcark &&
    (m.templateModelId ?? m.id).includes("5-0-pro")
  );
}

/** 张数区上限：单图模式按 maxImages（qwen 变体 6）或 maxRef 收敛（≤4）；
 *  组图模式按 maxBatch；volcark Seedream lite/4.5/4.0 官方上限 15，
 *  i2i 组图还需满足「参考图数 + 生成数 ≤ 15」，因此 refs 参与收敛。
 *  自定义模型 maxRef 是参考图上限，与张数无关，固定 1-4。
 *  渲染期滑杆需同步取值，保留薄函数消费缓存数据（权威实现与测试在 Rust registry.rs）。 */
export function batchCap(m: ModelDef, mode: "single" | "group", refs = 0): number {
  if (m.custom) return 4;
  if (mode === "group") {
    if (m.providerId === PROVIDER_IDS.volcark) {
      // 5.0 pro 不支持组图（以 id 或用户模型模板 id 判断）
      if (m.id.includes("5-0-pro") || m.templateModelId?.includes("5-0-pro")) return 1;
      const refCount = Math.max(0, Math.floor(refs));
      return Math.max(1, Math.min(m.maxBatch ?? 15, 15 - refCount));
    }
    return Math.max(1, Math.min(m.maxBatch ?? m.maxRef ?? 4, 12));
  }
  return Math.max(1, m.maxImages ?? Math.min(m.maxRef ?? 4, 4));
}

/** 前端兜底 id 生成（crypto.randomUUID 在非安全上下文不可用，必须兜底）。 */
export function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}