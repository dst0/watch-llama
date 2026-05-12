# watch-llama

TypeScript/Node monitoring tools for `llama-server`, ported from the relevant `watch-ollama` workflow without the Ollama-only pieces.

## What is included

- Interactive TUI with follow/pause, panel toggles, thermal status, and GPU tool cycling.
- Readable-log watcher that tails raw `llama-server` logs and writes a human-friendly log file.
- Report and stats commands for recent requests and timing summaries.
- Local JSON config persistence for UI toggles, log paths, and GPU tool selection.
- GPU telemetry auto-detection for `nvidia-smi`, `amd-smi`, `rocm-smi`, plus CPU/RAM/sensor telemetry.
- Live llama.cpp integration via `/v1/models` plus real stderr parsing for `slot print_timing` request blocks.

## What is not ported

These `watch-ollama` features are intentionally not carried over because they depend on Ollama-specific APIs or workflows:

- `setup-ollama`
- `switch-gpu`
- `update-ollama`
- `make-modelfile`
- Ollama `/api/ps` model inspection and Modelfile management

## Install

```bash
git clone https://github.com/dst0/watch-llama
cd watch-llama
npm install
npm run build
```

## Commands

```bash
npm start           # launch the TUI
npm run readlog     # tail raw logs and maintain the readable log file
npm run report      # show latest model/timing summary
npm run stats       # aggregate timing stats
npm test            # build + run the automated tests
```

After `npm run build`, the compiled CLI entry points are also available as:

- `watch-llama`
- `llama-watch-readlog`
- `llama-report`
- `llama-stats`

## Default paths

- Raw log: `/opt/llama/logs/stderr.log`
- Config dir: `~/.watch-llama`
- Config file: `~/.watch-llama/config.json`
- Readable log: `~/.watch-llama/llama_readable.log`

## Environment variables

```bash
LLAMA_LOG_PATH=/custom/stderr.log
LLAMA_READABLE_LOG_PATH=/custom/llama_readable.log
LLAMA_API_BASE_URL=http://127.0.0.1:11435
WATCH_LLAMA_HOME=/custom/watch-llama
WATCH_LLAMA_GPU_TOOL=auto
WATCH_LLAMA_SHOW_GPU=true
WATCH_LLAMA_SHOW_CPU=true
WATCH_LLAMA_SHOW_LOG=true
WATCH_LLAMA_SHOW_HINTS=true
WATCH_LLAMA_MAX_LOG_LINES=3000
WATCH_LLAMA_POLL_INTERVAL_MS=2000
```

## TUI keys

- `Q`, `Esc`, `Ctrl-C`: quit
- `F`: toggle follow mode
- `G`: toggle GPU line
- `C`: toggle CPU/RAM line
- `L`: toggle log panel
- `H`: toggle hint text
- `T`: cycle GPU tool (`auto -> nvidia-smi -> amd-smi -> rocm-smi -> none`)
- `Up` / `Down` / `Page Up` / `Page Down` / `Home` / `End`: scroll log view

## Development

```bash
npm install
npm test
```
