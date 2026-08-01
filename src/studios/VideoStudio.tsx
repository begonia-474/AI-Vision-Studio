// 视频工作室
// 镜像 ImageStudio 结构，差异：duration 控件、无批量、结果卡为视频（播放叠层）。
// 接收来自图像工作室的「图生视频」跳转（jump），通过 effect 注入首帧 + prompt。

import { useEffect } from "react";
import { PromptComposer } from "../components/PromptComposer";
import { ResultGrid } from "../components/ResultGrid";
import { useStudio } from "./useStudio";

interface VideoStudioProps {
  jump: { src: string; prompt: string } | null;
  onJumpConsumed: () => void;
}

export function VideoStudio({ jump, onJumpConsumed }: VideoStudioProps) {
  const api = useStudio("video");

  useEffect(() => {
    if (jump) {
      api.applyVideoJump(jump.src, jump.prompt);
      onJumpConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  return (
    <div className="studio-root">
      <div className="results-stream">
        <ResultGrid
          results={api.results}
          studio="video"
          model={api.model}
          onDelete={api.removeResult}
        />
      </div>
      <PromptComposer api={api} />
    </div>
  );
}
