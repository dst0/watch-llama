# watch-llama

A professional monitoring TUI for **llama-server**, rewritten in TypeScript and Node.js for high performance and modularity.

## Features

- **Real-time TUI**: Modular dashboard built with `blessed`.
- **ROCm/AMD Support**: Native parsing of `rocm-smi` metrics.
- **Log Streaming**: Stateful tailing of llama-server logs with inference metric extraction.
- **Centralized State**: Built on a reactive event-driven architecture.

## Installation

```bash
git clone https://github.com/dst0/watch-llama
cd watch-llama
npm install
npm run start
```

## Configuration

The app automatically monitors `/opt/llama/logs/stderr.log`. You can override this via environment variables.

