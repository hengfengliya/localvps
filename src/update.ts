import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { downloadFile, fetchSmart } from "./net.js";
import { VERSION } from "./version.js";

const LATEST = process.env.LOCALVPS_UPDATE_URL || "https://api.github.com/repos/hengfengliya/localvps/releases/latest";

export interface Release {
  version: string;
  notes: string;
  page: string;
  assets: Record<string, string>; // 文件名 → 下载地址
}

/** 单文件版才能自己换自己；用 node 跑源码时只提示 */
export const canSelfUpdate = () =>
  /localvps/i.test(path.basename(process.execPath)) && (process.platform === "darwin" || process.platform === "win32");

function assetName(): string {
  if (process.platform === "win32") return "localvps-windows-x64.exe";
  return `localvps-macos-${process.arch === "arm64" ? "arm64" : "x64"}.zip`;
}

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/** 有新版本返回它，没有返回 null；网络不通会抛错 */
export async function checkUpdate(): Promise<Release | null> {
  const r = await fetchSmart(LATEST, { headers: { accept: "application/vnd.github+json", "user-agent": `localvps/${VERSION}` } }, 15_000);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as { tag_name: string; body?: string; html_url: string; assets: { name: string; browser_download_url: string }[] };
  const version = j.tag_name.replace(/^v/, "");
  if (!newer(version, VERSION)) return null;
  return {
    version,
    notes: (j.body || "").slice(0, 2000),
    page: j.html_url,
    assets: Object.fromEntries(j.assets.map((a) => [a.name, a.browser_download_url])),
  };
}

async function download(url: string, onProgress?: (p: number) => void): Promise<Buffer> {
  try {
    return await downloadFile(url, onProgress);
  } catch (e) {
    throw new Error(`下载失败（${e instanceof Error ? e.message : e}）：${url}`);
  }
}

/**
 * 下载新版、按 SHA256SUMS.txt 校验，然后换掉正在运行的文件，返回要重启的路径。
 * Windows 不能覆盖运行中的 exe，但可以改名：旧的改成 .old，新的放回原名。
 */
export async function installUpdate(rel: Release, onProgress?: (p: number) => void): Promise<string> {
  const name = assetName();
  if (!rel.assets[name] || !rel.assets["SHA256SUMS.txt"]) throw new Error(`新版本里没有 ${name}`);
  const sums = await download(rel.assets["SHA256SUMS.txt"]);
  const file = await download(rel.assets[name], onProgress);
  const want = sums.toString("utf8").split(/\r?\n/).find((l) => l.trim().endsWith(name))?.split(/\s+/)[0];
  const got = createHash("sha256").update(file).digest("hex");
  if (!want || want !== got) throw new Error("新版本校验没通过（SHA256 对不上），没有替换");

  const exe = process.execPath;
  // Windows 上文件名不以 .exe 结尾就运行不了，临时文件叫 localvps.new.exe
  const staged = process.platform === "win32" ? exe.replace(/\.exe$/i, "") + ".new.exe" : `${exe}.new`;
  // 新文件先跑一下 --version，跑不起来（比如被杀毒软件拦了）就不替换
  const preflight = (file: string) => {
    const r = spawnSync(file, ["--version"], { timeout: 30_000, windowsHide: true });
    const out = r.stdout?.toString().trim();
    if (r.status !== 0 || out !== rel.version) {
      fs.rmSync(file, { force: true });
      throw new Error(`新版本试运行失败（${r.error?.message || out || `退出码 ${r.status}`}），没有替换；被杀毒软件拦截时也会这样`);
    }
  };
  if (name.endsWith(".zip")) {
    const dir = `${exe}.unzip`;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    const zip = path.join(dir, name);
    fs.writeFileSync(zip, file);
    const r = spawnSync("ditto", ["-x", "-k", zip, dir]);
    if (r.status !== 0) throw new Error("解压新版本失败");
    fs.renameSync(path.join(dir, "localvps"), staged);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.chmodSync(staged, 0o755);
    preflight(staged);
    fs.copyFileSync(exe, `${exe}.old`); // 留一份，新版本起不来时回滚
    fs.renameSync(staged, exe);
  } else {
    fs.writeFileSync(staged, file);
    preflight(staged);
    fs.rmSync(`${exe}.old`, { force: true });
    fs.renameSync(exe, `${exe}.old`);
    fs.renameSync(staged, exe);
  }
  return exe;
}

/** 新版本起不来时换回旧文件；返回能不能回滚 */
export function rollback(exe: string): boolean {
  if (!fs.existsSync(`${exe}.old`)) return false;
  try {
    fs.rmSync(`${exe}.failed`, { force: true });
    fs.renameSync(exe, `${exe}.failed`);
    fs.renameSync(`${exe}.old`, exe);
    return true;
  } catch {
    return false;
  }
}

/** 启动时清掉上次更新留下的旧文件（Windows 上旧进程还在用时删不掉，下次再删） */
export function cleanupOld() {
  try {
    fs.rmSync(`${process.execPath}.failed`, { force: true });
    fs.rmSync(`${process.execPath}.old`, { force: true });
  } catch {
    // 下次再说
  }
}
