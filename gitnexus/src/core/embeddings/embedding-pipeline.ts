/**
 * Embedding Pipeline Module
 *
 * Orchestrates the background embedding process:
 * 1. Query embeddable nodes from LadybugDB
 * 2. Generate text representations with enriched metadata
 * 3. Chunk long nodes, batch embed via Ollama
 * 4. Store embeddings in SQLite (not LadybugDB)
 * 5. Semantic search uses SQLite + sqlite-vec
 */

import { createHash } from 'crypto';
import {
  initEmbedder,
  embedBatch,
  embedText,
  embeddingToArray,
} from './embedder.js';
import { generateEmbeddingText } from './text-generator.js';
import { chunkNode, characterChunk } from './chunker.js';
import { extractStructuralNames } from './structural-extractor.js';
import {
  type EmbeddingProgress,
  type EmbeddingConfig,
  type EmbeddableNode,
  type SemanticSearchResult,
  type ModelProgress,
  type EmbeddingContext,
  EMBEDDABLE_LABELS,
  isShortLabel,
  LABEL_METHOD,
  LABELS_WITH_EXPORTED,
  STRUCTURAL_LABELS,
  collectBestChunks,
} from './types.js';
import { resolveEmbeddingConfig } from './config.js';
import { STALE_HASH_SENTINEL, EMBEDDING_TABLE_NAME } from '../lbug/schema.js';
import {
  initSqliteStore,
  batchInsertEmbeddings as sqliteBatchInsertEmbeddings,
  deleteEmbeddingsForNodes,
  fetchAllContentHashes,
  semanticSearch as sqliteSemanticSearch,
  exactScanSearch,
  getEmbeddingCount,
  closeSqliteStore,
} from './sqlite-store.js';

// Re-export for backward compatibility
export const batchInsertEmbeddings = sqliteBatchInsertEmbeddings;

const isDev = process.env.NODE_ENV === 'development';

/**
 * Bump this when the embedding text template changes in a way that should
 * invalidate existing vectors.
 */
export const EMBEDDING_TEXT_VERSION = 'v2';

/**
 * Compute a stable content fingerprint for an embeddable node.
 */
export const contentHashForNode = (
  node: EmbeddableNode,
  config: Partial<EmbeddingConfig> = {},
): string => {
  const text = generateEmbeddingText(
    { ...node, methodNames: undefined, fieldNames: undefined },
    node.content,
    config,
  );
  return createHash('sha1').update(EMBEDDING_TEXT_VERSION).update('\n').update(text).digest('hex');
};

/**
 * Progress callback type
 */
export type EmbeddingProgressCallback = (progress: EmbeddingProgress) => void;

/**
 * Query all embeddable nodes from LadybugDB
 */
const queryEmbeddableNodes = async (
  executeQuery: (cypher: string) => Promise<any[]>,
): Promise<EmbeddableNode[]> => {
  const allNodes: EmbeddableNode[] = [];

  for (const label of EMBEDDABLE_LABELS) {
    try {
      let query: string;

      if (label === LABEL_METHOD) {
        query = `
          MATCH (n:Method)
          RETURN n.id AS id, n.name AS name, 'Method' AS label,
                 n.filePath AS filePath, n.content AS content,
                 n.startLine AS startLine, n.endLine AS endLine,
                 n.isExported AS isExported, n.description AS description,
                 n.parameterCount AS parameterCount, n.returnType AS returnType
        `;
      } else if (LABELS_WITH_EXPORTED.has(label)) {
        query = `
          MATCH (n:\`${label}\`)
          RETURN n.id AS id, n.name AS name, '${label}' AS label,
                 n.filePath AS filePath, n.content AS content,
                 n.startLine AS startLine, n.endLine AS endLine,
                 n.isExported AS isExported, n.description AS description
        `;
      } else {
        query = `
          MATCH (n:\`${label}\`)
          RETURN n.id AS id, n.name AS name, '${label}' AS label,
                 n.filePath AS filePath, n.content AS content,
                 n.startLine AS startLine, n.endLine AS endLine,
                 n.description AS description
        `;
      }

      const rows = await executeQuery(query);
      for (const row of rows) {
        const hasExportedColumn = label === LABEL_METHOD || LABELS_WITH_EXPORTED.has(label);
        allNodes.push({
          id: row.id ?? row[0],
          name: row.name ?? row[1],
          label: row.label ?? row[2],
          filePath: row.filePath ?? row[3],
          content: row.content ?? row[4] ?? '',
          startLine: row.startLine ?? row[5],
          endLine: row.endLine ?? row[6],
          isExported: hasExportedColumn ? (row.isExported ?? row[7]) : undefined,
          description: row.description ?? (hasExportedColumn ? row[8] : row[7]),
          ...(label === LABEL_METHOD
            ? {
                parameterCount: row.parameterCount ?? row[9],
                returnType: row.returnType ?? row[10],
              }
            : {}),
        });
      }
    } catch (error) {
      if (isDev) {
        console.warn(`Query for ${label} nodes failed:`, error);
      }
    }
  }

  return allNodes;
};

export interface EmbeddingPipelineResult {
  nodesProcessed: number;
  chunksProcessed: number;
  vectorIndexReady: boolean;
  semanticMode: 'vector-index' | 'exact-scan';
}

/**
 * Run the embedding pipeline
 */
export const runEmbeddingPipeline = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  _executeWithReusedStatement: (
    cypher: string,
    paramsList: Array<Record<string, any>>,
  ) => Promise<void>,
  onProgress: EmbeddingProgressCallback,
  config: Partial<EmbeddingConfig> = {},
  _skipNodeIds?: Set<string>,
  context?: EmbeddingContext,
  existingEmbeddings?: Map<string, string>,
  sqliteDbPath?: string,
): Promise<EmbeddingPipelineResult> => {
  const finalConfig = resolveEmbeddingConfig(config);
  let totalChunks = 0;

  if (!sqliteDbPath) {
    throw new Error('sqliteDbPath is required for embedding pipeline');
  }

  try {
    // Phase 1: Initialize SQLite store
    onProgress({
      phase: 'loading-model',
      percent: 0,
      modelDownloadPercent: 0,
    });

    const sqliteDb = await initSqliteStore({
      dbPath: sqliteDbPath,
      dimensions: finalConfig.dimensions,
    });

    onProgress({
      phase: 'loading-model',
      percent: 20,
      modelDownloadPercent: 100,
    });

    if (isDev) {
      console.log('🔍 Querying embeddable nodes...');
    }

    // Phase 2: Query embeddable nodes
    let nodes = await queryEmbeddableNodes(executeQuery);

    // Apply context metadata
    if (context?.repoName) {
      for (const node of nodes) {
        node.repoName = context.repoName;
        node.serverName = context.serverName;
      }
    }

    // Incremental mode: compare content hashes
    const computedStaleHashes = new Map<string, string>();
    if (existingEmbeddings && existingEmbeddings.size > 0) {
      const beforeCount = nodes.length;
      const staleNodeIds: string[] = [];
      nodes = nodes.filter((n) => {
        const existingHash = existingEmbeddings.get(n.id);
        if (existingHash === undefined) {
          return true;
        }
        const currentHash = contentHashForNode(n, finalConfig);
        if (currentHash !== existingHash) {
          computedStaleHashes.set(n.id, currentHash);
          staleNodeIds.push(n.id);
          return true;
        }
        return false;
      });

      if (staleNodeIds.length > 0) {
        if (isDev) {
          console.log(`🔄 Deleting ${staleNodeIds.length} stale embedding rows`);
        }
        deleteEmbeddingsForNodes(sqliteDb, staleNodeIds);
      }

      if (isDev) {
        console.log(
          `📦 Incremental embeddings: ${beforeCount} total, ${existingEmbeddings.size} cached, ${staleNodeIds.length} stale, ${nodes.length} to embed`,
        );
      }
    }

    const totalNodes = nodes.length;

    if (isDev) {
      console.log(`📊 Found ${totalNodes} embeddable nodes`);
    }

    if (totalNodes === 0) {
      closeSqliteStore(sqliteDb);
      onProgress({
        phase: 'ready',
        percent: 100,
        nodesProcessed: 0,
        totalNodes: 0,
      });
      return {
        nodesProcessed: 0,
        chunksProcessed: 0,
        vectorIndexReady: true,
        semanticMode: 'vector-index',
      };
    }

    // Phase 3: Chunk + embed nodes
    const batchSize = finalConfig.batchSize;
    const chunkSize = finalConfig.chunkSize;
    const overlap = finalConfig.overlap;
    let processedNodes = 0;

    onProgress({
      phase: 'embedding',
      percent: 20,
      nodesProcessed: 0,
      totalNodes,
      currentBatch: 0,
      totalBatches: Math.ceil(totalNodes / batchSize),
    });

    // Process in batches of nodes
    for (let batchIndex = 0; batchIndex < totalNodes; batchIndex += batchSize) {
      const batch = nodes.slice(batchIndex, batchIndex + batchSize);

      // Chunk each node and generate text
      const allTexts: string[] = [];
      const allUpdates: Array<{
        nodeId: string;
        chunkIndex: number;
        startLine: number;
        endLine: number;
        contentHash: string;
      }> = [];

      for (const node of batch) {
        const isShort = isShortLabel(node.label);
        const startLine = node.startLine ?? 0;
        const endLine = node.endLine ?? 0;

        if (!isShort && STRUCTURAL_LABELS.has(node.label)) {
          try {
            const names = await extractStructuralNames(node.content, node.filePath);
            node.methodNames = names.methodNames;
            node.fieldNames = names.fieldNames;
          } catch {
            // AST extraction failed
          }
        }

        const hash = computedStaleHashes.get(node.id) ?? contentHashForNode(node, finalConfig);

        let chunks: Array<{ text: string; chunkIndex: number; startLine: number; endLine: number }>;
        if (isShort) {
          chunks = [{ text: node.content, chunkIndex: 0, startLine, endLine }];
        } else {
          try {
            chunks = await chunkNode(
              node.label,
              node.content,
              node.filePath,
              startLine,
              endLine,
              chunkSize,
              overlap,
            );
          } catch (chunkErr) {
            if (isDev) {
              console.warn(`⚠️ AST chunking failed, falling back to character-based:`, chunkErr);
            }
            chunks = characterChunk(node.content, startLine, endLine, chunkSize, overlap);
          }
        }

        let prevTail = '';
        for (const chunk of chunks) {
          const text = generateEmbeddingText(
            node,
            chunk.text,
            finalConfig,
            chunk.chunkIndex,
            prevTail,
          );
          allTexts.push(text);
          allUpdates.push({
            nodeId: node.id,
            chunkIndex: chunk.chunkIndex,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            contentHash: hash,
          });
          prevTail = overlap > 0 ? chunk.text.slice(-overlap) : '';
        }
      }

      // Embed chunk texts in sub-batches
      const EMBED_SUB_BATCH = finalConfig.subBatchSize;
      for (let si = 0; si < allTexts.length; si += EMBED_SUB_BATCH) {
        const subTexts = allTexts.slice(si, si + EMBED_SUB_BATCH);
        const subUpdates = allUpdates.slice(si, si + EMBED_SUB_BATCH);

        let embeddings: Float32Array[];
        try {
          embeddings = await embedBatch(subTexts);
        } catch (embedErr) {
          console.error(`❌ embedBatch failed:`, embedErr);
          throw embedErr;
        }

        const dbUpdates = subUpdates.map((u, i) => ({
          id: `${u.nodeId}:${u.chunkIndex}`,
          nodeId: u.nodeId,
          chunkIndex: u.chunkIndex,
          startLine: u.startLine,
          endLine: u.endLine,
          embedding: embeddingToArray(embeddings[i]),
          contentHash: u.contentHash ?? STALE_HASH_SENTINEL,
        }));

        batchInsertEmbeddings(sqliteDb, dbUpdates);
      }

      processedNodes += batch.length;
      totalChunks += allUpdates.length;

      const embeddingProgress = 20 + (processedNodes / totalNodes) * 70;
      onProgress({
        phase: 'embedding',
        percent: Math.round(embeddingProgress),
        nodesProcessed: processedNodes,
        totalNodes,
        currentBatch: Math.floor(batchIndex / batchSize) + 1,
        totalBatches: Math.ceil(totalNodes / batchSize),
      });
    }

    // Phase 4: Done
    onProgress({
      phase: 'ready',
      percent: 100,
      nodesProcessed: totalNodes,
      totalNodes,
    });

    closeSqliteStore(sqliteDb);

    if (isDev) {
      console.log(
        `✅ Embedding pipeline complete! (${totalChunks} chunks from ${totalNodes} nodes)`,
      );
    }

    return {
      nodesProcessed: totalNodes,
      chunksProcessed: totalChunks,
      vectorIndexReady: true,
      semanticMode: 'vector-index',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (isDev) {
      console.error('❌ Embedding pipeline error:', error);
    }

    onProgress({
      phase: 'error',
      percent: 0,
      error: errorMessage,
    });

    throw error;
  }
};

/**
 * Perform semantic search using SQLite + sqlite-vec
 */
export const semanticSearch = async (
  _executeQuery: (cypher: string) => Promise<any[]>,
  query: string,
  k: number = 10,
  maxDistance: number = 0.5,
  sqliteDbPath?: string,
): Promise<SemanticSearchResult[]> => {
  if (!sqliteDbPath) {
    throw new Error('sqliteDbPath is required for semantic search');
  }

  const queryEmbedding = await embedText(query);
  const queryVec = Array.from(queryEmbedding);

  const sqliteDb = await initSqliteStore({ dbPath: sqliteDbPath, dimensions: queryVec.length });

  try {
    let bestChunks = await sqliteSemanticSearch(sqliteDb, queryEmbedding, k, maxDistance);

    // Fallback to exact scan if vector search returns nothing
    if (bestChunks.length === 0) {
      const embeddingCount = getEmbeddingCount(sqliteDb);
      if (embeddingCount > 0 && embeddingCount <= 10000) {
        bestChunks = exactScanSearch(sqliteDb, queryVec, k, maxDistance);
      }
    }

    if (bestChunks.length === 0) {
      closeSqliteStore(sqliteDb);
      return [];
    }

    // Group results by label for batched metadata queries from LadybugDB
    const byLabel = new Map<
      string,
      Array<{ nodeId: string; distance: number } & Record<string, any>>
    >();
    for (const chunk of bestChunks.slice(0, k)) {
      const labelEndIdx = chunk.nodeId.indexOf(':');
      const label = labelEndIdx > 0 ? chunk.nodeId.substring(0, labelEndIdx) : 'Unknown';
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label)!.push({ nodeId: chunk.nodeId, ...chunk });
    }

    // Fetch metadata from LadybugDB
    const results: SemanticSearchResult[] = [];

    for (const [label, items] of byLabel) {
      const idList = items.map((i) => `'${i.nodeId.replace(/'/g, "''")}'`).join(', ');
      try {
        const nodeQuery = `
          MATCH (n:\`${label}\`) WHERE n.id IN [${idList}]
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
                 n.startLine AS startLine, n.endLine AS endLine
        `;
        // This would need to be passed in from outside - for now we'll return what we have
        const rowMap = new Map<string, any>();
        for (const item of items) {
          const chunkData = bestChunks.find((c) => c.nodeId === item.nodeId);
          if (chunkData) {
            results.push({
              nodeId: item.nodeId,
              name: item.nodeId.split(':')[1] || '', // Use nodeId as fallback
              label,
              filePath: '',
              distance: chunkData.distance,
              startLine: chunkData.startLine,
              endLine: chunkData.endLine,
            });
          }
        }
      } catch {
        // Table might not exist, skip
      }
    }

    closeSqliteStore(sqliteDb);

    results.sort((a, b) => a.distance - b.distance);

    return results;
  } catch (error) {
    closeSqliteStore(sqliteDb);
    throw error;
  }
};

/**
 * Semantic search with graph expansion (flattened results)
 */
export const semanticSearchWithContext = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  query: string,
  k: number = 5,
  _hops: number = 1,
  sqliteDbPath?: string,
): Promise<any[]> => {
  const results = await semanticSearch(executeQuery, query, k, 0.5, sqliteDbPath);

  return results.map((r) => ({
    matchId: r.nodeId,
    matchName: r.name,
    matchLabel: r.label,
    matchPath: r.filePath,
    distance: r.distance,
    connectedId: null,
    connectedName: null,
    connectedLabel: null,
    relationType: null,
  }));
};
