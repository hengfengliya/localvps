#!/usr/bin/env node
import { spawn } from "node:child_process";
import { loadConfig, type Config } from "./config.js";
import { initMachine, startPanel } from "./panel.js";
import { logError, runtime, startSampler } from "./runtime.js";
import { startServer } from "./server.js";
import { startTunnel } from "./tunnel.js";
import { canSelfUpdate, checkUpdate, cleanupOld, installUpdate, rollback } from "./update.js";
import { VERSION } from "./version.js";

const LEVEL = {
  readonly: "只读：仅能读取工作目录",
  workspace: "工作目录读写：不能执行命令、不能出工作目录",
  full: "完全权限：任意路径读写 + 执行任意命令（等于把整台电脑交给持有令牌的人）",
};

// 运行期间阻止系统休眠；随本进程退出
function keepAwake(): (() => void) | undefined {
  if (process.platform === "darwin") {
    const c = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
    c.on("error", () => {});
    return () => c.kill();
  }
  if (process.platform === "win32") {
    const ps =
      `Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';` +
      `[W.P]::SetThreadExecutionState(0x80000001) | Out-Null; while ($true) { Start-Sleep 3600 }`;
    const c = spawn("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore", windowsHide: true });
    c.on("error", () => {});
    return () => c.kill();
  }
}

function openBrowser(url: string) {
  const [bin, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(bin, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

function printConnectInfo(cfg: Config, base: string, panel: string) {
  const url = `${base}/mcp`;
  console.log(`
==================== localvps 已就绪 ====================
配置：    ${cfg.envFile}
控制台：  ${panel}（只能在本机打开）
MCP 地址：${url}${cfg.tunnel === "none" ? "" : `\n远程查看：${base}/view?k=${cfg.viewKey}（只能看，不能改设置）`}
令牌：    ${cfg.token}
权限：    ${cfg.permission}（${LEVEL[cfg.permission]}）
工作目录：${cfg.workdir}

▶ Claude Code：
claude mcp add --transport http localvps ${url} --header "Authorization: Bearer ${cfg.token}"

▶ Codex（追加到 ~/.codex/config.toml）：
[mcp_servers.localvps]
url = "${url}"
http_headers = { Authorization = "Bearer ${cfg.token}" }
${cfg.tunnel === "cf-quick" ? "\n注意：临时隧道每次启动地址都会变。要固定地址，在控制台「设置 → 隧道」里改成固定域名。\n" : ""}=========================================================
`);
}

// 自我更新：换好文件后关掉自己的服务，在同一个窗口里起新版本，本进程只负责转发信号、等它退出。
// 新版本 20 秒内就异常退出，换回旧文件再起一次，免得机器没人管。
function restartInto(exe: string, stops: (() => void)[]) {
  stops.forEach((s) => s());
  runtime.closers.forEach((c) => c());
  console.log("\n已更新，正在启动新版本…\n");
  let child: ReturnType<typeof spawn>;
  const launch = (rolledBack: boolean) => {
    const startedAt = Date.now();
    child = spawn(exe, [], { stdio: "inherit", env: process.env });
    child.on("error", (e) => logError(`启动新版本失败：${e.message}`));
    child.on("exit", (code) => {
      if (!rolledBack && code !== 0 && Date.now() - startedAt < 20_000 && rollback(exe)) {
        logError(`新版本启动后马上退出了（退出码 ${code}），已换回旧版本`);
        return launch(true);
      }
      process.exit(code ?? 0);
    });
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.removeAllListeners(sig).on(sig, () => child?.kill(sig));
  setTimeout(() => launch(false), 1000);
}

async function main() {
  if (process.argv.includes("--version")) {
    console.log(VERSION);
    process.exit(0);
  }
  const cfg = loadConfig();
  console.log(`localvps ${VERSION}`);
  await initMachine(cfg);
  await startServer(cfg);
  startSampler();
  const panel = await startPanel(cfg);
  const local = `http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${cfg.port}`;
  console.log(`本地服务已启动：${local}\n控制台：${panel}`);
  if (cfg.openPanel) openBrowser(panel);

  let stopAwake: (() => void) | undefined;
  runtime.setKeepAwake = (on) => {
    stopAwake?.();
    stopAwake = on ? keepAwake() : undefined;
  };
  runtime.setKeepAwake(cfg.keepAwake);

  // 隧道可以在面板里换模式，换了就停掉旧的、按新配置重开
  let tunnel: { stop: () => void; restart: () => void } | undefined;
  runtime.restartTunnel = () => tunnel?.restart();
  runtime.applyTunnel = async () => {
    tunnel?.stop();
    tunnel = undefined;
    if (cfg.tunnel === "none") {
      runtime.tunnel = "local";
      runtime.publicUrl = local;
      return printConnectInfo(cfg, local, panel);
    }
    runtime.tunnel = "connecting";
    runtime.tunnelError = "";
    runtime.publicUrl = "";
    console.log("正在建立隧道…");
    tunnel = startTunnel(cfg, {
      onUrl: (url) => {
        runtime.tunnel = "online";
        runtime.tunnelError = "";
        runtime.publicUrl = url;
        printConnectInfo(cfg, url, panel);
      },
      onDown: () => {
        if (runtime.tunnel !== "error") runtime.tunnel = "connecting";
        if (cfg.tunnel === "cf-quick") runtime.publicUrl = "";
      },
      onError: (message) => {
        runtime.tunnel = "error";
        runtime.tunnelError = message;
        logError(message);
      },
    });
  };
  await runtime.applyTunnel();
  const stops = [() => tunnel?.stop(), () => stopAwake?.()];

  runtime.checkUpdate = async () => {
    if (runtime.update.status === "updating") return;
    runtime.update.status = "checking";
    try {
      runtime.update.latest = await checkUpdate();
      runtime.update.status = "idle";
      runtime.update.error = "";
      if (runtime.update.latest) console.log(`发现新版本 ${runtime.update.latest.version}，在控制台点「更新」即可。`);
    } catch (e) {
      // 连不上 GitHub 很常见，不打扰，只在设置里显示
      runtime.update.status = "error";
      runtime.update.error = `检查更新失败：${e instanceof Error ? e.message : e}`;
    }
    runtime.update.checkedAt = Date.now();
  };
  runtime.runUpdate = async () => {
    const rel = runtime.update.latest;
    if (!rel || !canSelfUpdate()) return;
    runtime.update.status = "updating";
    runtime.update.error = "";
    console.log(`正在下载新版本 ${rel.version}…`);
    try {
      runtime.update.progress = 0;
      restartInto(await installUpdate(rel, (p) => (runtime.update.progress = p)), stops);
    } catch (e) {
      runtime.update.status = "error";
      runtime.update.error = e instanceof Error ? e.message : String(e);
      logError(`更新失败：${runtime.update.error}`);
    }
  };
  // 稳定跑 30 秒再删上次更新留下的备份：这之前出事，外层进程还要靠它回滚
  setTimeout(cleanupOld, 30_000).unref();
  setTimeout(() => void runtime.checkUpdate(), 5000);
  setInterval(() => void runtime.checkUpdate(), 6 * 3600_000).unref();

  const exit = () => {
    stops.forEach((s) => s());
    process.exit(0);
  };
  process.on("SIGINT", exit);
  process.on("SIGTERM", exit);
}

// 意外错误只记日志不退出：服务和控制台继续跑，比整个进程悄悄消失好查
process.on("uncaughtException", (e) => logError(`意外错误：${e.stack || e}`));
process.on("unhandledRejection", (e) => logError(`意外错误：${e instanceof Error ? e.stack : e}`));

main().catch(async (e) => {
  logError(`启动失败：${e instanceof Error ? e.message : e}`);
  // Windows 双击运行时窗口会立刻关掉，停一下让人看清报错
  if (process.platform === "win32" && process.stdin.isTTY) {
    process.stdout.write("\n按回车键退出…");
    await new Promise((r) => process.stdin.once("data", r));
  }
  process.exit(1);
});
