// 模型注册表（前端侧）—— 数据源 docs/model-registry.md
// 与后端 provider_id 对齐：volcark(已接入) / kling / wanxiang / minimax(待接入)
// ModelDropdown 与参数 popover 均读此表动态渲染。

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
}

// ============ 厂商元信息 ============
export const PROVIDERS: Record<string, ProviderMeta> = {
  volcark: {
    id: "volcark", name: "即梦 / 豆包", abbr: "BD", color: "#a855f7", wired: true,
    capabilities: ["t2i", "i2i", "t2v", "i2v"],
    authHelp: "火山方舟控制台创建 API Key（Bearer Token）。",
  },
  kling: {
    id: "kling", name: "可灵 Kling", abbr: "KL", color: "#f43f5e", wired: true,
    capabilities: ["t2v", "i2v"],
    authHelp: "推荐 API Key（Bearer）；旧模型兼容 JWT。",
  },
  wanxiang: {
    id: "wanxiang", name: "通义万相", abbr: "AL", color: "#0ea5e9", wired: true,
    capabilities: ["t2i", "i2i", "t2v", "i2v"],
    authHelp: "DashScope Bearer Key + 可选 WorkspaceId。",
  },
  minimax: {
    id: "minimax", name: "MiniMax 海螺", abbr: "MX", color: "#ec4899", wired: true,
    capabilities: ["t2i", "i2i", "t2v", "i2v"],
    authHelp: "Bearer API Key。Hailuo 视频 / image-01 图像。",
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
export function modelsForStudio(studio: Studio): ModelDef[] {
  return studio === "image" ? IMAGE_MODELS : VIDEO_MODELS;
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
