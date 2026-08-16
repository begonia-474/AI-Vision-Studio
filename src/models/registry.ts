// 模型注册表（前端侧）—— 本文件为内置模型的单一数据源
// 与后端 provider_id 对齐：volcark / kling / wanxiang / minimax / modelscope 内置。
// 用户自添加模型：以任意内置模型为模板（继承其尺寸机制/参数分区/默认参数），
// 仅替换 model id 与显示名，可覆盖模板的默认参数。ModelSelectModal 与参数 popover 均读此表动态渲染。

import { useEffect, useReducer } from "react";
import type { ParseKeys, TFunction } from "i18next";
import { deleteUserModel, listUserModels } from "../api";
import type { CustomModelConfig, UserModelRow } from "../types";
// 供应商品牌图标（lobehub/lobe-icons，MIT）：透明底彩色 logo，渲染处 object-contain
import volcengineLogo from "../assets/providers/volcengine-color.svg";
import klingLogo from "../assets/providers/kling-color.svg";
import qwenLogo from "../assets/providers/qwen-color.svg";
import minimaxLogo from "../assets/providers/minimax-color.svg";
import modelscopeLogo from "../assets/providers/modelscope-color.svg";

export type Studio = "image" | "video";
export type Capability = "t2i" | "i2i" | "t2v" | "i2v" | "r2v";

// ============ 参数弹层分区声明 ============
// 哩布风格：弹层内容按模型声明式渲染，不同模型呈现不同分区。
// title 为 i18n key；options 缺省时按 key 取模型字段（quality→qualities，batch→1..min(maxRef,4)）。
// 生图模式（mode）：单图=1 张（API 无 n 参数），组图=sequential auto + max_images（张数区）。
export type ParamKey = "ar" | "quality" | "duration" | "batch" | "mode" | "format" | "optimize" | "background" | "web_search";

export type ParamSectionDef =
  | {
      type: "segmented";
      key: "quality" | "batch" | "mode" | "format" | "optimize" | "background" | "web_search";
      title: string;
      options?: string[]; // 缺省 quality→model.qualities，batch→1..min(maxRef,4)，mode→[single,group]，format→model.formats
      /** 选项为 i18n key，渲染时经 t() 转换（如生图模式的单图/组图） */
      i18n?: boolean;
      /** 仅在图生图（已有参考图）时展示的分区（Seedream 5.0 pro 透明背景） */
      visible?: "i2i";
    }
  | {
      type: "ratio";
      key: "ar";
      title: string;
      options?: string[]; // 缺省取 model.aspectRatios
      /** 比例网格下方附加 W/H 自定义尺寸输入 + 锁定（仅 pixel-size 厂商，如 volcark） */
      size?: boolean;
    }
  | { type: "size"; key: "size"; title: string } // 独立 W/H 自定义尺寸分区（pixel-size 模型提交 size="WxH"）
  | { type: "loras"; key: "loras"; title: string } // LoRA 列表（repo-id + 权重行，提交时 1 个→字符串，多个→{repo: weight}）
  | {
      type: "param";
      key: string; // 接口字段名（用户自添加模型的自由参数，运行时调整）
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
  /** 品牌 logo（lobehub 彩色 SVG，透明底）；内置厂商恒有，用户自添加模型挂靠内置厂商亦有 */
  logo?: string;
  wired: boolean; // 后端是否已接入（仅 wired=true 可真实生成）
  capabilities: Capability[];
  authHelp: string;
  i18nName?: boolean; // name 是否为 i18n key（内置 true；兜底路径 false，name 即显示名）
}

export interface ModelDef {
  id: string;
  name: string;
  providerId: string;
  studio: Studio;
  capabilities: Capability[];
  aspectRatios: string[];
  qualities: string[]; // 图像画质 / 视频分辨率
  /** 模型默认画质档位；缺省取 qualities[0]（Seedream 5.0 pro 官方默认 2K，不能用数组下标） */
  defaultQuality?: string;
  durations?: string[]; // 仅视频
  /** 图像输出格式（如火山方舟 5.0 的 png/jpeg）；声明后参数弹层渲染「图片格式」分区，缺省 jpeg */
  formats?: string[];
  maxRef?: number; // 参考图上限
  /** 组图模式（mode=group）最大张数；缺省与普通张数一致（≤4）。2.7 组图官方上限 12。 */
  maxBatch?: number;
  /** 单图模式一次请求最大张数（变体 n，如 qwen 系列官方 6）；缺省按 maxRef 收敛（≤4）。 */
  maxImages?: number;
  /** 模板模型 id（用户自添加模型继承模板行为；内置模型为 undefined，提交时回退为自身 id） */
  templateModelId?: string;
  /** 图像编辑能力（指令编辑/局部修改/多图操作）。缺省 = 仅图生图（参考图生成）。
   *  百炼上很多"不支持编辑"的模型仍支持图生图（实测 z-image-turbo / qwen-image-max）。 */
  edit?: boolean;
  blurb: string; // 模型一句话描述
  custom?: CustomModelConfig; // 用户自添加模型配置（模板克隆 + 自定义参数），供生成时透传参数
  /** 参数弹层分区声明；缺省时按 studio/厂商推导（defaultSections） */
  sections?: ParamSectionDef[];
}

// ============ 厂商元信息 ============
// 内置厂商 name / authHelp 为 i18n key（src/i18n/locales），渲染处需经 t() 转换；
// i18nName=false 仅出现在 providerMeta 兜底路径（DB 异常行防御）。
export const PROVIDERS: Record<string, ProviderMeta> = {
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
  { type: "segmented", key: "optimize", title: "prompt.optimizePrompt", options: ["standard", "fast"], i18n: true },
  { type: "segmented", key: "batch", title: "prompt.imageCount" },
  { type: "segmented", key: "format", title: "prompt.imageFormat" },
  { type: "segmented", key: "background", title: "prompt.backgroundMode", options: ["opaque", "transparent"], i18n: true, visible: "i2i" },
];
const seedreamSections45: ParamSectionDef[] = [
  { type: "segmented", key: "mode", title: "prompt.imageMode", options: ["single", "group"], i18n: true },
  { type: "segmented", key: "quality", title: "prompt.resolution" },
  { type: "ratio", key: "ar", title: "prompt.imageSize", size: true },
  { type: "segmented", key: "batch", title: "prompt.imageCount" },
];
// 4.0 支持标准/快速提示词优化，但不支持 output_format（仅 jpeg）与联网搜索。
const seedreamSections40: ParamSectionDef[] = [
  { type: "segmented", key: "mode", title: "prompt.imageMode", options: ["single", "group"], i18n: true },
  { type: "segmented", key: "quality", title: "prompt.resolution" },
  { type: "ratio", key: "ar", title: "prompt.imageSize", size: true },
  { type: "segmented", key: "optimize", title: "prompt.optimizePrompt", options: ["standard", "fast"], i18n: true },
  { type: "segmented", key: "batch", title: "prompt.imageCount" },
];
// 联网搜索与 output_format 仅 5.0 lite 支持，不能与 4.x 共用 sections。
const seedreamSectionsLite: ParamSectionDef[] = [
  { type: "segmented", key: "mode", title: "prompt.imageMode", options: ["single", "group"], i18n: true },
  { type: "segmented", key: "quality", title: "prompt.resolution" },
  { type: "ratio", key: "ar", title: "prompt.imageSize", size: true },
  { type: "segmented", key: "batch", title: "prompt.imageCount" },
  { type: "segmented", key: "format", title: "prompt.imageFormat" },
  { type: "segmented", key: "web_search", title: "prompt.webSearch", options: ["off", "on"], i18n: true },
];

// 万相 2.7（wanxiang）：size 档位 1K/2K（pro 文生图另加 4K）；组图 enable_sequential；
// 多图参考 0-9 张；ratio 区带 W/H 自定义尺寸（像素串 "宽*高"，后端 custom_size_px 优先）。
const WAN27_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"];
const wan27Sections: ParamSectionDef[] = [
  { type: "segmented", key: "mode", title: "prompt.imageMode", options: ["single", "group"], i18n: true },
  { type: "segmented", key: "quality", title: "prompt.resolution" },
  { type: "ratio", key: "ar", title: "prompt.imageSize", size: true },
  { type: "segmented", key: "batch", title: "prompt.imageCount" },
];

// wan2.6 图像：像素串（官方推荐表/档位）+ W/H 自定义。
const wan26Sections: ParamSectionDef[] = [
  { type: "ratio", key: "ar", title: "prompt.imageSize", size: true },
  { type: "segmented", key: "quality", title: "prompt.resolution" },
];

// 千问图像（wanxiang，同步 multimodal-generation）：像素串 + W/H 自定义；i2i 参考图 ≤3 张（maxRef）。
const QWEN_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"];
const QWEN_2K_QUALITIES = ["1K", "2K"]; // 像素串基准档位（总像素 ≤2048²）
const QWEN_FIXED_QUALITIES = ["默认"]; // max/plus/image 固定分辨率档
const qwenSizeSections: ParamSectionDef[] = [
  { type: "ratio", key: "ar", title: "prompt.imageSize", size: true },
  { type: "segmented", key: "quality", title: "prompt.resolution" },
  { type: "segmented", key: "batch", title: "prompt.imageCount" },
];

// z-image-turbo：像素串 + W/H 自定义（无 watermark/n/负向提示词参数）。
const Z_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"];
const zImageSections: ParamSectionDef[] = [
  { type: "ratio", key: "ar", title: "prompt.imageSize", size: true },
  { type: "segmented", key: "quality", title: "prompt.resolution" },
];

export const IMAGE_MODELS: ModelDef[] = [
  { id: "wan2.7-image-pro", name: "wan2.7-image-pro", providerId: "wanxiang", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: WAN27_RATIOS, qualities: ["1K", "2K", "4K"], maxRef: 9, maxBatch: 12, edit: true, blurb: "文生图4K，文字渲染/角色一致，组图", sections: wan27Sections },
  { id: "wan2.7-image", name: "wan2.7-image", providerId: "wanxiang", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: WAN27_RATIOS, qualities: ["1K", "2K"], maxRef: 9, maxBatch: 12, edit: true, blurb: "2.7 快速版，最高 2K", sections: wan27Sections },
  { id: "qwen-image-2.0-pro", name: "qwen-image-2.0-pro", providerId: "wanxiang", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: QWEN_RATIOS, qualities: QWEN_2K_QUALITIES, maxRef: 3, maxImages: 6, edit: true, blurb: "复杂版面/小字渲染，负向提示词，6 张变体", sections: qwenSizeSections },
  { id: "qwen-image-2.0", name: "qwen-image-2.0", providerId: "wanxiang", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: QWEN_RATIOS, qualities: QWEN_2K_QUALITIES, maxRef: 3, maxImages: 6, edit: true, blurb: "2.0 快速版，同能力", sections: qwenSizeSections },
  { id: "qwen-image-max", name: "qwen-image-max", providerId: "wanxiang", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: QWEN_RATIOS, qualities: QWEN_FIXED_QUALITIES, maxRef: 1, blurb: "固定 1664x928 档，单图，支持图生图", sections: zImageSections },
  { id: "qwen-image-plus", name: "qwen-image-plus", providerId: "wanxiang", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: QWEN_RATIOS, qualities: QWEN_FIXED_QUALITIES, maxRef: 1, blurb: "轻量单图，成本低，支持图生图", sections: zImageSections },
  { id: "qwen-image", name: "qwen-image", providerId: "wanxiang", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: QWEN_RATIOS, qualities: QWEN_FIXED_QUALITIES, maxRef: 1, blurb: "基础版单图，支持图生图", sections: zImageSections },
  { id: "qwen-image-edit-max", name: "qwen-image-edit-max", providerId: "wanxiang", studio: "image", capabilities: ["i2i"], aspectRatios: QWEN_RATIOS, qualities: QWEN_2K_QUALITIES, maxRef: 3, maxImages: 6, edit: true, blurb: "图像编辑，1-3 图参考，6 张变体", sections: qwenSizeSections },
  { id: "qwen-image-edit-plus", name: "qwen-image-edit-plus", providerId: "wanxiang", studio: "image", capabilities: ["i2i"], aspectRatios: QWEN_RATIOS, qualities: QWEN_2K_QUALITIES, maxRef: 3, maxImages: 6, edit: true, blurb: "图像编辑，1-3 图参考", sections: qwenSizeSections },
  { id: "qwen-image-edit", name: "qwen-image-edit", providerId: "wanxiang", studio: "image", capabilities: ["i2i"], aspectRatios: QWEN_RATIOS, qualities: QWEN_FIXED_QUALITIES, maxRef: 1, edit: true, blurb: "轻量图像编辑，单图" },
  { id: "z-image-turbo", name: "z-image-turbo", providerId: "wanxiang", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: Z_RATIOS, qualities: ["1K", "2K"], maxRef: 1, blurb: "快 10 倍/约 1/5 价，写实人像，支持图生图", sections: zImageSections },
  { id: "doubao-seedream-5-0-pro-260628", name: "Seedream 5.0 Pro", providerId: "volcark", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: SEEDREAM_RATIOS, qualities: ["1K","1.5K","2K"], defaultQuality: "2K", formats: ["jpeg", "png"], maxRef: 10, blurb: "写实电影感，提示词优化/透明背景", sections: seedreamSectionsPro },
  { id: "doubao-seedream-5-0-260128", name: "Seedream 5.0 Lite", providerId: "volcark", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: SEEDREAM_RATIOS, qualities: ["2K","3K","4K"], formats: ["jpeg", "png"], maxRef: 14, maxBatch: 15, blurb: "组图/流式/联网，性价比", sections: seedreamSectionsLite },
  { id: "doubao-seedream-4-5-251128", name: "Seedream 4.5", providerId: "volcark", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: SEEDREAM_RATIOS, qualities: ["2K","4K"], maxRef: 14, maxBatch: 15, blurb: "多图参考，组图/流式", sections: seedreamSections45 },
  { id: "doubao-seedream-4-0-250828", name: "Seedream 4.0", providerId: "volcark", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: SEEDREAM_RATIOS, qualities: ["1K","2K","4K"], defaultQuality: "2K", maxRef: 14, maxBatch: 15, blurb: "组图/流式，标准/快速优化", sections: seedreamSections40 },
  { id: "wan2.6-t2i", name: "wan2.6-t2i", providerId: "wanxiang", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: ["1:1","3:4","4:3","16:9","9:16"], qualities: ["1K","2K"], maxRef: 1, blurb: "国风水墨，意境留白，对话式图生图", sections: wan26Sections },
  { id: "wan2.6-image", name: "wan2.6-image", providerId: "wanxiang", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: ["1:1","3:4","4:3","16:9","9:16"], qualities: ["1K","2K"], maxRef: 1, edit: true, blurb: "图像编辑，单图参考", sections: wan26Sections },
  { id: "image-01", name: "image-01", providerId: "minimax", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: ["1:1","3:4","4:3","16:9","9:16"], qualities: ["1K","2K"], maxRef: 1, blurb: "机甲赛博，octane 质感" },
  { id: "image-01-live", name: "image-01-live", providerId: "minimax", studio: "image", capabilities: ["t2i", "i2i"], aspectRatios: ["1:1","3:4","4:3","16:9","9:16"], qualities: ["1K"], maxRef: 1, blurb: "星云超现实，梦幻氛围" },
];

// ============ 魔搭（ModelScope）内置模型 ============
// repo_id 即模型 ID（提交 model 字段，均已按魔搭 API 验证存在）。
// 尺寸：比例网格（1:1/2:3/3:4...），选中比例按模型上限换算像素（长边=上限，短边按比例取 16 倍数），
// 比例网格下带 W/H 自定义输入（提交 size="WxH"）。
// sections：比例尺寸 + 张数（无 n 参数，N 张=并行 N 任务）+ LoRA + 自由参数。
// 自由参数为魔搭 API 原生字段：steps/guidance/seed/negative_prompt（弹层可调，默认随请求下发）。
const MS_RATIOS = ["1:1", "2:3", "3:4", "4:3", "3:2", "9:16", "16:9"];

/// 魔搭模型分辨率上限（长边 px）：FLUX 家族 1024；Qwen-Image（2512 前）1664；其余 2048。
const msMax = (modelId: string): number => {
  if (modelId.startsWith("black-forest-labs")) return 1024;
  if (modelId === "Qwen/Qwen-Image") return 1664;
  return 2048;
};

const msSections = (steps: number, guidance: number): ParamSectionDef[] => [
  { type: "ratio", key: "ar", title: "prompt.aspectRatio", size: true },
  { type: "segmented", key: "batch", title: "prompt.imageCount" },
  { type: "loras", key: "loras", title: "prompt.loras" },
  { type: "param", key: "steps", title: "prompt.paramSteps", kind: "number", def: String(steps) },
  { type: "param", key: "guidance", title: "prompt.paramGuidance", kind: "number", def: String(guidance) },
  { type: "param", key: "seed", title: "prompt.paramSeed", kind: "number", def: "" },
  { type: "param", key: "negative_prompt", title: "prompt.paramNegativePrompt", kind: "text", def: "" },
];

const msModel = (
  repoId: string,
  name: string,
  steps: number,
  guidance: number,
  blurb: string,
): ModelDef => ({
  id: repoId,
  name,
  providerId: "modelscope",
  studio: "image",
  capabilities: ["t2i", "i2i"],
  aspectRatios: [...MS_RATIOS],
  qualities: ["默认"],
  maxRef: 1,
  maxImages: 4, // 魔搭无 n 参数：N 张 = 并行 N 任务（后端实现），张数区 1-4
  blurb,
  custom: {
    repo_id: repoId,
    name,
    capabilities: ["t2i", "i2i"],
    size_presets: [...MS_RATIOS],
    params: { steps, guidance },
  },
  sections: msSections(steps, guidance),
});

const MODELSCOPE_MODELS: ModelDef[] = [
  msModel("krea/Krea-2-Turbo", "Krea-2-Turbo", 8, 1, "Krea 2 Turbo，写实需配 LoRA"),
  msModel("Qwen/Qwen-Image", "Qwen-Image", 30, 3.5, "通义文生图"),
  msModel("Qwen/Qwen-Image-2512", "Qwen-Image-2512", 30, 3.5, "通义文生图 2512 版，人像更真实"),
  msModel("Tongyi-MAI/Z-Image-Turbo", "Z-Image-Turbo", 9, 0, "Z-Image 快速版（8 步蒸馏）"),
  msModel("black-forest-labs/FLUX.2-dev", "FLUX.2-dev", 30, 3.5, "FLUX.2 dev 32B"),
  msModel("black-forest-labs/FLUX.2-klein-9B", "FLUX.2-klein-9B", 4, 1, "FLUX.2 klein 9B（4 步）"),
  msModel("HiDream-ai/HiDream-O1-Image", "HiDream-O1-Image", 50, 5, "HiDream O1 8B"),
  msModel("MAILAND/majicflus_v1", "majicflus_v1", 25, 3.5, "麦橘超然，写实人像"),
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

/** 模型是否声明了指定参数分区（新参数状态仅在分区存在时提交/回填）。 */
export function hasSection(m: ModelDef, key: ParamSectionDef["key"]): boolean {
  return m.sections?.some((s) => s.key === key) ?? false;
}

/** 是否为 Seedream 5.0 Pro（内置或以其为模板的自添加模型）。
 *  Draw 交互编辑 / 透明背景 / 图层拆分等专属能力按模板 ID 判断。 */
export function isSeedreamProModel(m: ModelDef): boolean {
  return (
    m.providerId === "volcark" &&
    (m.templateModelId ?? m.id).includes("5-0-pro")
  );
}

/** 张数区上限：单图模式按 maxImages（qwen 变体 6）或 maxRef 收敛（≤4）；
 *  组图模式按 maxBatch；volcark Seedream lite/4.5/4.0 官方上限 15，
 *  i2i 组图还需满足「参考图数 + 生成数 ≤ 15」，因此 refs 参与收敛。
 *  自定义模型 maxRef 是参考图上限，与张数无关，固定 1-4。 */
export function batchCap(m: ModelDef, mode: "single" | "group", refs = 0): number {
  if (m.custom) return 4;
  if (mode === "group") {
    if (m.providerId === "volcark") {
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

// —— 用户自添加模型（动态注册表）——
// 配置存后端 SQLite（user_models），此处为前端内存镜像 + 变更订阅，
// 供两个 studio 的模型列表 / ModelSelectModal 响应式更新。

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

/** 模板模型查找：全部内置模型（图像/视频/魔搭）。 */
const allBuiltinModels = (): ModelDef[] => [...IMAGE_MODELS, ...VIDEO_MODELS, ...MODELSCOPE_MODELS];

/** 用户模型行 → ModelDef：克隆模板（尺寸机制/sections/参数结构），
 *  替换 id/name/custom.repo_id，params_json 覆盖模板默认参数（含 sections param def）。 */
function toUserModelDef(row: UserModelRow): ModelDef | null {
  const tmpl = allBuiltinModels().find((m) => m.id === row.template_model_id);
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
    providerId: row.provider_id,
    templateModelId: row.template_model_id,
    custom,
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
    PROVIDERS[pid] ?? {
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
  const builtin = studio === "image" ? [...IMAGE_MODELS, ...MODELSCOPE_MODELS] : VIDEO_MODELS;
  const caps = studio === "image" ? ["t2i", "i2i"] : ["t2v", "i2v"];
  const extra = userModels.filter((m) => m.capabilities.some((c) => caps.includes(c)));
  return [...builtin, ...extra];
}

// 工作室默认模型（审计#11：原先 useStudio/App 用列表魔法下标 0/1，列表重排即静默换默认；
// 显式按 id 声明，保持现状：图像=wan2.7-image-pro，视频=Seedance 2.0 Fast）。
const DEFAULT_MODEL_IDS: Record<Studio, string> = {
  image: "wan2.7-image-pro",
  video: "doubao-seedance-2-0-fast-260128",
};

/** 工作室默认模型：按 id 定位，内置模型被删除/改名时回退列表首个。 */
export function defaultModelForStudio(studio: Studio): ModelDef {
  const all = modelsForStudio(studio);
  return all.find((m) => m.id === DEFAULT_MODEL_IDS[studio]) ?? all[0];
}

export function getModel(studio: Studio, id: string): ModelDef | undefined {
  return modelsForStudio(studio).find((m) => m.id === id);
}

/** 官方像素表（对照 docs/model-api 图片生成 API 文档方式1 映射表）。
 *  5.0 pro 独立（1K/1.5K/2K）；lite/4.5/4.0 共用（1K/2K/3K/4K）。
 *  9:21 文档无直给值，取 21:9 转置（总像素合规，见 volcarkPixelBounds）。 */
const PRO_PX: Record<string, Record<string, string>> = {
  "1K": {
    "1:1": "1024x1024", "4:3": "1152x864", "3:4": "864x1152", "16:9": "1424x800", "9:16": "800x1424",
    "3:2": "1248x832", "2:3": "832x1248", "21:9": "1568x672", "9:21": "672x1568",
  },
  "1.5K": {
    "1:1": "1536x1536", "4:3": "1792x1344", "3:4": "1344x1792", "16:9": "2048x1152", "9:16": "1152x2048",
    "3:2": "1872x1248", "2:3": "1248x1872", "21:9": "2352x1008", "9:21": "1008x2352",
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

/** 比例 → 像素串（"WxH"）：长边 = k，短边按比例向下取 16 倍数（与后端 ratio_px 算法一致）。 */
function pxByRatio(ar: string, k: number): string {
  const m = /^(\d+):(\d+)$/.exec(ar);
  if (!m) return `${k}x${k}`;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a <= 0 || b <= 0) return `${k}x${k}`;
  const long = k;
  const short = Math.max(16, Math.floor((long * Math.min(a, b)) / Math.max(a, b) / 16) * 16);
  return a >= b ? `${long}x${short}` : `${short}x${long}`;
}

/** 比例 → 原厂 size 串（UI 展示与自定义尺寸回退基准，与后端 volcark.rs 官方像素表一致）。
 *  volcark(Seedream)：方式2 像素 `宽x高`，按 model+quality+ratio 查官方表（5.0 pro 与 lite/4.5/4.0 表不同）；
 *  profileId 为模板模型 id（用户自添加模型继承模板像素机制，缺省回退 modelId）；
 *  wanxiang（万相/千问/z-image）：像素串按画质档位长边换算（pro 文生图支持 4K）；
 *  其余厂商不读 size 字段，回退为比例原值占位。 */
export function aspectToSize(
  providerId: string,
  modelId: string,
  ar: string,
  quality?: string,
  profileId?: string,
): string {
  if (providerId === "wanxiang") {
    const q = quality ?? "2K";
    let k = 2048;
    if (modelId.startsWith("wan2.7-image-pro") && q === "4K") k = 4096;
    else if (modelId.startsWith("wan2.7-image") && q === "1K") k = 1024;
    else if (modelId === "wan2.6-t2i") k = 1280; // 官方推荐基准档
    else if (modelId === "wan2.6-image") k = q === "2K" ? 2048 : 1024;
    else if (modelId.startsWith("qwen-image")) k = q === "1K" ? 1024 : 2048;
    else if (modelId.startsWith("z-image")) k = q === "2K" ? 2048 : 1024;
    else if (q === "1K") k = 1024;
    return pxByRatio(ar, k);
  }
  if (providerId === "modelscope") {
    // 比例 → 像素：长边 = 模型上限（msMax），短边按比例取 16 倍数。
    return pxByRatio(ar, msMax(modelId));
  }
  if (providerId !== "volcark") return ar;
  const q = quality ?? "2K";
  const table = (profileId ?? modelId).includes("5-0-pro") ? PRO_PX : COMMON_PX;
  return table[q]?.[ar] ?? table["2K"]?.[ar] ?? "2048x2048";
}

/** W/H 自定义尺寸总像素区间（UI 校验用）：
 *  用户自添加模型通用 [512², 4096²]；volcark 官方区间：pro [921600, 4624220]，5.0 lite/4.5 [3686400, 16777216]，4.0 [921600, 16777216]；
 *  wanxiang：qwen/z-image [512², 2048²]，其余 [768², 2048²]（wan2.7-image-pro 文生图 4K 放宽到 [768², 4096²]）。
 *  自添加模型按其模板模型判断（与后端 template_model_id 行为一致）。 */
export function pixelBounds(model: ModelDef): { min: number; max: number } {
  if (model.custom) {
    // 用户自添加/魔搭内置模型：最小 512²，最大按模型上限（魔搭 msMax，其余 4096²）。
    const max = model.providerId === "modelscope" ? msMax(model.id) : 4096;
    return { min: 512 * 512, max: max * max };
  }
  if (model.providerId === "wanxiang") {
    const min =
      model.id.startsWith("qwen") || model.id.startsWith("z-") ? 512 * 512 : 768 * 768;
    const max = model.id === "wan2.7-image-pro" ? 4096 * 4096 : 2048 * 2048;
    return { min, max };
  }
  const profileId = model.templateModelId ?? model.id;
  if (profileId.includes("5-0-pro")) return { min: 921600, max: 4624220 };
  if (profileId.includes("4-0")) return { min: 921600, max: 16777216 };
  return { min: 3686400, max: 16777216 }; // 5.0 lite / 4.5
}

/** W/H 自定义尺寸宽高比区间（UI 校验用）；volcark 官方要求 [1/16, 16]，其余厂商无此限制。 */
export function pixelRatioBounds(model: ModelDef): { min: number; max: number } | null {
  return model.providerId === "volcark" ? { min: 1 / 16, max: 16 } : null;
}
