/**
 * Embedder Module (Read-Only) - MCP
 *
 * Uses Ollama for embeddings via HTTP client.
 * No local model loading — all embedding done via Ollama API.
 */

import { isHttpMode, getHttpDimensions, httpEmbedQuery } from '../../core/embeddings/http-client.js';

/**
 * Initialize the embedding model — no-op with Ollama
 */
export const initEmbedder = async (): Promise<void> => {
  // Ollama handles model loading — nothing to do here
};

/**
 * Check if embedder is ready (always true with Ollama)
 */
export const isEmbedderReady = (): boolean => true;

/**
 * Embed a query text for semantic search
 */
export const embedQuery = async (query: string): Promise<number[]> => {
  return httpEmbedQuery(query);
};

/**
 * Get embedding dimensions
 */
export const getEmbeddingDims = (): number => {
  return getHttpDimensions() ?? 768;
};

/**
 * Cleanup embedder — no-op with Ollama
 */
export const disposeEmbedder = async (): Promise<void> => {
  // No-op
};
