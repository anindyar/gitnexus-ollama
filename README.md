# GitNexus Ollama — Ubuntu-Friendly Code Intelligence

A fork of [GitNexus](https://github.com/abhigyanpatwari/GitNexus) that replaces the broken LadybugDB VECTOR extension with **Ollama embeddings + SQLite vector storage**. Built specifically to work on Ubuntu 24.04 where the upstream build crashes.

## Why This Fork?

The original GitNexus uses LadybugDB's native VECTOR extension for semantic code search. On Ubuntu 24.04 (and some other modern Linux distros), this extension hard-crashes with:

```
wal_record.cpp:76 UNREACHABLE_CODE
```

This is a known upstream bug ([#835](https://github.com/abhigyanpatwari/GitNexus/issues/835)) with no fix timeline. Without the VECTOR extension, semantic search is completely broken — you only get BM25 keyword search.

**This fork fixes it** by replacing the embedding layer entirely:

| Component | Upstream | This Fork |
|-----------|----------|-----------|
| Embedding model | @huggingface/transformers (ONNX) | **Ollama** (nomic-embed-text) |
| Vector dimensions | 384 (Snowflake arctic-embed-xs) | **768** (nomic-embed-text) |
| Vector storage | LadybugDB FLOAT[N] + VECTOR index | **SQLite** + brute-force cosine |
| Graph storage | LadybugDB (Kuzu) | LadybugDB (Kuzu) — unchanged |
| GPU dependency | Optional CUDA/DirectML | **None** — Ollama handles GPU |

## Prerequisites

- **Node.js v22+** (v20 also works)
- **Ollama** running locally (or on a network-accessible machine)
- **npm 10+**
- ~500MB disk space per indexed repo

### Install Ollama + Embedding Model

```bash
# Install Ollama (if not already installed)
curl -fsSL https://ollama.com/install.sh | sh

# Pull the embedding model
ollama pull nomic-embed-text

# Verify it's running
curl http://localhost:11434/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"nomic-embed-text","input":["test"]}'
```

## Quick Start

### Option 1: From this repo

```bash
git clone https://github.com/anindyar/gitnexus-ollama.git
cd gitnexus-ollama/gitnexus
npm install
npm run build
```

> **Build dependencies:** You need `typescript` and a C++ compiler (for better-sqlite3 native build). If `npm run build` fails:
> ```bash
> npm install typescript --save-dev
> npx node-gyp rebuild --directory=node_modules/better-sqlite3
> npm run build
> ```
>
> **LadybugDB binary:** If `analyze` crashes with `ERR_DLOPEN_FAILED`, the LadybugDB native binary didn't build. See [Troubleshooting](#troubleshooting) below.

Then index any codebase:

```bash
node dist/cli/index.js analyze /path/to/your/repo --force --embeddings
```

### Option 2: Global install (after building)

```bash
cd gitnexus-ollama/gitnexus
npm link

# Now use it anywhere
gitnexus analyze /path/to/your/repo --force --embeddings
```

## Usage

### Index a Repository

```bash
# Full analysis with embeddings (semantic search enabled)
gitnexus analyze /path/to/repo --force --embeddings

# Quick analysis without embeddings (graph search only)
gitnexus analyze /path/to/repo --force

# Index a folder that isn't a git repo
gitnexus analyze /path/to/folder --skip-git --force --embeddings
```

### Configure MCP for Your Editor

```bash
gitnexus setup
```

Auto-detects and configures:
- **Claude Code** — MCP + skills + hooks (deepest integration)
- **Cursor** — MCP + skills
- **Codex** — MCP + skills
- **Windsurf** — MCP only

### Start HTTP Server (Web UI)

```bash
gitnexus serve
```

Then open [gitnexus.vercel.app](https://gitnexus.vercel.app) and connect to your local server.

### Semantic Search

Once indexed with `--embeddings`, semantic search works through:
1. **MCP tools** — `semantic_search` tool available in Claude Code / Cursor
2. **CLI** — query via the serve API
3. **Web UI** — search via gitnexus.vercel.app

## Configuration

All settings work out of the box with defaults. Override via environment variables if needed:

```bash
# Ollama endpoint (default: http://localhost:11434/v1)
export GITNEXUS_EMBEDDING_URL=http://your-server:11434/v1

# Embedding model (default: nomic-embed-text)
export GITNEXUS_EMBEDDING_MODEL=nomic-embed-text

# Vector dimensions (default: 768 for nomic-embed-text)
export GITNEXUS_EMBEDDING_DIMS=768

# Ollama API key (default: unused — Ollama doesn't need one)
export GITNEXUS_EMBEDDING_API_KEY=unused
```

### Using a Different Embedding Model

You can use any model available in Ollama:

```bash
# Pull a different model
ollama pull mxbai-embed-large

# Use it
export GITNEXUS_EMBEDDING_MODEL=mxbai-embed-large
export GITNEXUS_EMBEDDING_DIMS=1024  # check model's output dimensions
gitnexus analyze /path/to/repo --force --embeddings
```

> ⚠️ If you change the embedding model, you **must** re-index with `--force` to regenerate all vectors.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Codebase                        │
└─────────────────────┬───────────────────────────┘
                      │ gitnexus analyze
                      ▼
┌─────────────────────────────────────────────────┐
│           Static Analysis Engine                 │
│  (tree-sitter parsers for 20+ languages)        │
└─────────┬───────────────────────┬───────────────┘
          │                       │
          ▼                       ▼
┌──────────────────┐   ┌──────────────────────┐
│   LadybugDB      │   │   Ollama API         │
│   (Kuzu graph)   │   │   nomic-embed-text   │
│                  │   │   768-dim vectors     │
│ • Nodes          │   └──────────┬───────────┘
│ • Edges          │              │
│ • Relationships  │              ▼
│ • BM25 search    │   ┌──────────────────────┐
│ • FTS indexes    │   │   SQLite             │
│                  │   │                      │
│                  │   │ • Embedding vectors  │
│                  │   │ • Cosine similarity  │
│                  │   │ • Content hashes     │
└──────────────────┘   └──────────────────────┘
          │                       │
          └───────────┬───────────┘
                      ▼
              ┌───────────────┐
              │   MCP Server  │
              │               │
              │ • Graph query │
              │ • BM25 search │
              │ • Semantic    │
              │   search      │
              │ • Flow tracing│
              └───────────────┘
```

## What Works on Ubuntu 24.04

✅ Full code graph (nodes, edges, call chains, dependencies)
✅ BM25 keyword search
✅ Full-text search (FTS indexes)
✅ Flow tracing (execution paths)
✅ Cluster detection (module grouping)
✅ **Semantic search** (via Ollama + SQLite)
✅ MCP integration (Claude Code, Cursor, Codex)
✅ Web UI via gitnexus.vercel.app
✅ Incremental re-indexing

## Performance

Tested on the A'mad Health Platform (React Native/Expo, ~150 source files):

| Metric | Value |
|--------|-------|
| Nodes indexed | 3,700 |
| Edges | 6,374 |
| Embeddings generated | 3,189 |
| Total index time | ~40s |
| Embedding model | nomic-embed-text (768d) |
| Semantic search latency | <1s (brute-force over 3K vectors) |

Semantic search latency scales linearly with embedding count. For repos with 10K+ embeddings, consider:
- Using a GPU-backed Ollama instance
- Pre-filtering via BM25 before semantic search

## Differences from Upstream

1. **No @huggingface/transformers dependency** — No ONNX Runtime, no CUDA detection, no model downloads to `~/.cache/huggingface`
2. **No LadybugDB VECTOR extension** — No native binary compatibility issues
3. **SQLite for embeddings** — `embeddings.db` stored alongside `lbug` in `.gitnexus/`
4. **Ollama required** — Must be running with `nomic-embed-text` model pulled
5. **768-dim vectors** — nomic-embed-text produces richer embeddings than the upstream's 384-dim Snowflake model

## Remote Ollama Setup (Server Deployment)

If you're running GitNexus on a server without Ollama installed locally:

```bash
# On the Ollama machine
OLLAMA_HOST=0.0.0.0 ollama serve
ollama pull nomic-embed-text

# On the GitNexus machine
export GITNEXUS_EMBEDDING_URL=http://ollama-server:11434/v1
gitnexus analyze /path/to/repo --force --embeddings
```

## Troubleshooting

### LadybugDB native binary missing (`lbugjs.node`)

LadybugDB is still used for graph storage (only the VECTOR extension was replaced). If `npm install` doesn't produce the native binary:

```bash
# Arch Linux
sudo pacman -S python-ladybug-core

# Ubuntu/Debian
# No system package — install via npm and hope it builds, or copy from Ubuntu 22.04

# Option B: Copy binary from a working machine
scp user@working-machine:/path/to/gitnexus/node_modules/@ladybugdb/core/lbugjs.node \
    ./node_modules/@ladybugdb/core/lbugjs.node

# Verify
ls node_modules/@ladybugdb/core/lbugjs.node
```

If you get `ERR_DLOPEN_FAILED` on Arch Linux or very new glibc, Option B from an older distro usually works.

### "Could not locate the bindings file" (better-sqlite3)

```bash
# Rebuild from source
npx node-gyp rebuild --directory=node_modules/better-sqlite3
```

### Tailscale / Remote Access (CORS)

By default, the serve API only accepts connections from localhost and RFC 1918 IPs. To access via **Tailscale** (100.64.0.0/10 range), patch the CORS check in `dist/server/api.js`:

Find the line `if (a === 192 && b === 168) return true;` and add after it:
```javascript
// Tailscale CGNAT range 100.64.0.0/10
if (a === 100 && b >= 64 && b <= 127) return true;
```

Then start the server bound to all interfaces:
```bash
node dist/cli/index.js serve --host 0.0.0.0 -p 4747
```

For the web UI, serve the static files on another port:
```bash
cd gitnexus/web
python3 -m http.server 4173 --bind 0.0.0.0
```

Access via: `http://<tailscale-ip>:4173/?server=http://<tailscale-ip>:4747`

### "Embedding request timed out"

Ollama isn't running or is unreachable:
```bash
ollama serve
curl http://localhost:11434/v1/embeddings -d '{"model":"nomic-embed-text","input":["test"]}' -H "Content-Type: application/json"
```

### "model 'nomic-embed-text' not found"

Pull the model first:
```bash
ollama pull nomic-embed-text
```

### Semantic search returns no results

Make sure you ran `analyze` with the `--embeddings` flag. Check the embeddings DB:
```bash
sqlite3 /path/to/repo/.gitnexus/embeddings.db "SELECT COUNT(*) FROM code_embeddings;"
```

## License

Same as upstream: **PolyForm Noncommercial 1.0.0**
- ✅ Internal development, personal use, evaluation
- ❌ Embedding into commercial products (requires enterprise license from [akonlabs.com](https://akonlabs.com))

## Credits

- [GitNexus](https://github.com/abhigyanpatwari/GitNexus) by Abhigyan Patwari — the original code intelligence platform
- [Ollama](https://ollama.com) — local LLM inference
- [nomic-embed-text](https://ollama.com/library/nomic-embed-text) — high-quality text embedding model
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — fast SQLite3 bindings for Node.js

---

*Built to solve a real production issue on Ubuntu 24.04 servers. If this helps you, ⭐ the repo.*
