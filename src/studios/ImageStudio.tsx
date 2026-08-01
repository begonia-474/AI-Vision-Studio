// 图像工作室
// 结果流（空态/网格）+ 底部 PromptComposer。状态由 useStudio 管理，常驻挂载保留状态。

import { PromptComposer } from "../components/PromptComposer";
import { ResultGrid } from "../components/ResultGrid";
import { useStudio } from "./useStudio";

interface ImageStudioProps {
  onImageToVideo?: (src: string, prompt: string) => void;
}

export function ImageStudio({ onImageToVideo }: ImageStudioProps) {
  const api = useStudio("image");

  return (
    <div className="studio-root">
      <div className="results-stream">
        <ResultGrid
          results={api.results}
          studio="image"
          model={api.model}
          onImageToVideo={onImageToVideo}
          onDelete={api.removeResult}
        />
      </div>
      <PromptComposer api={api} />
    </div>
  );
}
