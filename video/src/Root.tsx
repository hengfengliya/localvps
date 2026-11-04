import { Composition } from "remotion";
import { LocalvpsIntro } from "./Video";
import { TIMELINE, TOTAL_FRAMES } from "./lib";

export const RemotionRoot: React.FC = () => (
  <Composition id="LocalvpsIntro" component={LocalvpsIntro} durationInFrames={TOTAL_FRAMES} fps={TIMELINE.fps} width={1920} height={1080} />
);
