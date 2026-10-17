// bb-plugin-system-monitor — the System monitor sidebar page.
//
// Loads the latest sample and recent history over RPC, then follows the
// server's realtime "stats" signal for live updates.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { AppGroup, AppUsage, HistoryPoint, Snapshot, rpcContract } from "./server";
import {
  APP_GROUP_LABELS,
  STATS_CHANNEL,
  WATCH_LEASE_MS,
  formatBytes,
  formatUptime,
  percent,
} from "@/lib/format";
import { cn } from "@/lib/utils";

const HISTORY_LENGTH = 90;

function useStats() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [intervalSeconds, setIntervalSeconds] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // stats_watch both reads and renews the server's sampling lease; the server
  // samples only while some page keeps renewing it.
  const refetch = useCallback(() => {
    rpc.call("stats_watch").then(
      (result) => {
        setSnapshot(result.snapshot);
        setHistory(result.history);
        setIntervalSeconds(result.intervalSeconds);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer !== undefined) return;
      refetch();
      timer = setInterval(refetch, WATCH_LEASE_MS / 2);
    };
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    // A hidden tab stops renewing, so the server goes idle with it.
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [refetch]);
  // Signals are not replayed, so resync after a reconnect.
  useEffect(() => {
    if (connection === "connected" && document.visibilityState === "visible") refetch();
  }, [connection, refetch]);

  useRealtime(STATS_CHANNEL, (payload) => {
    const { snapshot: next, point } = payload as { snapshot: Snapshot; point: HistoryPoint };
    if (next === undefined || point === undefined) return;
    setSnapshot(next);
    setHistory((prev) => [...prev.slice(-(HISTORY_LENGTH - 1)), point]);
  });

  return { snapshot, history, intervalSeconds, error };
}

// ------------------------------------------------------------------ reading

type Load = "calm" | "busy" | "heavy";

function loadOf(s: Snapshot): Load {
  const memPct = percent(s.memory.usedBytes, s.memory.totalBytes);
  const swapPct = percent(s.memory.swapUsedBytes, s.memory.swapTotalBytes);
  if (s.cpu.usagePct >= 85 || memPct >= 92 || swapPct >= 80) return "heavy";
  if (s.cpu.usagePct >= 50 || memPct >= 80) return "busy";
  return "calm";
}

const LOAD_HEADLINE: Record<Load, string> = {
  calm: "is running calm",
  busy: "is busy",
  heavy: "is under heavy load",
};

/** Fill colour for a usage bar: ink, then warning and destructive as it runs high. */
function fillFor(pct: number): string {
  if (pct >= 90) return "bg-destructive";
  if (pct >= 75) return "bg-warning";
  return "bg-foreground";
}

function spanLabel(seconds: number): string {
  if (seconds < 60) return `Last ${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return `Last ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function shortHost(hostname: string): string {
  return hostname.replace(/\.local$/, "");
}

function platformName(platform: string): string {
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  if (platform === "win32") return "Windows";
  return platform;
}

/** Entrance for each block: rises once when the page first renders. */
function rise(order: number): { className: string; style: CSSProperties } {
  return {
    className: "motion-safe:animate-[sm-rise_640ms_cubic-bezier(0.2,0.7,0.2,1)_both]",
    style: { animationDelay: `${order * 75}ms` },
  };
}

const KEYFRAMES = `@keyframes sm-rise{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}`;

// --------------------------------------------------------------- primitives

function Bar({
  value,
  label,
  className,
}: {
  value: number;
  label: string;
  className?: string;
}) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cn("h-2.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className={cn(
          "h-full w-full origin-left rounded-full transition-transform duration-700 ease-out motion-reduce:transition-none",
          fillFor(pct),
        )}
        style={{ transform: `scaleX(${pct / 100})` }}
      />
    </div>
  );
}

/** CPU (filled) and memory (line) history on one time axis. */
function HistoryChart({
  history,
  intervalSeconds,
}: {
  history: HistoryPoint[];
  intervalSeconds: number;
}) {
  const width = 600;
  const height = 160;
  // The axis grows with the data until it holds the full history, so a fresh
  // start still fills the chart; the caption states the real span.
  const slots = Math.min(HISTORY_LENGTH, Math.max(30, history.length));
  const step = width / (slots - 1);
  const offset = (slots - history.length) * step;
  const spanSeconds = Math.max(0, history.length - 1) * intervalSeconds;
  const toPoints = (values: number[]) =>
    values.map((value, index) => {
      const y = height - (Math.min(100, Math.max(0, value)) / 100) * (height - 4) - 2;
      return `${(offset + index * step).toFixed(1)},${y.toFixed(1)}`;
    });
  const cpu = toPoints(history.map((p) => p.cpuPct));
  const mem = toPoints(history.map((p) => p.memPct));
  const latest = history.at(-1);
  return (
    <figure className="flex flex-col gap-3">
      <div className="relative h-40 w-full overflow-hidden rounded-lg bg-muted/50 md:h-48">
        {history.length < 2 ? null : (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={
              latest === undefined
                ? "CPU and memory history"
                : `CPU and memory over the last few minutes; now CPU ${latest.cpuPct.toFixed(0)}%, memory ${latest.memPct.toFixed(0)}%`
            }
            className="absolute inset-0 h-full w-full"
          >
            <path
              d={`M${offset},${height} L${cpu.join(" L")} L${width},${height} Z`}
              className="fill-foreground"
              opacity={0.16}
            />
            <polyline
              points={cpu.join(" ")}
              fill="none"
              className="stroke-foreground"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
            <polyline
              points={mem.join(" ")}
              fill="none"
              className="stroke-foreground"
              strokeOpacity={0.55}
              strokeDasharray="5 4"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="h-2.5 w-4 rounded-sm bg-foreground/40" />
          CPU
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="w-4 border-t-2 border-dashed border-foreground/55" />
          Memory
        </span>
        <span>{spanLabel(spanSeconds)}</span>
      </figcaption>
    </figure>
  );
}

/** One vertical bar per core, side by side like a level meter. */
function CoreStrip({ perCorePct }: { perCorePct: number[] }) {
  return (
    <div
      role="group"
      aria-label="Usage per core"
      className="flex h-32 items-end gap-1.5 md:h-full md:min-h-36"
    >
      {perCorePct.map((pct, index) => (
        <div
          key={index}
          role="meter"
          aria-label={`Core ${index + 1}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          title={`Core ${index + 1}: ${pct.toFixed(0)}%`}
          className="relative h-full min-w-0 flex-1 overflow-hidden rounded-md bg-muted"
        >
          <div
            className={cn(
              "absolute inset-0 origin-bottom transition-transform duration-700 ease-out motion-reduce:transition-none",
              fillFor(pct),
            )}
            style={{ transform: `scaleY(${Math.max(0.02, pct / 100)})` }}
          />
        </div>
      ))}
    </div>
  );
}

function Figure({ value, label, note }: { value: string; label: string; note: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="text-[clamp(3.5rem,7vw,7rem)] font-semibold leading-[0.9] tracking-[-0.045em] tabular-nums">
        {value}
      </div>
      <div className="flex flex-col text-base">
        <span>{label}</span>
        <span className="text-muted-foreground tabular-nums">{note}</span>
      </div>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">{children}</h2>;
}

// ------------------------------------------------------------------ sections

function Overview({
  s,
  history,
  intervalSeconds,
}: {
  s: Snapshot;
  history: HistoryPoint[];
  intervalSeconds: number;
}) {
  const memPct = percent(s.memory.usedBytes, s.memory.totalBytes);
  const a = rise(0);
  const b = rise(1);
  const c = rise(2);
  return (
    <section aria-labelledby="sm-headline" className="flex flex-col gap-10">
      <div className={cn("flex flex-col gap-2", a.className)} style={a.style}>
        <h1 id="sm-headline" className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
          {shortHost(s.hostname)} {LOAD_HEADLINE[loadOf(s)]}
        </h1>
        <p className="max-w-[65ch] text-base text-muted-foreground">
          {platformName(s.platform)} {s.osRelease} on {s.cpu.model}, {s.cpu.cores} cores, up{" "}
          {formatUptime(s.uptimeSec)}
        </p>
      </div>

      <div
        className={cn("grid grid-cols-2 gap-x-8 gap-y-10 md:grid-cols-[1fr_1fr_1.15fr]", b.className)}
        style={b.style}
      >
        <Figure
          value={`${s.cpu.usagePct.toFixed(0)}%`}
          label="CPU"
          note={`load ${s.cpu.loadAvg.map((v) => v.toFixed(1)).join("  ")}`}
        />
        <Figure
          value={`${memPct.toFixed(0)}%`}
          label="Memory"
          note={`${formatBytes(s.memory.usedBytes)} of ${formatBytes(s.memory.totalBytes)}`}
        />
        <div className="col-span-2 flex flex-col gap-2 md:col-span-1">
          <CoreStrip perCorePct={s.cpu.perCorePct} />
          <div className="flex flex-col text-base">
            <span>Per core</span>
            <span className="text-muted-foreground tabular-nums">
              busiest at {Math.max(0, ...s.cpu.perCorePct).toFixed(0)}%
            </span>
          </div>
        </div>
      </div>

      <div className={c.className} style={c.style}>
        <HistoryChart history={history} intervalSeconds={intervalSeconds} />
      </div>
    </section>
  );
}

function MeterRow({
  label,
  used,
  total,
  note,
  noteTitle,
}: {
  label: string;
  used: number;
  total: number;
  note?: string;
  noteTitle?: string;
}) {
  const pct = percent(used, total);
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-3 md:grid-cols-[10rem_1fr_14rem] md:items-center">
      <div className="flex flex-col">
        <span className="text-base font-medium">{label}</span>
        {note === undefined ? null : (
          <span className="text-sm text-muted-foreground" title={noteTitle}>
            {note}
          </span>
        )}
      </div>
      <div className="order-last col-span-2 md:order-none md:col-span-1">
        <Bar value={pct} label={`${label} usage`} />
      </div>
      <div className="text-right text-base tabular-nums">
        {formatBytes(used)}
        <span className="text-muted-foreground"> of {formatBytes(total)}</span>
      </div>
    </div>
  );
}

function Storage({ s }: { s: Snapshot }) {
  const a = rise(3);
  return (
    <section
      aria-labelledby="sm-storage"
      className={cn("flex flex-col gap-8", a.className)}
      style={a.style}
    >
      <SectionHeading>
        <span id="sm-storage">Memory and storage</span>
      </SectionHeading>
      <div className="flex flex-col gap-7">
        <MeterRow label="Memory" used={s.memory.usedBytes} total={s.memory.totalBytes} />
        {s.memory.swapTotalBytes > 0 ? (
          <MeterRow label="Swap" used={s.memory.swapUsedBytes} total={s.memory.swapTotalBytes} />
        ) : null}
        {s.disk === null ? null : (
          <MeterRow
            label="Disk"
            used={s.disk.usedBytes}
            total={s.disk.totalBytes}
            note={`${formatBytes(s.disk.totalBytes - s.disk.usedBytes)} free`}
            noteTitle={s.disk.path}
          />
        )}
      </div>
    </section>
  );
}

/** Tones for the four parts of BB, darkest first, drawn from the ink. */
const GROUP_TONE: Record<AppGroup, string> = {
  agents: "bg-foreground",
  daemon: "bg-foreground/60",
  server: "bg-foreground/35",
  ui: "bg-foreground/20",
};
const GROUP_ORDER: AppGroup[] = ["agents", "daemon", "server", "ui"];

function BbUsage({ app, cores }: { app: AppUsage; cores: number }) {
  const share = app.cpuPct / cores;
  const groups = GROUP_ORDER.map((g) => app.groups.find((x) => x.group === g)).filter(
    (g): g is AppUsage["groups"][number] => g !== undefined,
  );
  const busiest = [...groups].sort((x, y) => y.cpuPct - x.cpuPct)[0];
  const totalCpu = Math.max(0.1, groups.reduce((sum, g) => sum + g.cpuPct, 0));
  const a = rise(4);
  return (
    <section
      aria-labelledby="sm-bb"
      className={cn(
        "-mx-5 flex flex-col gap-10 bg-muted/50 px-5 py-12 md:-mx-8 md:rounded-2xl md:px-8 md:py-14",
        a.className,
      )}
      style={a.style}
    >
      <div className="flex flex-col gap-3">
        <SectionHeading>
          <span id="sm-bb">BB is using {share.toFixed(0)}% of this machine</span>
        </SectionHeading>
        <p className="max-w-[60ch] text-base">
          {formatBytes(app.memBytes)} of memory across {app.processCount} processes.
          {busiest !== undefined && busiest.cpuPct > 0
            ? ` Most of the CPU goes to ${APP_GROUP_LABELS[busiest.group].toLowerCase()}.`
            : ""}
        </p>
      </div>

      <div className="flex flex-col gap-6">
        <div
          role="img"
          aria-label={`CPU split: ${groups.map((g) => `${APP_GROUP_LABELS[g.group]} ${g.cpuPct.toFixed(0)}%`).join(", ")}`}
          className="flex h-4 w-full gap-1 overflow-hidden rounded-full"
        >
          {groups.map((g) =>
            g.cpuPct <= 0 ? null : (
              <div
                key={g.group}
                className={cn(
                  "h-full transition-[flex-grow] duration-700 ease-out motion-reduce:transition-none",
                  GROUP_TONE[g.group],
                )}
                style={{ flexGrow: g.cpuPct / totalCpu, flexBasis: 0 }}
              />
            ),
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-6 md:grid-cols-4">
          {groups.map((g) => (
            <div key={g.group} className="flex min-w-0 flex-col gap-1">
              <dt className="flex items-center gap-2 text-base">
                <span aria-hidden className={cn("size-3 shrink-0 rounded-sm", GROUP_TONE[g.group])} />
                <span className="truncate">{APP_GROUP_LABELS[g.group]}</span>
              </dt>
              <dd className="text-[28px] font-semibold leading-tight tracking-[-0.02em] tabular-nums">
                {g.cpuPct.toFixed(0)}%
              </dd>
              <dd className="text-[13px] text-muted-foreground tabular-nums">
                {formatBytes(g.memBytes)} · {g.processCount} processes
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <ProcessTable
        caption="Busiest BB processes"
        rows={app.processes.map((p) => ({
          pid: p.pid,
          name: p.name,
          detail: p.detail,
          role: APP_GROUP_LABELS[p.group],
          cpuPct: p.cpuPct,
          memBytes: p.memBytes,
        }))}
        rowTone="hover:bg-background/60"
      />
    </section>
  );
}

type Row = {
  pid: number;
  name: string;
  detail?: string;
  role?: string;
  cpuPct: number;
  memBytes: number;
};

function ProcessTable({
  caption,
  rows,
  rowTone,
}: {
  caption: string;
  rows: Row[];
  rowTone: string;
}) {
  const hasRole = rows.some((r) => r.role !== undefined);
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">{caption}</h3>
      <table className="w-full table-fixed text-base tabular-nums">
        <thead>
          <tr className="text-left text-[13px] text-muted-foreground">
            <th className="py-2 pr-4 font-normal">Process</th>
            {hasRole ? (
              <th className="hidden w-48 py-2 pr-4 font-normal md:table-cell">Role</th>
            ) : null}
            <th className="w-16 py-2 pr-4 text-right font-normal md:w-20">CPU</th>
            <th className="w-20 py-2 text-right font-normal md:w-24">Memory</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.pid} className={cn("transition-colors duration-150", rowTone)}>
              <td className="py-2.5 pr-4" title={r.detail || r.name}>
                <div className="truncate">{r.name}</div>
                <div className="truncate text-[13px] text-muted-foreground">
                  {r.detail ? r.detail : `PID ${r.pid}`}
                </div>
              </td>
              {hasRole ? (
                <td className="hidden py-2.5 pr-4 text-muted-foreground md:table-cell">
                  {r.role}
                </td>
              ) : null}
              <td
                className={cn(
                  "py-2.5 pr-4 text-right",
                  r.cpuPct >= 90 && "font-semibold text-destructive-text",
                )}
              >
                {r.cpuPct.toFixed(0)}%
              </td>
              <td className="py-2.5 text-right">{formatBytes(r.memBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SystemMonitorPage() {
  const { snapshot: s, history, intervalSeconds, error } = useStats();

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <style>{KEYFRAMES}</style>
      <div className="mx-auto box-border flex w-full max-w-6xl flex-col gap-20 px-5 pb-16 pt-8 md:gap-28 md:px-8 md:pt-12">
        {error === null ? null : (
          <p role="alert" className="text-base text-destructive-text">
            {error}
          </p>
        )}
        {s === null ? (
          <p role="status" className="text-[28px] font-semibold tracking-[-0.02em] text-muted-foreground">
            Taking the first reading…
          </p>
        ) : (
          <>
            <Overview s={s} history={history} intervalSeconds={intervalSeconds ?? 2} />
            <Storage s={s} />
            {s.app === null ? null : <BbUsage app={s.app} cores={s.cpu.cores} />}
            {s.processes.length === 0 ? null : (
              <section aria-label="Busiest processes on this machine">
                <ProcessTable
                  caption="Busiest processes on this machine"
                  rows={s.processes}
                  rowTone="hover:bg-muted/50"
                />
              </section>
            )}
            <p className="text-[13px] text-muted-foreground">
              {intervalSeconds === null
                ? ""
                : `Sampled every ${intervalSeconds} ${intervalSeconds === 1 ? "second" : "seconds"}. `}
              Last reading at {new Date(s.at).toLocaleTimeString()}.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "system-monitor",
    title: "System monitor",
    icon: "system-monitor/activity",
    path: "system-monitor",
    component: SystemMonitorPage,
  });
});
