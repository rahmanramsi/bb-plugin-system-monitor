// bb-plugin-system-monitor — live CPU, memory, swap, disk, and process stats
// for the machine that runs the BB server, plus the resource use of BB itself.
//
// Sampling only runs while someone watches: the sidebar page (app.tsx) renews a
// short lease while it is open and visible, and the sampler sleeps without one.
// While it runs, it keeps a short history in memory and publishes each sample
// over realtime. The `bb system-monitor` CLI takes one reading on demand.
import { execFile } from "node:child_process";
import { statfs, readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  APP_GROUP_LABELS,
  STATS_CHANNEL,
  WATCH_LEASE_MS,
  formatBytes,
  formatUptime,
} from "./lib/format";

const run = promisify(execFile);

const processSchema = z.object({
  pid: z.number(),
  name: z.string(),
  cpuPct: z.number(),
  memBytes: z.number(),
});

const appGroupSchema = z.enum(["ui", "server", "daemon", "agents"]);
export type AppGroup = z.infer<typeof appGroupSchema>;

const appProcessSchema = processSchema.extend({
  group: appGroupSchema,
  detail: z.string(),
});

const appSchema = z.object({
  rootPid: z.number(),
  cpuPct: z.number(),
  memBytes: z.number(),
  processCount: z.number(),
  groups: z.array(
    z.object({
      group: appGroupSchema,
      cpuPct: z.number(),
      memBytes: z.number(),
      processCount: z.number(),
    }),
  ),
  processes: z.array(appProcessSchema),
});
export type AppUsage = z.infer<typeof appSchema>;

const snapshotSchema = z.object({
  at: z.string(),
  hostname: z.string(),
  platform: z.string(),
  osRelease: z.string(),
  arch: z.string(),
  uptimeSec: z.number(),
  cpu: z.object({
    model: z.string(),
    cores: z.number(),
    usagePct: z.number(),
    perCorePct: z.array(z.number()),
    loadAvg: z.array(z.number()),
  }),
  memory: z.object({
    totalBytes: z.number(),
    usedBytes: z.number(),
    swapTotalBytes: z.number(),
    swapUsedBytes: z.number(),
  }),
  disk: z
    .object({
      path: z.string(),
      totalBytes: z.number(),
      usedBytes: z.number(),
    })
    .nullable(),
  processes: z.array(processSchema),
  /** BB's own process tree; null when it cannot be identified. */
  app: appSchema.nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

const historyPointSchema = z.object({
  at: z.string(),
  cpuPct: z.number(),
  memPct: z.number(),
  /** BB's CPU use as a share of the whole machine (0–100). */
  appCpuPct: z.number(),
});
export type HistoryPoint = z.infer<typeof historyPointSchema>;

const statsOutput = z.object({
  snapshot: snapshotSchema.nullable(),
  history: z.array(historyPointSchema),
  intervalSeconds: z.number(),
});

export const rpcContract = defineRpcContract({
  /** Latest readings without starting the sampler. */
  stats_get: { input: z.null(), output: statsOutput },
  /** Latest readings, and keep sampling for WATCH_LEASE_MS more. */
  stats_watch: { input: z.null(), output: statsOutput },
});

/** The process table is the costliest read (one `ps` over every process). */
const PROCESS_REFRESH_MS = 5_000;
const DISK_REFRESH_MS = 60_000;
/** Shortest CPU window for an on-demand reading. */
const CPU_WINDOW_MS = 500;


const HISTORY_LENGTH = 90;
const TOP_PROCESSES = 8;
const TOP_APP_PROCESSES = 12;

// ---------------------------------------------------------------- sampling

type CpuTimes = { idle: number; total: number };

function readCpuTimes(): CpuTimes[] {
  return os.cpus().map(({ times }) => ({
    idle: times.idle,
    total: times.user + times.nice + times.sys + times.idle + times.irq,
  }));
}

function usageBetween(prev: CpuTimes, next: CpuTimes): number {
  const total = next.total - prev.total;
  if (total <= 0) return 0;
  return clampPct(100 * (1 - (next.idle - prev.idle) / total));
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

type MemoryInfo = Snapshot["memory"];

/**
 * os.freemem() on macOS counts only completely free pages, so it reports
 * memory as nearly full. Mirror Activity Monitor instead: app memory + wired
 * + compressed.
 */
async function readMemoryDarwin(): Promise<MemoryInfo> {
  const totalBytes = os.totalmem();
  const { stdout } = await run("vm_stat");
  const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 4096);
  const pages = (label: string) =>
    Number(new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0);
  const used =
    (pages("Anonymous pages") -
      pages("Pages purgeable") +
      pages("Pages wired down") +
      pages("Pages occupied by compressor")) *
    pageSize;

  let swapTotalBytes = 0;
  let swapUsedBytes = 0;
  try {
    const swap = (await run("sysctl", ["-n", "vm.swapusage"])).stdout;
    const mb = (label: string) =>
      Number(new RegExp(`${label} = ([\\d.]+)M`).exec(swap)?.[1] ?? 0) * 1024 * 1024;
    swapTotalBytes = mb("total");
    swapUsedBytes = mb("used");
  } catch {
    // Swap stats are optional.
  }
  return {
    totalBytes,
    usedBytes: Math.min(totalBytes, Math.max(0, used)),
    swapTotalBytes,
    swapUsedBytes,
  };
}

async function readMemoryLinux(): Promise<MemoryInfo> {
  const text = await readFile("/proc/meminfo", "utf8");
  const kb = (label: string) =>
    Number(new RegExp(`^${label}:\\s+(\\d+) kB`, "m").exec(text)?.[1] ?? 0) * 1024;
  const totalBytes = kb("MemTotal") || os.totalmem();
  const available = kb("MemAvailable") || os.freemem();
  const swapTotalBytes = kb("SwapTotal");
  return {
    totalBytes,
    usedBytes: totalBytes - available,
    swapTotalBytes,
    swapUsedBytes: swapTotalBytes - kb("SwapFree"),
  };
}

async function readMemory(): Promise<MemoryInfo> {
  try {
    if (process.platform === "darwin") return await readMemoryDarwin();
    if (process.platform === "linux") return await readMemoryLinux();
  } catch {
    // Fall through to the portable numbers.
  }
  const totalBytes = os.totalmem();
  return {
    totalBytes,
    usedBytes: totalBytes - os.freemem(),
    swapTotalBytes: 0,
    swapUsedBytes: 0,
  };
}

async function readDisk(): Promise<Snapshot["disk"]> {
  // On macOS "/" is the sealed system volume; user data lives on the Data volume.
  const candidates =
    process.platform === "darwin" ? ["/System/Volumes/Data", "/"] : ["/"];
  for (const path of candidates) {
    try {
      const stats = await statfs(path);
      const totalBytes = stats.blocks * stats.bsize;
      return { path, totalBytes, usedBytes: totalBytes - stats.bavail * stats.bsize };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

type ProcessRow = {
  pid: number;
  ppid: number;
  cpuPct: number;
  memBytes: number;
  command: string;
  name: string;
};

/** Display name for a command line whose executable path may contain spaces. */
function processName(command: string): string {
  const bundle = /\.app\/Contents\/MacOS\/(.+?)(?= --| \/|$)/.exec(command);
  if (bundle !== null) return bundle[1]!;
  const executable = command.split(" ")[0] ?? command;
  return executable.split("/").pop() || executable;
}

async function readProcessTable(): Promise<ProcessRow[]> {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await run("ps", ["-Ao", "pid=,ppid=,pcpu=,rss=,command="], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const rows: ProcessRow[] = [];
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
      if (match === null) continue;
      const command = match[5]!.trim();
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        cpuPct: Number(match[3]),
        memBytes: Number(match[4]) * 1024,
        command,
        name: processName(command),
      });
    }
    return rows;
  } catch {
    return [];
  }
}

function topProcesses(rows: ProcessRow[]): Snapshot["processes"] {
  return [...rows]
    .sort((a, b) => b.cpuPct - a.cpuPct)
    .slice(0, TOP_PROCESSES)
    .map(({ pid, name, cpuPct, memBytes }) => ({ pid, name, cpuPct, memBytes }));
}

/** BB's own helper scripts, keyed by file name. */
const BB_SCRIPTS: Record<string, { label: string; group: AppGroup }> = {
  "index.js": { label: "Server", group: "server" },
  "bb-app-bridge.mjs": { label: "App bridge", group: "ui" },
  "daemon-bundle.mjs": { label: "Host daemon", group: "daemon" },
  "bb-plugin-host-worker.mjs": { label: "Plugin host worker", group: "daemon" },
  "bb-provider-bridge-worker.mjs": { label: "Provider bridge", group: "daemon" },
  "bb-parcel-watcher-child.mjs": { label: "File watcher", group: "daemon" },
};

/**
 * BB's process tree: the outermost ancestor of this server process that runs
 * the same executable (the desktop app, or the server itself when headless),
 * and everything below it. Agents, shells, and tools started for threads are
 * descendants of the host daemon, so they count toward BB as well.
 */
function readAppUsage(rows: ProcessRow[]): AppUsage | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const self = byPid.get(process.pid);
  if (self === undefined) return null;
  const executable = process.execPath;
  let root = self;
  for (let parent = byPid.get(root.ppid); parent !== undefined; parent = byPid.get(parent.ppid)) {
    if (!parent.command.startsWith(executable)) break;
    root = parent;
  }

  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list === undefined) children.set(row.ppid, [row]);
    else list.push(row);
  }

  const processes: AppUsage["processes"] = [];
  const visit = (row: ProcessRow, inherited: AppGroup | null) => {
    let group: AppGroup;
    let name = row.name;
    let detail = "";
    const isBb = row.command.startsWith(executable);
    if (isBb) {
      const script = /\/([^/\s]+\.m?js)(?:\s|$)/.exec(row.command)?.[1];
      const known = script === undefined ? undefined : BB_SCRIPTS[script];
      if (row.pid === process.pid) {
        group = "server";
        name = "Server";
      } else if (known !== undefined) {
        group = known.group;
        name = known.label;
        detail = /plugin-host-artifacts\/([^/\s]+)/.exec(row.command)?.[1] ?? "";
      } else {
        group = inherited ?? "ui";
        name = row.pid === root.pid ? "BB app" : row.name;
        detail = /--type=(\S+)/.exec(row.command)?.[1] ?? "";
      }
    } else {
      // Electron helpers stay with the desktop app; anything the daemon
      // starts for a thread is agent work.
      group = inherited === "daemon" || inherited === "agents" ? "agents" : (inherited ?? "ui");
      detail = /--type=(\S+)/.exec(row.command)?.[1] ?? row.command.slice(0, 160);
    }
    processes.push({
      pid: row.pid,
      name,
      group,
      detail,
      cpuPct: row.cpuPct,
      memBytes: row.memBytes,
    });
    for (const child of children.get(row.pid) ?? []) visit(child, group);
  };
  visit(root, null);

  const groups = (["ui", "server", "daemon", "agents"] as const).map((group) => {
    const members = processes.filter((p) => p.group === group);
    return {
      group,
      cpuPct: round1(members.reduce((sum, p) => sum + p.cpuPct, 0)),
      memBytes: members.reduce((sum, p) => sum + p.memBytes, 0),
      processCount: members.length,
    };
  });
  return {
    rootPid: root.pid,
    cpuPct: round1(processes.reduce((sum, p) => sum + p.cpuPct, 0)),
    memBytes: processes.reduce((sum, p) => sum + p.memBytes, 0),
    processCount: processes.length,
    groups,
    processes: processes
      .sort((a, b) => b.cpuPct - a.cpuPct || b.memBytes - a.memBytes)
      .slice(0, TOP_APP_PROCESSES),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ------------------------------------------------------------------ plugin

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    intervalSeconds: {
      type: "number",
      label: "Sample interval (seconds)",
      description:
        "How often to sample the machine while the System monitor page is open. Nothing is sampled while it is closed.",
      experimental_schema: z.number().int().min(1).max(60),
      default: 2,
    },
  });
  let { intervalSeconds } = await settings.get();
  settings.onChange((next) => {
    intervalSeconds = next.intervalSeconds;
  });

  let previousCpu = readCpuTimes();
  let previousCpuAt = Date.now();
  let latest = null as Snapshot | null;
  const history: HistoryPoint[] = [];
  let processCache: { at: number; rows: ProcessRow[] } | null = null;
  let diskCache: { at: number; disk: Snapshot["disk"] } | null = null;

  async function cachedProcessRows(): Promise<ProcessRow[]> {
    if (processCache === null || Date.now() - processCache.at >= PROCESS_REFRESH_MS) {
      processCache = { at: Date.now(), rows: await readProcessTable() };
    }
    return processCache.rows;
  }

  async function cachedDisk(): Promise<Snapshot["disk"]> {
    if (diskCache === null || Date.now() - diskCache.at >= DISK_REFRESH_MS) {
      diskCache = { at: Date.now(), disk: await readDisk() };
    }
    return diskCache.disk;
  }

  async function sample(): Promise<Snapshot> {
    // After an idle stretch the stored CPU times are stale; measure a short
    // fresh window instead of averaging over the whole idle time.
    if (Date.now() - previousCpuAt > Math.max(5_000, intervalSeconds * 2_000)) {
      previousCpu = readCpuTimes();
      await new Promise((resolve) => setTimeout(resolve, CPU_WINDOW_MS));
    }
    const nextCpu = readCpuTimes();
    const perCorePct = nextCpu.map((times, index) =>
      previousCpu[index] === undefined ? 0 : usageBetween(previousCpu[index], times),
    );
    const sum = (list: CpuTimes[]) =>
      list.reduce(
        (acc, t) => ({ idle: acc.idle + t.idle, total: acc.total + t.total }),
        { idle: 0, total: 0 },
      );
    const usagePct = usageBetween(sum(previousCpu), sum(nextCpu));
    previousCpu = nextCpu;
    previousCpuAt = Date.now();

    const [memory, disk, processRows] = await Promise.all([
      readMemory(),
      cachedDisk(),
      cachedProcessRows(),
    ]);
    const cpus = os.cpus();
    return {
      at: new Date().toISOString(),
      hostname: os.hostname(),
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      uptimeSec: Math.round(os.uptime()),
      cpu: {
        model: cpus[0]?.model.trim() ?? "Unknown CPU",
        cores: cpus.length,
        usagePct,
        perCorePct,
        loadAvg: os.loadavg().map((value) => Math.round(value * 100) / 100),
      },
      memory,
      disk,
      processes: topProcesses(processRows),
      app: readAppUsage(processRows),
    };
  }

  function record(snapshot: Snapshot): HistoryPoint {
    const point: HistoryPoint = {
      at: snapshot.at,
      cpuPct: snapshot.cpu.usagePct,
      memPct: clampPct((100 * snapshot.memory.usedBytes) / snapshot.memory.totalBytes),
      appCpuPct:
        snapshot.app === null ? 0 : clampPct(snapshot.app.cpuPct / snapshot.cpu.cores),
    };
    // The chart assumes evenly spaced points, so a gap from idle time starts
    // a new history.
    const last = history.at(-1);
    if (last !== undefined && Date.parse(point.at) - Date.parse(last.at) > intervalSeconds * 3_000) {
      history.length = 0;
    }
    latest = snapshot;
    history.push(point);
    if (history.length > HISTORY_LENGTH) history.splice(0, history.length - HISTORY_LENGTH);
    return point;
  }

  /** A reading recent enough to show as current. */
  function freshLatest(): Snapshot | null {
    if (latest === null) return null;
    return Date.now() - Date.parse(latest.at) <= intervalSeconds * 2_000 + 1_000 ? latest : null;
  }

  let watchUntil = 0;
  let wake: (() => void) | null = null;
  function watch() {
    watchUntil = Date.now() + WATCH_LEASE_MS;
    wake?.();
  }

  bb.background.service("sampler", {
    async start(signal) {
      while (!signal.aborted) {
        if (Date.now() >= watchUntil) {
          // Nobody is watching: sleep until a page renews the lease.
          await new Promise<void>((resolve) => {
            const done = () => {
              signal.removeEventListener("abort", done);
              wake = null;
              resolve();
            };
            wake = done;
            signal.addEventListener("abort", done, { once: true });
          });
          continue;
        }
        try {
          const snapshot = await sample();
          const point = record(snapshot);
          bb.realtime.publish(STATS_CHANNEL, { snapshot, point });
        } catch (error) {
          bb.log.warn(`sample failed: ${String(error)}`);
        }
        await sleep(intervalSeconds * 1000, signal);
      }
    },
  });

  const stats = () => ({
    snapshot: freshLatest(),
    history: freshLatest() === null ? [] : [...history],
    intervalSeconds,
  });
  bb.rpc.register(rpcContract, {
    stats_get: async () => stats(),
    stats_watch: async () => {
      watch();
      return stats();
    },
  });

  const usage = [
    "Usage:",
    "  bb system-monitor [status] [--json]   Show CPU, memory, disk, BB, and top processes",
    "  bb system-monitor app [--json]        Show BB's own processes and their usage",
  ].join("\n");
  bb.cli.register({
    name: "system-monitor",
    summary: "Show CPU, memory, disk, and process usage of the BB server machine",
    commands: [
      {
        name: "status",
        summary: "Print a snapshot of machine usage",
        usage: "bb system-monitor status [--json]",
      },
      {
        name: "app",
        summary: "Print BB's own processes and their usage",
        usage: "bb system-monitor app [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...rest] = argv.filter((arg) => arg !== "--json");
      if (command === "help" || command === "--help" || command === "-h") {
        return { exitCode: 0, stdout: usage };
      }
      if ((command !== undefined && command !== "status" && command !== "app") || rest.length > 0) {
        return { exitCode: 1, stderr: usage };
      }
      // Reuse the page's reading when it is current; otherwise take one now
      // without adding it to the page's history.
      const snapshot = freshLatest() ?? (await sample());
      if (command === "app") {
        if (snapshot.app === null) {
          return { exitCode: 1, stderr: "Could not identify BB's process tree on this machine." };
        }
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(snapshot.app) : formatApp(snapshot.app, snapshot.cpu.cores, true),
        };
      }
      return {
        exitCode: 0,
        stdout: json ? JSON.stringify(snapshot) : formatSnapshot(snapshot),
      };
    },
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

// ------------------------------------------------------------- formatting

function formatSnapshot(s: Snapshot): string {
  const pct = (used: number, total: number) =>
    total > 0 ? `${((100 * used) / total).toFixed(0)}%` : "n/a";
  const lines = [
    `${s.hostname}  (${s.platform} ${s.osRelease}, ${s.arch}, up ${formatUptime(s.uptimeSec)})`,
    `CPU     ${s.cpu.usagePct.toFixed(1)}%  ${s.cpu.cores} cores  load ${s.cpu.loadAvg.join(" ")}  ${s.cpu.model}`,
    `Memory  ${formatBytes(s.memory.usedBytes)} / ${formatBytes(s.memory.totalBytes)}  (${pct(s.memory.usedBytes, s.memory.totalBytes)})`,
    `Swap    ${formatBytes(s.memory.swapUsedBytes)} / ${formatBytes(s.memory.swapTotalBytes)}`,
  ];
  if (s.disk !== null) {
    lines.push(
      `Disk    ${formatBytes(s.disk.usedBytes)} / ${formatBytes(s.disk.totalBytes)}  (${pct(s.disk.usedBytes, s.disk.totalBytes)})  ${s.disk.path}`,
    );
  }
  if (s.app !== null) lines.push("", formatApp(s.app, s.cpu.cores, false));
  if (s.processes.length > 0) {
    lines.push("", "Top processes by CPU:");
    for (const p of s.processes) {
      lines.push(
        `  ${String(p.pid).padStart(7)}  ${p.cpuPct.toFixed(1).padStart(5)}%  ${formatBytes(p.memBytes).padStart(9)}  ${p.name}`,
      );
    }
  }
  return lines.join("\n");
}

function formatApp(app: AppUsage, cores: number, withProcesses: boolean): string {
  const lines = [
    `BB      ${app.cpuPct.toFixed(1)}% CPU (${(app.cpuPct / cores).toFixed(1)}% of machine)  ${formatBytes(app.memBytes)}  ${app.processCount} processes`,
  ];
  for (const g of app.groups) {
    if (g.processCount === 0) continue;
    lines.push(
      `  ${APP_GROUP_LABELS[g.group].padEnd(22)}  ${g.cpuPct.toFixed(1).padStart(6)}%  ${formatBytes(g.memBytes).padStart(9)}  ${g.processCount} proc`,
    );
  }
  if (withProcesses) {
    lines.push("", "Busiest BB processes:");
    for (const p of app.processes) {
      const detail = p.detail === "" ? "" : `  ${p.detail.slice(0, 60)}`;
      lines.push(
        `  ${String(p.pid).padStart(7)}  ${p.cpuPct.toFixed(1).padStart(5)}%  ${formatBytes(p.memBytes).padStart(9)}  ${p.name}${detail}`,
      );
    }
  }
  return lines.join("\n");
}
