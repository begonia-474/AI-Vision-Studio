// 供应商品牌图标：内置厂商恒有 logo（lobehub 彩色 SVG，透明底），渲染 object-contain；
// 用户自添加模型挂靠内置厂商，同样有 logo；无 logo 仅发生在 providerMeta 兜底路径（实际不可达）。
import { cn } from "../lib/utils";
import type { ProviderMeta } from "../models/registry";

interface ProviderLogoProps {
  provider: ProviderMeta;
  size?: number;
  className?: string;
}

export function ProviderLogo({ provider, size = 16, className }: ProviderLogoProps) {
  if (!provider.logo) return null;
  return (
    <img
      src={provider.logo}
      alt={provider.name}
      width={size}
      height={size}
      className={cn("shrink-0 object-contain", className)}
    />
  );
}
