import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Config, expandHome } from "./config.js";
import { VERSION } from "./version.js";

const MAX_READ = 256 * 1024;
const MAX_OUTPUT = 30_000;
const MAX_OUTPUT_BYTES = MAX_OUTPUT * 4;

// Windows 命令行输出用的是系统代码页（中文系统是 GBK），不是 UTF-8
const CODEPAGES: Record<string, string> = {
  "936": "gbk", "54936": "gb18030", "950": "big5", "932": "shift_jis", "949": "euc-kr",
  "866": "ibm866", "1250": "windows-1250", "1251": "windows-1251", "1252": "windows-1252",
  "437": "windows-1252", "850": "windows-1252",
};
let consoleDecoder: TextDecoder | null = null;
function legacyDecoder(): TextDecoder {
  if (consoleDecoder) return consoleDecoder;
  let label = "utf-8";
  if (process.platform === "win32") {
    try {
      const out = spawnSync("cmd.exe", ["/c", "chcp"], { windowsHide: true }).stdout?.toString("latin1") || "";
      label = CODEPAGES[out.match(/(\d+)\s*$/)?.[1] || ""] || label;
    } catch {
      // 拿不到就按 UTF-8
    }
  }
  return (consoleDecoder = new TextDecoder(label));
}

// 先当 UTF-8 解；不是合法 UTF-8 再按系统代码页解
function decode(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return legacyDecoder().decode(buf);
  }
}

// 按原始字节收集输出（一个字可能被拆在两段里），只留最后一段，截掉时注明
function collector() {
  let buf = Buffer.alloc(0);
  let total = 0;
  return {
    push(d: Buffer) {
      total += d.length;
      buf = Buffer.concat([buf, d]);
      if (buf.length > MAX_OUTPUT_BYTES) buf = buf.subarray(buf.length - MAX_OUTPUT_BYTES);
    },
    text() {
      let b = buf;
      let cut = total > b.length;
      if (cut) while (b.length && (b[0] & 0xc0) === 0x80) b = b.subarray(1); // 去掉被截断的半个 UTF-8 字符
      let s = decode(b);
      if (s.length > MAX_OUTPUT) {
        s = s.slice(-MAX_OUTPUT);
        cut = true;
      }
      return cut ? `[earlier output omitted: ${total} bytes in total, showing the end]\n${s}` : s;
    },
  };
}

// 超时要杀整棵进程树：只杀 shell 的话，它起的子进程还占着输出管道，调用会一直等
function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // 已经结束了
  }
}

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

// 取路径上最深的已存在祖先做 realpath，防止用符号链接跳出工作目录
async function realpathLoose(abs: string): Promise<string> {
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

export function buildServer(cfg: Config, audit: (entry: object) => void): McpServer {
  const shell = process.platform === "win32" ? "PowerShell" : "bash/zsh";
  const server = new McpServer(
    { name: "localvps", version: VERSION },
    {
      instructions:
        `This MCP server runs on a ${os.type()} ${os.release()} (${os.arch()}) machine, host "${os.hostname()}". ` +
        `Permission level: ${cfg.permission}. Working directory: ${cfg.workdir}. ` +
        (cfg.permission === "full"
          ? `run_command executes in ${shell}; any absolute path is allowed.`
          : `File access is confined to the working directory; run_command is not available.`) +
        ` Relative paths resolve against the working directory.`,
    },
  );

  const resolve = async (p: string) => {
    const abs = path.resolve(cfg.workdir, expandHome(p));
    if (cfg.permission === "full") return abs;
    const root = norm(await fs.realpath(cfg.workdir));
    const real = norm(await realpathLoose(abs));
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`路径超出工作目录：${p}`);
    return abs;
  };

  // 统一包一层：记审计日志、把异常转成工具错误
  const wrap = <A>(name: string, fn: (args: A) => Promise<Result>) => async (args: A): Promise<Result> => {
    const started = Date.now();
    let res: Result;
    try {
      res = await fn(args);
    } catch (e) {
      res = fail(e instanceof Error ? e.message : String(e));
    }
    const brief = Object.fromEntries(
      Object.entries(args as object).map(([k, v]) => [k, typeof v === "string" && v.length > 500 ? v.slice(0, 500) + "…" : v]),
    );
    audit({ tool: name, args: brief, error: !!res.isError, ms: Date.now() - started });
    return res;
  };

  server.registerTool(
    "list_dir",
    { description: "List entries of a directory (dirs end with /).", inputSchema: { path: z.string().default(".") } },
    wrap("list_dir", async ({ path: p }: { path: string }) => {
      const entries = await fs.readdir(await resolve(p), { withFileTypes: true });
      return ok(entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).sort().join("\n") || "(empty)");
    }),
  );

  server.registerTool(
    "read_file",
    {
      description: `Read a UTF-8 text file. Returns at most ${MAX_READ} bytes starting at byte offset.`,
      inputSchema: { path: z.string(), offset: z.number().int().min(0).default(0) },
    },
    wrap("read_file", async ({ path: p, offset }: { path: string; offset: number }) => {
      const fh = await fs.open(await resolve(p), "r");
      try {
        const { size } = await fh.stat();
        const buf = Buffer.alloc(Math.max(0, Math.min(MAX_READ, size - offset)));
        await fh.read(buf, 0, buf.length, offset);
        const more = offset + buf.length < size ? `\n\n[truncated: ${size} bytes total, continue with offset=${offset + buf.length}]` : "";
        return ok(buf.toString("utf8") + more);
      } finally {
        await fh.close();
      }
    }),
  );

  if (cfg.permission !== "readonly") {
    server.registerTool(
      "write_file",
      {
        description: "Create or overwrite a text file (parent directories are created).",
        inputSchema: { path: z.string(), content: z.string() },
      },
      wrap("write_file", async ({ path: p, content }: { path: string; content: string }) => {
        const abs = await resolve(p);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf8");
        return ok(`wrote ${Buffer.byteLength(content)} bytes to ${abs}`);
      }),
    );

    server.registerTool(
      "edit_file",
      {
        description: "Replace an exact, unique occurrence of old_string with new_string in a file.",
        inputSchema: { path: z.string(), old_string: z.string(), new_string: z.string() },
      },
      wrap("edit_file", async ({ path: p, old_string, new_string }: { path: string; old_string: string; new_string: string }) => {
        const abs = await resolve(p);
        const text = await fs.readFile(abs, "utf8");
        const count = text.split(old_string).length - 1;
        if (count !== 1) return fail(`old_string must occur exactly once, found ${count}`);
        await fs.writeFile(abs, text.replace(old_string, () => new_string), "utf8");
        return ok(`edited ${abs}`);
      }),
    );
  }

  if (cfg.permission === "full") {
    server.registerTool(
      "run_command",
      {
        description: `Run a shell command (${shell}) and return exit code, stdout and stderr.`,
        inputSchema: {
          command: z.string(),
          cwd: z.string().optional(),
          timeout_sec: z.number().int().min(1).max(3600).default(120),
        },
      },
      wrap("run_command", async ({ command, cwd, timeout_sec }: { command: string; cwd?: string; timeout_sec: number }) => {
        // Windows PowerShell 不会把原生程序的退出码传出来，末尾补一句
        const [bin, args] =
          process.platform === "win32"
            ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
                `${command}\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }`]]
            : [process.env.SHELL || "/bin/bash", ["-lc", command]];
        const dir = cwd ? await resolve(cwd) : cfg.workdir;
        return new Promise<Result>((done) => {
          // 非 Windows 放进单独的进程组，超时能一起杀掉
          const child = spawn(bin, args, { cwd: dir, windowsHide: true, detached: process.platform !== "win32" });
          const out = collector();
          const err = collector();
          child.stdout.on("data", (d: Buffer) => out.push(d));
          child.stderr.on("data", (d: Buffer) => err.push(d));
          let timedOut = false;
          let finished = false;
          const finish = (head: string, success: boolean) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            const text = `${head}\n--- stdout ---\n${out.text()}\n--- stderr ---\n${err.text()}`;
            done(success ? ok(text) : fail(text));
          };
          const timer = setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
            // 万一还有进程占着管道，2 秒后不再等
            setTimeout(() => finish(`timed out after ${timeout_sec}s, process tree killed`, false), 2000);
          }, timeout_sec * 1000);
          child.on("error", (e) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            done(fail(e.message));
          });
          child.on("close", (code) => {
            if (timedOut) return finish(`timed out after ${timeout_sec}s, process tree killed`, false);
            finish(`exit code ${code}`, code === 0);
          });
        });
      }),
    );
  }

  return server;
}
