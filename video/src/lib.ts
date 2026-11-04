import { Easing, interpolate } from "remotion";
import TL from "./timeline.json";
import SHOTS from "../public/shots/shots.json";

export const TIMELINE = TL;
/** 一拍多少帧：120 BPM、30fps 正好 15 帧 */
export const FPB = Math.round((60 / TL.bpm) * TL.fps);
export const fb = (beat: number) => Math.round(beat * FPB);
export const TOTAL_FRAMES = fb(TL.totalBeats);

export type Rect = [number, number, number, number];
/** 截图时记下的元素位置（CSS 像素，相对 1440×900 窗口） */
export const shots = SHOTS.shots as unknown as Record<string, Record<string, Rect[]>>;
export const WIN = { w: SHOTS.w, h: SHOTS.h };

// Beayy 令牌
export const PAGE = "#fcfcfb";
export const INK = "#0b0b0b";
export const INK2 = "#52514e";
export const INK3 = "#73726c";
export const INK4 = "#898781";
export const LINE = "rgba(11,11,11,0.10)";
export const SUNKEN = "#f9f9f7";
export const BG = "#f2f2ef";
export const FONT = '"PingFang SC", -apple-system, "Helvetica Neue", sans-serif';
export const MONO = '"SF Mono", Menlo, "PingFang SC", monospace';

export const inOut = Easing.bezier(0.65, 0, 0.35, 1);
export const out = Easing.bezier(0.16, 1, 0.3, 1);

/** 拍 b 落在 [a, z] 里的进度 0–1 */
export const prog = (b: number, a: number, z: number, e = inOut) =>
  interpolate(b, [a, z], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: e });

/** 按关键帧取值：keys 为 [拍, 值]，相邻两帧之间缓动 */
export function keyed(b: number, keys: [number, number][], e = inOut) {
  if (b <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [a, va] = keys[i], [z, vz] = keys[i + 1];
    if (b <= z) return va + (vz - va) * prog(b, a, z, e);
  }
  return keys[keys.length - 1][1];
}

/** 场景进出：进场 0→1，离场 1→0 */
export const inOutScene = (b: number, [a, z]: number[], fadeIn = 0.5, fadeOut = 0.4) =>
  prog(b, a, a + fadeIn, out) * (1 - prog(b, z - fadeOut, z));

export const center = (r: Rect): [number, number] => [r[0] + r[2] / 2, r[1] + r[3] / 2];
