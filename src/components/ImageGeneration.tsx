// 生成中装饰动画（aicss.dev Image Generation 原版效果，按任务时间线布局适配）：
// 每张占位卡 = 一块"生成画布"（点阵底 + 游走光斑 + 右上分辨率徽标），
// 与完成态网格同布局同比例（占满所在格），完成后无缝替换为结果图。
// 画布下方不放提示词——时间线左侧气泡已展示 prompt，避免重复；
// 任务级流光阶段文案（ImageGenerationLabel）挂在网格下方，与旧版阶段文案同位。
import { useTranslation } from "react-i18next";
import styles from "./ImageGeneration.module.css";

interface ImageGenerationProps {
  /** 分辨率/比例徽标文本（如 "9:16"、"1080 × 1920"） */
  resolution?: string;
  /** 画布 CSS aspect-ratio（如 "1 / 1"、"9 / 16"），缺省正方形 */
  ratio?: string;
}

export function ImageGeneration({ resolution = "", ratio = "1 / 1" }: ImageGenerationProps) {
  const { t } = useTranslation();
  return (
    <div
      className={styles.igCanvas}
      role="img"
      aria-label={t("prompt.phaseRunning")}
      style={{ aspectRatio: ratio }}
    >
      <span className={styles.igDots} aria-hidden />
      <span className={styles.igGlow} aria-hidden />
      {resolution && <span className={styles.igRes}>{resolution}</span>}
    </div>
  );
}

/** 流光阶段文案（时间线网格下方的任务级标签：提交中/生成中/下载中） */
export function ImageGenerationLabel({ text }: { text: string }) {
  return <span className={styles.igLabel}>{text}</span>;
}
