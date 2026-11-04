import React from "react";
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Audio } from "@remotion/media";
import { AI, Connect, End, Hook, Install, Overview, Perms, Remote } from "./Scenes";
import { Caption } from "./ui";
import { BG, FPB, TIMELINE, fb } from "./lib";

// 音效音量（相对配乐）
const VOL: Record<string, number> = { click: 0.7, pop: 0.4, whoosh: 0.45, swish: 0.4, type: 0.5, lock: 0.6, chime: 0.45, boom: 0.65, riser: 0.4 };

const Captions: React.FC = () => {
  const b = useCurrentFrame() / FPB;
  return (
    <>
      {(TIMELINE.captions as [number, number, string, string][]).map(([from, to, zh, en], i) => (
        <Caption key={i} b={b} from={from} to={to} zh={zh} en={en} />
      ))}
    </>
  );
};

export const LocalvpsIntro: React.FC<{ audio?: boolean }> = ({ audio = true }) => (
  <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 40%, #f7f7f4 0%, ${BG} 70%)` }}>
    <Hook />
    <Install />
    <Overview />
    <Connect />
    <AI />
    <Perms />
    <Remote />
    <End />
    <Captions />
    {audio ? <Audio src={staticFile("audio/music.wav")} volume={0.85} /> : null}
    {audio
      ? (TIMELINE.sfx as [string, number][]).filter(([n]) => VOL[n] > 0).map(([n, beat], i) => (
          <Sequence key={i} from={fb(beat)} durationInFrames={fb(6)} layout="none">
            <Audio src={staticFile(`audio/sfx/${n}.wav`)} volume={VOL[n]} />
          </Sequence>
        ))
      : null}
  </AbsoluteFill>
);
