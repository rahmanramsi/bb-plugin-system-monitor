/** Realtime channel the server publishes each sample on. */
export const STATS_CHANNEL = "stats";

/** How long one stats_watch call keeps the sampler running. */
export const WATCH_LEASE_MS = 20_000;

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function percent(used: number, total: number): number {
  return total > 0 ? (100 * used) / total : 0;
}

/** Labels for the groups BB's process tree is split into. */
export const APP_GROUP_LABELS = {
  ui: "Desktop app",
  server: "Server",
  daemon: "Host daemon & workers",
  agents: "Agents & tools",
} as const;
