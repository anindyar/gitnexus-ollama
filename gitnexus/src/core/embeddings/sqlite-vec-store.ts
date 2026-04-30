/**
 * SQLite Vector Store - Singleton Wrapper
 *
 * Provides a simple singleton interface for the SQLite vector store
 * used by the MCP local backend.
 */

import path from 'path';
import Database from 'better-sqlite3';
import { initSqliteStore, closeSqliteStore } from './sqlite-store.js';
import { semanticSearch as vecSearch, exactScanSearch } from './sqlite-store.js';

class VecStore {
  private db: Database.Database | null = null;
  private dbPath: string | null = null;

  /**
   * Initialize the vector store with a database path
   */
  init(dbPath: string, dimensions = 768): void {
    if (this.db) {
      closeSqliteStore(this.db);
    }
    this.dbPath = dbPath;
    this.db = initSqliteStore({ dbPath, dimensions });
  }

  /**
   * Perform semantic search
   */
  search(
    queryEmbedding: Float32Array | number[],
    k: number,
    maxDistance: number,
  ): Array<{
    nodeId: string;
    chunkIndex: number;
    startLine: number;
    endLine: number;
    distance: number;
  }> {
    if (!this.db) {
      throw new Error('VecStore not initialized. Call init() first.');
    }

    try {
      let results = vecSearch(this.db, queryEmbedding, k, maxDistance);

      // Fallback to exact scan if vector search returns nothing
      if (results.length === 0) {
        results = exactScanSearch(
          this.db,
          Array.from(queryEmbedding),
          k,
          maxDistance,
        );
      }

      return results;
    } catch (error) {
      console.error('VecStore search error:', error);
      return [];
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      closeSqliteStore(this.db);
      this.db = null;
      this.dbPath = null;
    }
  }
}

// Singleton instance
let vecStoreInstance: VecStore | null = null;

/**
 * Get the singleton vector store instance
 */
export const getVecStore = (): VecStore => {
  if (!vecStoreInstance) {
    vecStoreInstance = new VecStore();
  }
  return vecStoreInstance;
};

/**
 * Initialize the vector store (called once per repo)
 */
export const initVecStore = (storagePath: string): void => {
  const dbPath = path.join(storagePath, 'embeddings.db');
  const store = getVecStore();
  store.init(dbPath, 768); // nomic-embed-text produces 768-dim vectors
};

/**
 * Close the vector store
 */
export const closeVecStore = (): void => {
  const store = getVecStore();
  store.close();
  vecStoreInstance = null;
};