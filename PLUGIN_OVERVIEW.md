See at a glance how hard the machine running BB is working while your agents run.

## What you get

- A **System monitor** page in the left sidebar with live CPU and memory usage, a short history graph for each, per-core meters, swap, disk space, uptime, and the processes using the most CPU.
- A **BB app** section that shows how much CPU and memory BB itself uses, split into the desktop app, the server, the host daemon, and the agents and tools your threads run, with the busiest BB processes listed.
- A `bb system-monitor` command that prints the same snapshot in a terminal, with `--json` for scripts, and `bb system-monitor app` for BB's own processes.
- A skill that lets agents check machine load before they start heavy work such as builds or test suites.

## How it works

The plugin samples the BB server's own machine every two seconds (configurable from 1 to 60 seconds), but only while the System monitor page is open and visible. Close the page or switch tabs and sampling stops within about 20 seconds, so the plugin costs nothing in the background. The process list refreshes every 5 seconds and disk space every minute. On macOS, memory use matches Activity Monitor: app memory plus wired and compressed memory. On Linux, it uses available memory from `/proc/meminfo`.

Samples stay in memory on the BB server. Nothing is stored on disk or sent to any external service.
