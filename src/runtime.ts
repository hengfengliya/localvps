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
  tunnel: "connecting" as "connecting" | "online" | "local",
  paused: false,
  logs: [] as LogEntry[],
  samples: [] as Sample[],
  restartTunnel: () => {},
  applyTunnel: async () => {}, // 隧道配置改了之后按新配置重开
  setKeepAwake: (_on: boolean) => {},
};

export function audit(homeDir: string, entry: Omit<LogEntry, "time">) {
  const full = { time: new Date().toISOString(), ...entry };
  runtime.logs.push(full);
  if (runtime.logs.length > MAX_LOGS) runtime.logs.shift();
  fs.appendFile(path.join(homeDir, "audit.log"), JSON.stringify(full) + "\n", () => {});
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
