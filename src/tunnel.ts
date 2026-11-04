import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

// 连不上 GitHub 时可以用 LOCALVPS_CLOUDFLARED_URL 换成镜像（末尾带 /，后面接文件名）
const RELEASE = process.env.LOCALVPS_CLOUDFLARED_URL || "https://github.com/cloudflare/cloudflared/releases/latest/download/";
const RETRY_MS = 60_000;

function assetName(): string {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  if (process.platform === "darwin") return `cloudflared-darwin-${arch}.tgz`;
  if (process.platform === "win32") return "cloudflared-windows-amd64.exe";
  return `cloudflared-linux-${arch}`;
}

const binPath = (cfg: Config) => path.join(cfg.homeDir, "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");

// 优先 LOCALVPS_CLOUDFLARED_PATH，其次系统 PATH，最后下载到 ~/.localvps/bin
async function ensureCloudflared(cfg: Config): Promise<string> {
  if (process.env.LOCALVPS_CLOUDFLARED_PATH) return process.env.LOCALVPS_CLOUDFLARED_PATH;
  if (spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).status === 0) return "cloudflared";

  const bin = binPath(cfg);
  if (fs.existsSync(bin)) return bin;

  const asset = assetName();
  const binDir = path.dirname(bin);
  console.log(`首次运行，正在下载 cloudflared（${asset}）…`);
  fs.mkdirSync(binDir, { recursive: true });
  // 先下到临时文件，完整了再改名，免得中途断网留下一个坏文件
  const tmp = path.join(binDir, `${asset}.download`);
  try {
    const resp = await fetch(RELEASE + asset, { signal: AbortSignal.timeout(300_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    fs.writeFileSync(tmp, Buffer.from(await resp.arrayBuffer()));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error(
      `下载 cloudflared 失败（${e instanceof Error ? e.message : e}），多半是连不上 GitHub。` +
        `开代理后会自动重试；也可以手动下载 ${RELEASE}${asset}` +
        (asset.endsWith(".tgz") ? `，解压出 cloudflared 放到 ${bin}` : `，改名放到 ${bin}`),
    );
  }
  if (asset.endsWith(".tgz")) {
    const r = spawnSync("tar", ["-xzf", tmp, "-C", binDir]);
    fs.rmSync(tmp, { force: true });
    if (r.status !== 0) throw new Error("解压 cloudflared 失败");
  } else {
    fs.renameSync(tmp, bin);
  }
  if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
  return bin;
}

export interface TunnelEvents {
  onUrl: (url: string) => void; // 连上了（quick 模式每次地址不同）
  onDown: () => void; // 断了，正在重连
  onError: (message: string) => void; // 连不上的原因，给控制台显示
}

/** 启动隧道。任何失败都不会抛出：报给 onError，然后自动重试。 */
export function startTunnel(cfg: Config, ev: TunnelEvents): { stop: () => void; restart: () => void } {
  const args =
    cfg.tunnel === "cf-quick"
      ? ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${cfg.port}`]
      : ["tunnel", "--no-autoupdate", "run", "--url", `http://127.0.0.1:${cfg.port}`, "--token", cfg.cfTunnelToken];

  let stopped = false;
  let child: ReturnType<typeof spawn> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const later = (ms: number) => {
    if (!stopped) retry = setTimeout(run, ms);
  };

  async function run() {
    if (stopped) return;
    let bin: string;
    try {
      bin = await ensureCloudflared(cfg);
    } catch (e) {
      ev.onError(e instanceof Error ? e.message : String(e));
      return later(RETRY_MS);
    }
    if (stopped) return;

    const proc = spawn(bin, args, { windowsHide: true });
    child = proc;
    let url = cfg.tunnel === "cloudflare" ? cfg.publicUrl : "";
    let announced = false;
    let ended = false;
    const end = (ms: number) => {
      if (ended) return;
      ended = true;
      clearTimeout(hint);
      if (child === proc) child = undefined;
      if (stopped) return;
      ev.onDown();
      later(ms);
    };
    // quick tunnel 的地址会先于连接打印出来，必须等真正连上 Cloudflare 再公布。
    // 45 秒没连上就重启 cloudflared：它的重试间隔会越拉越长，网络修好后要等很久才再试。
    const hint = setTimeout(() => {
      if (announced) return;
      ev.onError(
        "45 秒仍未连上 Cloudflare（出站端口 7844 不通），会持续重试。" +
          "开着 Clash、Surge 这类代理的 TUN（增强）模式时，给 argotunnel.com 加 DIRECT 规则，或关闭 TUN。",
      );
      proc.kill();
    }, 45_000);
    const onLine = (chunk: Buffer) => {
      if (announced) return;
      const text = chunk.toString();
      const quick = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (quick) url = quick[0];
      if (url && /Registered tunnel connection/.test(text)) {
        announced = true;
        clearTimeout(hint);
        ev.onUrl(url);
      }
    };
    proc.stdout?.on("data", onLine);
    proc.stderr?.on("data", onLine);
    proc.on("error", (e) => {
      ev.onError(`cloudflared 启动失败：${e.message}（${bin}）`);
      end(RETRY_MS);
    });
    proc.on("exit", (code) => {
      if (announced && !stopped) console.error(`cloudflared 退出（code ${code}），5 秒后重启…`);
      end(5000);
    });
  }

  run();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(retry);
      child?.kill();
    },
    // 正在跑就杀掉让它按新地址重开；在等重试就立刻重试
    restart: () => {
      if (child) return void child.kill();
      clearTimeout(retry);
      run();
    },
  };
}
