import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

const RELEASE = "https://github.com/cloudflare/cloudflared/releases/latest/download/";

function assetName(): string {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  if (process.platform === "darwin") return `cloudflared-darwin-${arch}.tgz`;
  if (process.platform === "win32") return "cloudflared-windows-amd64.exe";
  return `cloudflared-linux-${arch}`;
}

// 优先 LOCALVPS_CLOUDFLARED_PATH，其次系统 PATH，最后下载到 ~/.localvps/bin
async function ensureCloudflared(cfg: Config): Promise<string> {
  if (process.env.LOCALVPS_CLOUDFLARED_PATH) return process.env.LOCALVPS_CLOUDFLARED_PATH;
  if (spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).status === 0) return "cloudflared";

  const binDir = path.join(cfg.homeDir, "bin");
  const bin = path.join(binDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  if (fs.existsSync(bin)) return bin;

  const asset = assetName();
  console.log(`首次运行，正在下载 cloudflared（${asset}）…`);
  fs.mkdirSync(binDir, { recursive: true });
  const resp = await fetch(RELEASE + asset);
  if (!resp.ok) throw new Error(`下载 cloudflared 失败：HTTP ${resp.status}。可手动安装后设置环境变量 LOCALVPS_CLOUDFLARED_PATH`);
  const file = asset.endsWith(".tgz") ? path.join(binDir, asset) : bin;
  fs.writeFileSync(file, Buffer.from(await resp.arrayBuffer()));
  if (file !== bin) {
    const r = spawnSync("tar", ["-xzf", file, "-C", binDir]);
    fs.rmSync(file);
    if (r.status !== 0) throw new Error("解压 cloudflared 失败");
  }
  if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
  return bin;
}

/** 启动隧道：连上时 onUrl（quick 模式每次地址不同），断开时 onDown；cloudflared 退出会自动重启。 */
export async function startTunnel(
  cfg: Config,
  onUrl: (url: string) => void,
  onDown: () => void,
): Promise<{ stop: () => void; restart: () => void }> {
  const bin = await ensureCloudflared(cfg);
  const args =
    cfg.tunnel === "cf-quick"
      ? ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${cfg.port}`]
      : ["tunnel", "--no-autoupdate", "run", "--token", cfg.cfTunnelToken];

  let stopped = false;
  let hinted = false;
  let child: ReturnType<typeof spawn>;
  const run = () => {
    child = spawn(bin, args, { windowsHide: true });
    let url = cfg.tunnel === "cloudflare" ? cfg.publicUrl : "";
    let announced = false;
    // quick tunnel 的地址会先于连接打印出来，必须等真正连上 Cloudflare 再公布。
    // 45 秒没连上就重启 cloudflared：它的重试间隔会越拉越长，网络修好后要等很久才再试。
    const hint = setTimeout(() => {
      if (announced) return;
      if (!hinted)
        console.error(
          "45 秒仍未连上 Cloudflare（出站端口 7844 不通），会持续重试。\n" +
            "若开着 Clash / Surge 等代理的 TUN（增强）模式：给 argotunnel.com 加 DIRECT 规则，或关闭 TUN。",
        );
      hinted = true;
      child.kill();
    }, 45_000);
    const onLine = (chunk: Buffer) => {
      if (announced) return;
      const text = chunk.toString();
      const quick = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (quick) url = quick[0];
      if (url && /Registered tunnel connection/.test(text)) {
        announced = true;
        clearTimeout(hint);
        onUrl(url);
      }
    };
    child.stdout?.on("data", onLine);
    child.stderr?.on("data", onLine);
    child.on("exit", (code) => {
      clearTimeout(hint);
      if (stopped) return;
      onDown();
      if (announced) console.error(`cloudflared 退出（code ${code}），5 秒后重启…`);
      setTimeout(run, 5000);
    });
  };
  run();
  return {
    stop: () => {
      stopped = true;
      child.kill();
    },
    restart: () => child.kill(),
  };
}
