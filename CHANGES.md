# GitNexus Ollama Fork — Changes Summary

## Why This Fork

The original GitNexus uses LadybugDB's VECTOR extension for semantic search, which crashes on Ubuntu 24.04 with an unrecoverable error (`wal_record.cpp:76 UNREACHABLE_CODE`). This is a known issue with the pre-built LadybugDB native binary on newer glibc-based systems.

Rather than waiting for a fix, we replaced the embedding layer with Ollama + SQLite, keeping LadybugDB for graph storage (nodes/edges) since that part works fine.

## Changes Made

### Embedder — Ollama instead of @huggingface/transformers

- **`src/core/embeddings/http-client.ts`** — Now defaults to Ollama at `http://localhost:11434/v1` with `nomic-embed-text` model. No env vars required, but can still be overridden via `GITNEXUS_EMBEDDING_URL` / `GITNEXUS_EMBEDDING_MODEL`. `isHttpMode()` always returns `true`.

- **`src/core/embeddings/embedder.ts`** — Replaced the entire transformers.js singleton with a simple HTTP-only module. All embedding goes through `httpEmbed()` / `httpEmbedQuery()` from http-client. Removed all CUDA/ONNX Runtime detection code. Default dimensions changed from 384 → 768 (nomic-embed-text).

- **`src/core/embeddings/config.ts`** — No structural changes; inherits updated defaults from types.ts.

- **`src/core/embeddings/types.ts`** — `DEFAULT_EMBEDDING_CONFIG.modelId` changed from `Snowflake/snowflake-arctic-embed-xs` to `nomic-embed-text`. `dimensions` changed from 384 to 768. `device` changed from `'auto'` to `'cpu'` (GPU selection is Ollama's job).

- **`src/mcp/core/embedder.ts`** — Replaced transformers.js-based embedder with HTTP-only Ollama version. Simplified initialization (no model loading needed — Ollama handles it).

### Vector Storage — SQLite instead of LadybugDB VECTOR extension

- **`src/core/embeddings/sqlite-store.ts`** (new) — Core SQLite store using `better-sqlite3`. Stores embeddings as BLOB (Float32Array buffers). Creates a virtual table via sqlite-vec for vector search, plus regular B+tree indexes for node_id and content_hash lookups. Includes `semanticSearch()` (sqlite-vec powered) and `exactScanSearch()` (brute-force fallback). Singleton pattern for DB access across semantic search calls.

- **`src/core/lbug/schema.ts`** — Removed `EMBEDDING_SCHEMA` (the Kuzu `CREATE NODE TABLE` for code_embeddings). Removed `CREATE_VECTOR_INDEX_QUERY` (the `CALL CREATE_VECTOR_INDEX(...)` Kuzu call). Added `EMBEDDING_DIMS = 768` as a constant export. The `EMBEDDING_TABLE_NAME` constant remains (still used for legacy content-hash queries).

- **`src/core/embeddings/embedding-pipeline.ts`** — Replaced LadybugDB `CREATE` (Kuzu insert) with SQLite `batchInsertEmbeddings()`. Replaced `loadVectorExtension()` checks with SQLite store initialization. Replaced `QUERY_VECTOR_INDEX` calls with SQLite `semanticSearch()`. `batchInsertEmbeddings` is re-exported for backward compatibility with run-analyze.ts. `ensureVectorExtensionAvailable()` removed (no longer needed).

- **`src/core/run-analyze.ts`** — Replaced the `MATCH (e:code_embeddings) RETURN count(e)` query with `getEmbeddingCount(getVecStore())`. Added `sqliteDbPath` parameter to pass SQLite DB path to embedding pipeline.

- **`src/mcp/local/local-backend.ts`** — Replaced the entire `semanticSearch()` method. Now uses Ollama to embed the query, then calls `semanticSearch()` from sqlite-store to do vector search in SQLite. Removed `QUERY_VECTOR_INDEX` calls and all `loadVectorExtension()` / `isVectorExtensionSupportedByPlatform()` checks.

### Other Changes

- **`src/core/lbug/lbug-adapter.ts`** — `loadVectorExtension()` function remains (used by other code paths that may still check for VECTOR availability). The function itself is unchanged — it's still a valid LadybugDB extension loader. No need to remove it since LadybugDB still handles graph storage fine.

- **`package.json`** — Added `better-sqlite3` dependency. Removed `@huggingface/transformers` and `onnxruntime-node` (no longer needed for local embedding).

## Prerequisites

1. **Ollama must be running** on `localhost:11434` with the `nomic-embed-text` model installed:
   ```bash
   ollama run nomic-embed-text
   ```

2. **sqlite-vec** needs to be installed (comes with better-sqlite3):
   ```bash
   npm install better-sqlite3
   ```

3. If running on a remote server, ensure Ollama is accessible (check `OLLAMA_HOST` env var if needed).

## Configuration (Optional)

The fork works out of the box with Ollama defaults, but you can override:

```bash
export GITNEXUS_EMBEDDING_URL=http://localhost:11434/v1
export GITNEXUS_EMBEDDING_MODEL=nomic-embed-text
export GITNEXUS_EMBEDDING_DIMS=768
```

## Architecture

```
Code Analysis
    ↓
LadybugDB (Kuzu) ← Graph storage (nodes, edges, relationships)
    ↓
Ollama (/api/embeddings) ← Embedding model (nomic-embed-text, 768-dim)
    ↓
SQLite + sqlite-vec ← Vector storage + semantic search
```

## Files Changed/Created

| File | Change |
|------|--------|
| `src/core/embeddings/http-client.ts` | Default to Ollama |
| `src/core/embeddings/embedder.ts` | HTTP-only embedder |
| `src/core/embeddings/types.ts` | 768-dim default |
| `src/core/embeddings/sqlite-store.ts` | **New** — SQLite vector store |
| `src/core/lbug/schema.ts` | Removed VECTOR schema/index |
| `src/core/embeddings/embedding-pipeline.ts` | Use SQLite store |
| `src/core/run-analyze.ts` | SQLite embedding count |
| `src/mcp/core/embedder.ts` | Ollama-only MCP embedder |
| `src/mcp/local/local-backend.ts` | SQLite-backed semantic search |