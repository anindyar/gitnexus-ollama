/**
 * SQLite Vector Store
 *
 * Handles embedding storage and semantic search using SQLite.
 * Uses brute-force cosine similarity for vector search (no sqlite-vec dependency).
 * Replaces LadybugDB's FLOAT[N] column + CREATE_VECTOR_INDEX approach.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { CachedEmbedding } from './types.js';
import { rankExactEmbeddingRows, type ExactEmbeddingRow } from './exact-search.js';

// Default dimensions for nomic-embed-text
const DEFAULT_DIMENSIONS = 768;
const TABLE_NAME = 'code_embeddings';

// Singleton DB instance for semantic search
let singletonDb: Database.Database | null = null;
let singletonDbPath: string | null = null;

export interface SqliteStoreConfig {
  dbPath: string;
  dimensions?: number;
}

/**
 * Get or create the singleton DB instance (for semantic search)
 */
export const getVecStore = (dbPath?: string, _dimensions?: number): Database.Database => {
  if (!singletonDb) {
    const p = dbPath || singletonDbPath;
    if (!p) {
      throw new Error('No DB path provided and no singleton initialized');
    }
    singletonDb = new Database(p);
    singletonDb.pragma('journal_mode = WAL');
  }
  return singletonDb;
};

/**
 * Close the singleton DB instance
 */
export const closeVecStore = (): void => {
  if (singletonDb) {
    singletonDb.close();
    singletonDb = null;
  }
};

/**
 * Initialize SQLite database for embedding storage
 */
export const initSqliteStore = (config: SqliteStoreConfig): Database.Database => {
  const dbPath = path.resolve(config.dbPath);
  const dbDir = path.dirname(dbPath);

  // Ensure directory exists
  fs.mkdirSync(dbDir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000'); // 64MB cache
  db.pragma('temp_store = MEMORY');

  // Create embeddings table (no virtual table needed — brute-force search)
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      content_hash TEXT,
      embedding BLOB
    )
  `);

  // Create indexes for fast lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_node_id ON ${TABLE_NAME}(node_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_content_hash ON ${TABLE_NAME}(content_hash);
  `);

  // Store as singleton for semantic search access
  singletonDb = db;
  singletonDbPath = dbPath;

  return db;
};

/**
 * Insert or replace embeddings in batch
 */
export const batchInsertEmbeddings = (
  db: Database.Database,
  embeddings: Array<{
    id: string;
    nodeId: string;
    chunkIndex: number;
    startLine: number;
    endLine: number;
    embedding: number[] | Float32Array;
    contentHash?: string;
  }>,
): void => {
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO ${TABLE_NAME}
    (id, node_id, chunk_index, start_line, end_line, content_hash, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items: typeof embeddings) => {
    for (const item of items) {
      const embeddingBuffer = Buffer.isBuffer(item.embedding)
        ? item.embedding
        : Buffer.from(new Float32Array(item.embedding).buffer);
      insertStmt.run(
        item.id,
        item.nodeId,
        item.chunkIndex,
        item.startLine,
        item.endLine,
        item.contentHash ?? '',
        embeddingBuffer,
      );
    }
  });

  insertMany(embeddings);
};

/**
 * Delete embeddings for specific node IDs
 */
export const deleteEmbeddingsForNodes = (
  db: Database.Database,
  nodeIds: string[],
): void => {
  if (nodeIds.length === 0) return;

  const deleteStmt = db.prepare(`DELETE FROM ${TABLE_NAME} WHERE node_id = ?`);
  const deleteMany = db.transaction((ids: string[]) => {
    for (const id of ids) {
      deleteStmt.run(id);
    }
  });

  deleteMany(nodeIds);
};

/**
 * Fetch all existing content hashes
 */
export const fetchAllContentHashes = (db: Database.Database): Map<string, string> => {
  const stmt = db.prepare(`
    SELECT node_id, content_hash, chunk_index, start_line, end_line
    FROM ${TABLE_NAME}
  `);
  const rows = stmt.all() as Array<{
    node_id: string;
    content_hash: string;
    chunk_index: number;
    start_line: number;
    end_line: number;
  }>;

  const map = new Map<string, string>();
  for (const row of rows) {
    const hasChunkMetadata =
      row.chunk_index !== null &&
      row.start_line !== null &&
      row.end_line !== null;
    if (hasChunkMetadata && row.content_hash) {
      map.set(row.node_id, row.content_hash);
    } else {
      map.set(row.node_id, '');
    }
  }
  return map;
};

/**
 * Load cached embeddings for incremental rebuild
 */
export const loadCachedEmbeddings = (db: Database.Database): {
  embeddingNodeIds: Set<string>;
  embeddings: CachedEmbedding[];
} => {
  const stmt = db.prepare(`
    SELECT node_id, chunk_index, start_line, end_line, embedding, content_hash
    FROM ${TABLE_NAME}
  `);
  const rows = stmt.all() as Array<{
    node_id: string;
    chunk_index: number;
    start_line: number;
    end_line: number;
    embedding: Buffer;
    content_hash: string | null;
  }>;

  const embeddingNodeIds = new Set<string>();
  const embeddings: CachedEmbedding[] = [];

  for (const row of rows) {
    embeddingNodeIds.add(row.node_id);
    const floatBuf = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
    embeddings.push({
      nodeId: row.node_id,
      chunkIndex: row.chunk_index,
      startLine: row.start_line,
      endLine: row.end_line,
      embedding: Array.from(floatBuf),
      contentHash: row.content_hash ?? undefined,
    });
  }

  return { embeddingNodeIds, embeddings };
};

/**
 * Get embedding count
 */
export const getEmbeddingCount = (db: Database.Database): number => {
  const stmt = db.prepare(`SELECT COUNT(*) AS cnt FROM ${TABLE_NAME}`);
  const result = stmt.get() as { cnt: number };
  return result.cnt;
};

/** Euclidean norm of a Float32Array */
function norm(vec: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i];
  }
  return Math.sqrt(sum);
}

/**
 * Perform semantic vector search using brute-force cosine similarity.
 * No sqlite-vec dependency needed — pure JavaScript computation.
 */
export const semanticSearch = (
  db: Database.Database,
  queryEmbedding: Float32Array | number[],
  k: number = 10,
  maxDistance: number = 0.5,
): Array<{
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  distance: number;
}> => {
  const queryBuf = new Float32Array(queryEmbedding);
  const queryNorm = norm(queryBuf);
  if (queryNorm === 0) return [];

  const stmt = db.prepare(`
    SELECT node_id, chunk_index, start_line, end_line, embedding
    FROM ${TABLE_NAME}
  `);
  const rows = stmt.all() as Array<{
    node_id: string;
    chunk_index: number;
    start_line: number;
    end_line: number;
    embedding: Buffer;
  }>;

  const scored: Array<{
    nodeId: string;
    chunkIndex: number;
    startLine: number;
    endLine: number;
    distance: number;
  }> = [];

  for (const row of rows) {
    const embBuf = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
    const embNorm = norm(embBuf);
    if (embNorm === 0) continue;

    let dot = 0;
    for (let i = 0; i < queryBuf.length && i < embBuf.length; i++) {
      dot += queryBuf[i] * embBuf[i];
    }
    const cosine = dot / (queryNorm * embNorm);
    const distance = 1 - cosine;

    if (distance < maxDistance) {
      scored.push({
        nodeId: row.node_id,
        chunkIndex: row.chunk_index,
        startLine: row.start_line,
        endLine: row.end_line,
        distance,
      });
    }
  }

  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, k);
};

/**
 * Perform exact scan search (same as semanticSearch — brute-force cosine)
 */
export const exactScanSearch = semanticSearch;

/**
 * Close the database connection
 */
export const closeSqliteStore = (db: Database.Database): void => {
  if (db !== singletonDb) {
    db.close();
  }
};

/**
 * Get the table name (for external references)
 */
export const getEmbeddingTableName = (): string => TABLE_NAME;
