import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import si from "systeminformation";

export interface LogEntry {
  time: string;
  tool?: string;
  event?: string;
  args?: object;
  error?: boolean;
  ms?: number;
  ip?: string;
}

export interface Sample {
  t: number;
  cpu: number; // %
  memUsed: number; // bytes
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  rx: number; // bytes/s
  tx: number;
}

const MAX_LOGS = 200;
const MAX_SAMPLES = 100; // 3 秒一个点 ≈ 5 分钟

// 进程内共享的运行状态：MCP 服务、隧道、面板都读写它
export const runtime = {
  startedAt: Date.now(),
  publicUrl: "",
  tunnel: "connecting" as "connecting" | "online" | "local" | "error",
  tunnelError: "", // 隧道连不上的原因，控制台显示
  paused: false,
  logs: [] as LogEntry[],
  samples: [] as Sample[],
  restartTunnel: () => {},
  applyTunnel: async () => {}, // 隧道配置改了之后按新配置重开
  setKeepAwake: (_on: boolean) => {},
  closers: [] as (() => void)[], // 自我更新重启前要关掉的服务
  update: {
    latest: null as null | { version: string; notes: string; page: string; assets: Record<string, string> },
    status: "idle" as "idle" | "checking" | "updating" | "error",
    progress: 0, // 下载新版本的进度 0～1
    error: "",
    checkedAt: 0,
  },
  checkUpdate: async () => {},
  runUpdate: async () => {},
};

export function audit(homeDir: string, entry: Omit<LogEntry, "time">) {
  const full = { time: new Date().toISOString(), ...entry };
  runtime.logs.push(full);
  if (runtime.logs.length > MAX_LOGS) runtime.logs.shift();
  fs.appendFile(path.join(homeDir, "audit.log"), JSON.stringify(full) + "\n", () => {});
}

/** 出错写进 ~/.localvps/error.log：Windows 双击运行时窗口一关，报错就看不见了 */
export function logError(message: string) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    const dir = path.join(os.homedir(), ".localvps");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "error.log");
    // 带 BOM，Windows 自带的 PowerShell 5.1、老记事本才认得出是 UTF-8
    if (!fs.existsSync(file)) fs.writeFileSync(file, "\ufeff");
    fs.appendFileSync(file, line);
  } catch {
    // 写不了日志也不影响运行
  }
  console.error(message);
}

export function startSampler() {
  if (process.platform === "win32") si.powerShellStart();
  const diskPath = os.homedir();
  const tick = async () => {
    try {
      const [load, mem, net, disk] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.networkStats(),
        fs.promises.statfs(diskPath),
      ]);
      const diskTotal = disk.blocks * disk.bsize;
      runtime.samples.push({
        t: Date.now(),
        cpu: Math.round(load.currentLoad * 10) / 10,
        memUsed: mem.active,
        memTotal: mem.total,
        diskUsed: diskTotal - disk.bavail * disk.bsize,
        diskTotal,
        rx: Math.max(0, net[0]?.rx_sec || 0),
        tx: Math.max(0, net[0]?.tx_sec || 0),
      });
      if (runtime.samples.length > MAX_SAMPLES) runtime.samples.shift();
    } catch {
      // 采样失败只影响监控图，不影响服务
    }
  };
  tick();
  setInterval(tick, 3000).unref();
}
