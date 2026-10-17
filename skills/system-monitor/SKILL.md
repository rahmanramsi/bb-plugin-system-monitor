---
name: system-monitor
description: Check CPU, memory, swap, disk, and top-process usage of the machine running BB, and how much of it BB and its agents use, with the `bb system-monitor` CLI. Use when the user asks how busy the machine is, why it is slow, how much RAM or disk is free, or before starting heavy work such as large builds or parallel test runs.
---

# System monitor

The System Monitor plugin samples the machine that runs the BB server. The
System monitor page in the BB sidebar and the `bb system-monitor` command show
the same data.

## Commands

| Command | Effect |
| --- | --- |
| `bb system-monitor` | Print host, CPU, memory, swap, disk, and the top processes by CPU. |
| `bb system-monitor --json` | Print the same snapshot as one JSON object. |
| `bb system-monitor app` | Print BB's own usage by group and its busiest processes. Add `--json` for the same data as JSON. |

The JSON snapshot has these fields: `hostname`, `platform`, `uptimeSec`,
`cpu.usagePct`, `cpu.perCorePct`, `cpu.loadAvg`, `cpu.cores`,
`memory.totalBytes`, `memory.usedBytes`, `memory.swapTotalBytes`,
`memory.swapUsedBytes`, `disk.totalBytes`, `disk.usedBytes` (`disk` can be
`null`), `processes[]` with `pid`, `name`, `cpuPct`, and `memBytes`, and
`app` (can be `null`) with BB's totals: `cpuPct`, `memBytes`,
`processCount`, `groups[]`, and `processes[]`. Each BB process has a `group`
of `ui` (desktop app), `server`, `daemon` (host daemon and workers), or
`agents` (agent CLIs, shells, builds, and other tools started for threads),
and a `detail` with its command line or role.

## Rules

- The numbers describe the BB server's machine, not a remote environment.
- `cpuPct` for a process is per core, so it can exceed 100 on multi-core
  machines.
- When the machine is busy, run `bb system-monitor app` to see whether BB's
  agents and tools cause the load, and name the busiest commands.
- Report usage to the user; do not kill processes unless the user asks.
