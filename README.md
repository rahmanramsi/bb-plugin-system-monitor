# bb-plugin-system-monitor

A BB plugin that shows live resource usage of the machine that runs the BB
server: CPU (overall and per core), load average, memory, swap, disk, uptime,
the top processes by CPU, and how much of that BB itself uses.

- `server.ts` samples the machine on a fixed interval while the page is
  open, keeps the last 90 samples in memory, publishes each one on the
  `stats` realtime channel, and serves the `stats_get` and `stats_watch` RPC
  methods and the `bb system-monitor` command.
- `app.tsx` adds a **System monitor** page to the left sidebar with the
  machine's state, CPU and memory figures, per-core bars, a history chart,
  memory and storage meters, a **BB app** section, and process tables.
- `skills/system-monitor/SKILL.md` tells agents how to read machine usage
  with the CLI.

## How the numbers are measured

| Metric | macOS | Linux |
| --- | --- | --- |
| CPU | Tick deltas from `os.cpus()` between samples | Same |
| Memory used | App memory + wired + compressed, from `vm_stat` (matches Activity Monitor) | `MemTotal - MemAvailable` from `/proc/meminfo` |
| Swap | `sysctl vm.swapusage` | `/proc/meminfo` |
| Disk | `/System/Volumes/Data` | `/` |
| Processes | `ps -Ao pid,pcpu,rss,comm` | Same |

| BB app | The process tree of the BB desktop app (or the headless server), from the same `ps` call | Same |

Other platforms fall back to `os.totalmem()` and `os.freemem()`, with no swap
or process data.

## BB app usage

The plugin finds BB's process tree by walking up from the server process to
the outermost ancestor that runs the same executable: the desktop app, or the
server itself when BB runs headless. Every process below that root counts
toward BB, split into four groups:

| Group | Processes |
| --- | --- |
| Desktop app | The Electron main process, its GPU, renderer, and utility helpers, and the app bridge |
| Server | The BB server and its child processes |
| Host daemon & workers | The host daemon, plugin host workers, provider bridges, and the file watcher |
| Agents & tools | Everything the host daemon starts for threads: agent CLIs, shells, builds, tests, browsers |

CPU is reported the way `ps` reports it, per core, so a group can exceed
100%. The page also shows BB's share of the whole machine (total divided by
the number of cores).

## Resource use

The plugin samples only while someone watches. The page calls the
`stats_watch` RPC method when it opens and every 10 seconds while it is
visible; each call keeps the sampler running for 20 seconds. With no open,
visible page, the sampler sleeps and spawns nothing. A gap in sampling starts
a new history, so the chart never stretches across idle time.

While it runs, the costly reads are refreshed less often than the interval:

| Read | Cost on an Apple M4 | Refreshed |
| --- | --- | --- |
| CPU (`os.cpus()`) | In-process | Every sample |
| Memory (`vm_stat`, `sysctl`) | About 2 ms | Every sample |
| Processes (`ps` over every process) | About 20 ms | At most every 5 seconds |
| Disk (`statfs`) | In-process | Every 60 seconds |

`bb system-monitor` reuses the page's reading when it is current. Otherwise it
takes one reading on demand, with a 0.5-second CPU window, and does not start
the sampler.

## Install

```
bb plugin install git:github.com/rahmanramsi/bb-plugin-system-monitor
```

To work on the plugin from a local checkout:

```
npm install
bb plugin install .
```

After editing sources, run `bb plugin reload system-monitor`, or let
`bb plugin dev` rebuild and reload on every save.

## Use

Open **System monitor** in the sidebar, or run:

```
bb system-monitor            # human-readable snapshot
bb system-monitor --json     # the full snapshot as JSON
bb system-monitor app        # BB's own processes, grouped by role
```

## Configure

| Setting | Default | Range | Effect |
| --- | --- | --- | --- |
| `intervalSeconds` | `2` | 1–60 | Seconds between samples while the page is open |

```
bb plugin config system-monitor set intervalSeconds 5
```

The new interval takes effect after the current sample.
