/**
 * Embedder Module
 *
 * Uses Ollama for embeddings via HTTP client.
 * No local model loading — all embedding done via Ollama API.
 */

import { DEFAULT_EMBEDDING_CONFIG, type EmbeddingConfig, type ModelProgress } from './types.js';
import { isHttpMode, getHttpDimensions, httpEmbed } from './http-client.js';
import { resolveEmbeddingConfig } from './config.js';

/**
 * Progress callback type for model loading
 */
export type ModelProgressCallback = (progress: ModelProgress) => void;

/**
 * Initialize the embedding model — no-op with Ollama
 */
export const initEmbedder = async (
  onProgress?: ModelProgressCallback,
  config: Partial<EmbeddingConfig> = {},
  forceDevice?: 'dml' | 'cuda' | 'cpu' | 'wasm',
): Promise<void> => {
  // Ollama handles model loading — nothing to do here
};

/**
 * Check if the embedder is initialized and ready (always true with Ollama)
 */
export const isEmbedderReady = (): boolean => true;

/**
 * Get the effective embedding dimensions.
 */
export const getEmbeddingDimensions = (): number => {
  return getHttpDimensions() ?? DEFAULT_EMBEDDING_CONFIG.dimensions;
};

/**
 * Embed a single text string
 */
export const embedText = async (text: string): Promise<Float32Array> => {
  const [vec] = await httpEmbed([text]);
  return vec;
};

/**
 * Embed multiple texts in a single batch
 */
export const embedBatch = async (texts: string[]): Promise<Float32Array[]> => {
  if (texts.length === 0) {
    return [];
  }
  return httpEmbed(texts);
};

/**
 * Convert Float32Array to regular number array (for storage)
 */
export const embeddingToArray = (embedding: Float32Array): number[] => {
  return Array.from(embedding);
};

/**
 * Cleanup the embedder
 */
export const disposeEmbedder = async (): Promise<void> => {
  // Nothing to clean up with Ollama
};
