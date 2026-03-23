# Workspace Indexing & Search — Engineering Document

> Source code is the source of truth. All claims below are backed by specific files and line numbers.
> Last updated: 2026-03-23

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Layers](#architecture-layers)
3. [Core Data Structures](#core-data-structures)
4. [Embedding Models](#embedding-models)
5. [Indexing Strategies](#indexing-strategies)
   - [Local Embeddings Index](#local-embeddings-index)
   - [Remote Code Search Index](#remote-code-search-index)
   - [TF-IDF + Semantic Hybrid](#tf-idf--semantic-hybrid)
6. [How Indexing Is Triggered](#how-indexing-is-triggered)
7. [How Search Works — End to End](#how-search-works--end-to-end)
8. [Ranking & Re-ranking](#ranking--re-ranking)
9. [Caching & Storage](#caching--storage)
10. [Ignore / Filter Rules](#ignore--filter-rules)
11. [Telemetry Events](#telemetry-events)
12. [Key File Index](#key-file-index)

---

## Overview

Copilot Chat's workspace search answers the question: *"given a natural language query, which code chunks in this workspace are most relevant?"*

The system uses vector embeddings (semantic similarity) as its primary signal, with optional LLM-based re-ranking on top. It supports two index back-ends that operate independently and can fall back to each other:

| Back-end | Where computation happens | Best for |
|---|---|---|
| **Local Embeddings** | Client (VS Code extension host) | Any workspace ≤ 750 files auto, up to 2 500 manual, up to 50 000 with expanded cap |
| **Remote Code Search** | GitHub / Azure DevOps servers | Large GitHub / ADO repositories already indexed remotely |

---

## Architecture Layers

```
Extension Host (UI / VS Code integration)
├── SemanticSearchTextSearchProvider          [extension/workspaceSemanticSearch/node/]
│     implements vscode.AITextSearchProvider
│     ↳ Entry point for VS Code AI Search panel
│
├── WorkspaceChunkSearch contribution         [extension/workspaceChunkSearch/vscode-node/]
│     ↳ Commands, status bar, indexing UX
│
Platform Services (core, testable, cross-platform)
├── IWorkspaceChunkSearchService              [platform/workspaceChunkSearch/node/workspaceChunkSearchService.ts]
│     WorkspaceChunkSearchService (facade)
│       └── WorkspaceChunkSearchServiceImpl  (holds the strategies)
│             ├── EmbeddingsChunkSearch       [node/embeddingsChunkSearch.ts]
│             ├── CodeSearchChunkSearch       [node/codeSearch/codeSearchChunkSearch.ts]
│             ├── TfidfChunkSearch            [node/tfidfChunkSearch.ts]
│             └── TfIdfWithSemanticChunkSearch[node/tfidfWithSemanticChunkSearch.ts]
│
├── WorkspaceChunkEmbeddingsIndex             [node/workspaceChunkEmbeddingsIndex.ts]
│     ↳ Manages the local embedding vector store
│
├── IEmbeddingsComputer                       [platform/embeddings/common/embeddingsComputer.ts]
│     ↳ Computes embedding vectors remotely via GitHub / CAPI endpoint
│
└── Embedding caches                          [platform/embeddings/common/embeddingsIndex.ts]
      ├── EmbeddingsCache (local JSON files)
      └── RemoteEmbeddingsCache (CDN + local fallback)
```

---

## Core Data Structures

All types below are real; file and line numbers are given.

### `EmbeddingType` — `src/platform/embeddings/common/embeddingsComputer.ts:15`
```typescript
class EmbeddingType {
  static text3small_512   = new EmbeddingType('text-embedding-3-small-512');
  static metis_1024_I16_Binary = new EmbeddingType('metis-1024-I16-Binary');
}
```

### `Embedding` / `EmbeddingVector` — same file:73-78
```typescript
type EmbeddingVector = readonly number[];
interface Embedding {
  type: EmbeddingType;
  value: EmbeddingVector;
}
```

### `FileChunk` and `FileChunkAndScore` — `src/platform/chunking/common/chunk.ts`
A **chunk** is a contiguous region of a file with its text:
```typescript
interface FileChunk {
  file: URI;
  text: string;
  range: { startLineNumber, startColumn, endLineNumber, endColumn };
}
interface FileChunkAndScore<T extends FileChunk = FileChunk> {
  chunk: T;
  distance?: EmbeddingDistance;  // dot-product similarity to query
}
```

### `WorkspaceChunkQuery` — `src/platform/workspaceChunkSearch/common/workspaceChunkSearch.ts:29`
```typescript
interface WorkspaceChunkQuery {
  rawQuery: string;
  resolveQuery(token): Promise<string>;               // may rephrase for ambiguity
  resolveQueryAndKeywords(token): Promise<ResolvedWorkspaceChunkQuery>;
}
// Extended with lazy embedding resolution:
interface WorkspaceChunkQueryWithEmbeddings extends WorkspaceChunkQuery {
  resolveQueryEmbeddings(token): Promise<Embedding>;
}
```

### `WorkspaceIndexState` — `src/platform/workspaceChunkSearch/node/workspaceChunkSearchService.ts:68`
```typescript
interface WorkspaceIndexState {
  remoteIndexState: CodeSearchRemoteIndexState;
  localIndexState: LocalEmbeddingsIndexState;
}
```

---

## Embedding Models

Source: `src/platform/embeddings/common/embeddingsComputer.ts:50-67`

| ID | Model | Dimensions | Query quantization | Document quantization |
|---|---|---|---|---|
| `text-embedding-3-small-512` | `text-embedding-3-small` | 512 | float32 | float32 |
| `metis-1024-I16-Binary` | `metis-I16-Binary` | 1024 | float16 | binary |

Which type is used is determined at startup by `IGithubAvailableEmbeddingTypesService.getPreferredType()`. The result is stored in `WorkspaceChunkSearchServiceImpl._embeddingType` and passed through to every sub-system.

**Similarity metric:** dot product (cosine proxy since vectors are normalized).
Source: `embeddingsComputer.ts:135-146`
```typescript
function dotProduct(a, b): number {
  let dp = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dp += a[i] * b[i];
  return dp;
}
```

---

## Indexing Strategies

### Local Embeddings Index

**Class:** `EmbeddingsChunkSearch` — `src/platform/workspaceChunkSearch/node/embeddingsChunkSearch.ts`

**Status enum** (line 30):
```typescript
enum LocalEmbeddingsIndexStatus {
  Disabled, Unknown, UpdatingIndex, Ready,
  TooManyFilesForAutomaticIndexing,
  TooManyFilesForAnyIndexing,
}
```

**File caps** (lines 57-63):
```typescript
static defaultAutomaticIndexingFileCap   =     750;  // auto-indexed
static defaultExpandedAutomaticIndexingFileCap = 50_000; // expanded cap (experiment flag)
static defaultManualIndexingFileCap      =   2_500;  // user-triggered
```

**Storage:** `extensionContext.storageUri` (workspace-scoped) — set in `WorkspaceChunkEmbeddingsIndex` constructor line 70.

**Parallel ops during indexing:** max 50 concurrent file operations — `workspaceChunkEmbeddingsIndex.ts:42`.

**How a search works** (lines 163-197):
1. Kick off `query.resolveQueryEmbeddings()` early (non-blocking).
2. Call `doInitialIndexing()` — builds index if not already built.
3. If status is `UpdatingIndex` or `Ready`, call `_embeddingsIndex.searchWorkspace()`.
4. Internally `searchWorkspace` calls `rankEmbeddings()` (dot product against every stored chunk embedding, top-N returned).

**Searching a subset of files** (for code search integration):
`searchSubsetOfFiles()` (line 203) — given a list of URIs from code search, compute embeddings for those files on the fly and rank them. This is how code search + local embeddings are combined.

---

### Remote Code Search Index

**Class:** `CodeSearchChunkSearch` — `src/platform/workspaceChunkSearch/node/codeSearch/codeSearchChunkSearch.ts`

**Status enum** — `src/platform/workspaceChunkSearch/node/codeSearch/codeSearchRepo.ts:24`:
```typescript
enum CodeSearchRepoStatus {
  NotResolvable, Resolving, CheckingStatus,
  NotYetIndexed, NotIndexable,
  CouldNotCheckIndexStatus, NotAuthorized,
  BuildingIndex, Ready
}
```

**Remote index state** — `codeSearchChunkSearch.ts:58`:
```typescript
interface CodeSearchRemoteIndexState {
  status: 'disabled' | 'initializing' | 'loaded';
  repos: ReadonlyArray<RepoEntry>;
  externalIngestState?: ExternalIngestStatus;  // for files not covered by code search
}
```

**Supported providers:**
- `GithubCodeSearchRepo` — GitHub code search API
- `AdoCodeSearchRepo` — Azure DevOps code search API

Source: `codeSearchRepo.ts:46` imports both.

**Search flow in `CodeSearchChunkSearch.searchWorkspace()`:**
1. Call `isAvailable()` — checks if any repos are in `Ready` state.
2. Call remote code search API with the text query to get matching file URIs.
3. Compute workspace diff (changed files since last index snapshot via `CodeSearchWorkspaceDiffTracker`).
4. For code search results: call `EmbeddingsChunkSearch.searchSubsetOfFiles()` to rank chunks within those files using local embeddings.
5. For diff files (not yet in remote index): run `TfIdfWithSemanticChunkSearch` over them.
6. Merge and return.

**External Ingest** (`ExternalIngestIndex` / `ExternalIngestClient`):
Handles files not covered by code search (e.g. Jupyter notebooks). Uses a separate external ML service. Status tracked as `ExternalIngestStatus`.

---

### TF-IDF + Semantic Hybrid

**Class:** `TfIdfWithSemanticChunkSearch` — `src/platform/workspaceChunkSearch/node/tfidfWithSemanticChunkSearch.ts`

Used as a fallback when:
- No remote index is available, and
- Local embeddings index is not ready yet (e.g., still building)

Also used by `CodeSearchChunkSearch` for the diff portion of the workspace (files changed since the last remote index snapshot).

Combines TF-IDF keyword matching (fast, no embeddings needed) with semantic embeddings for re-scoring.

---

## How Indexing Is Triggered

Source: `WorkspaceChunkSearchServiceImpl` constructor — `workspaceChunkSearchService.ts:276-297`

### Automatic triggers

1. **First search in workspace** (line 361):
   ```typescript
   const wasFirstSearchInWorkspace = !this._extensionContext.workspaceState.get(this.shouldEagerlyIndexKey, false);
   this._extensionContext.workspaceState.update(this.shouldEagerlyIndexKey, true);
   ```
   On the very first `searchFileChunks()` call the key is flipped to `true`. On next startup, if the key is `true` and code search is not available, local indexing is triggered automatically (lines 276-289).

2. **Auth upgrade** (line 291-297):
   ```typescript
   this._register(this._authUpgradeService.onDidGrantAuthUpgrade(() => {
     // experiment flag: copilotchat.workspaceChunkSearch.shouldRemoteIndexOnAuthUpgrade
     void this.triggerRemoteIndexing('auto', ...);
   }));
   ```

3. **Experiment flag** `copilotchat.workspaceChunkSearch.shouldEagerlyInitLocalIndex` controls whether eager local indexing on startup is enabled (default `true`).

### Manual triggers

Commands registered in `src/extension/workspaceChunkSearch/vscode-node/commands.ts`:
- `github.copilot.buildLocalWorkspaceIndex` → calls `triggerLocalIndexing('manual', ...)`
- `github.copilot.buildRemoteWorkspaceIndex` → calls `triggerRemoteIndexing('manual', ...)`

### `triggerLocalIndexing` routing logic (lines 334-341):

```typescript
async triggerLocalIndexing(trigger, telemetryInfo) {
  if (await this._codeSearchChunkSearch.isAvailable()) {
    // If remote is available, just reindex the diff
    await this._codeSearchChunkSearch.triggerDiffIndexing();
    return Result.ok(true);
  } else {
    return this._embeddingsChunkSearch.triggerLocalIndexing(trigger);
  }
}
```

---

## How Search Works — End to End

Entry point: `SemanticSearchTextSearchProvider.provideAITextSearchResults()` — `src/extension/workspaceSemanticSearch/node/semanticSearchTextSearchProvider.ts`

```
User types in VS Code Search panel
         │
         ▼
SemanticSearchTextSearchProvider.provideAITextSearchResults()
         │
         ├─ getKeywordsForContent(text)  — regex identifier extraction (line 92)
         │    /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g
         │
         ├─ workspaceChunkSearch.searchFileChunks(sizing, query, options, ...)
         │         │
         │         ├─ toQueryWithEmbeddings()  — kicks off remote embedding computation for the
         │         │   query string immediately, but doesn't block on it yet (line 480)
         │         │
         │         ├─ doSearchFileChunks()  — tries strategies in order:
         │         │     1. CodeSearchChunkSearch.searchWorkspace()
         │         │          → code search API → file URIs → EmbeddingsChunkSearch.searchSubsetOfFiles()
         │         │          → TfIdfWithSemantic for diff files
         │         │     2. (if code search unavailable) EmbeddingsChunkSearch.searchWorkspace()
         │         │          → local index → rankEmbeddings() dot product
         │         │     3. (if no index) TfIdfWithSemanticChunkSearch
         │         │     4. (last resort) full workspace scan
         │         │
         │         ├─ filterIgnoredChunks()  — removes .copilotignore / .gitignore hits (line 564)
         │         │
         │         ├─ (if enableRerank && rerankerService.isAvailable)
         │         │     rerankerService.rerank()  — external reranker service
         │         │
         │         └─ rerankResultIfNeeded()  — internal re-ranking (see below)
         │
         ├─ (optional LLM re-ranking in SemanticSearchTextSearchProvider)
         │     searchPanel intent → LLM prompt with chunks → parse JSON → combinedRanking()
         │
         └─ reportSearchResults() → findTextInFiles() → TextSearchMatch2 → VS Code UI
```

---

## Ranking & Re-ranking

### Stage 1 — Embedding similarity (inside each strategy)

`rankEmbeddings()` — `src/platform/embeddings/common/embeddingsComputer.ts:167`

```typescript
function rankEmbeddings(queryEmbedding, items, maxResults, options?) {
  return items
    .map(([value, embedding]) => ({ distance: dotProduct(embedding.value, queryEmbedding.value), value }))
    .filter(e => e.distance.value > (options?.minDistance ?? 0))
    .sort((a, b) => b.distance.value - a.distance.value)
    .slice(0, maxResults)
    // maxSpread filter: drop results further than (1 - maxSpread) * topScore
    .filter(x => x.distance.value >= results[0].distance.value * (1 - maxSpread));
}
```

`maxEmbeddingSpread = 0.65` (line 47 of `workspaceChunkSearchService.ts`) — results within 65% of the top score are retained.

### Stage 2 — LLM-based re-ranking (in `SemanticSearchTextSearchProvider`)

LLM is called via the `searchPanel` intent. Response format:
```typescript
type IRankResult = { file: string; query: string }[];
```
A chunk scores `1` if `chunk.file.path.endsWith(result.file) && chunk.chunk.text.includes(result.query)`, else `0`.

### Stage 3 — Combined ranking (`combinedRanking`) — `src/extension/workspaceSemanticSearch/node/combinedRank.ts`

```typescript
// 1. Normalize both score arrays to [0, 1]
normalizedChunk = (score - min) / (max - min)
normalizedLlm   = (score - min) / (max - min)

// 2. Weighted blend (equal weights)
combined = (chunkScore * 0.5) + (llmScore * 0.5)

// 3. Sort descending by combined score
// 4. Filter: max 5 files, max 3 chunks per file
```

Deduplication is applied before scoring: if a chunk's line range is already covered by a previously selected chunk in the same file, its LLM score is forced to 0.

### Stage 4 — External reranker (optional)

`IRerankerService` — `src/platform/workspaceChunkSearch/common/rerankerService.ts`

If `options.enableRerank` is true and the service is available, chunks are sent to an external reranker before the internal combined ranking. If the external call fails, it falls back to internal re-ranking (line 451).

---

## Caching & Storage

Source: `src/platform/embeddings/common/embeddingsIndex.ts`

### Local cache (`EmbeddingsCache` / `LocalEmbeddingsCache`)

- **Location:** `extensionContext.storageUri` (workspace) or `extensionContext.globalStorageUri` (global)
- **Format:** JSON files — `{ [key: string]: { embedding: EmbeddingVector } }`
- **Version key:** `${cacheKey}-version` stored in VS Code `Memento`
- **Invalidation:** version mismatch → full rebuild

### Remote cache (`RemoteEmbeddingsCache`)

Used for static embeddings of VS Code settings, commands, API completions, extensions — not workspace code.

- **CDN base URL:** `https://embeddings.vscode-cdn.net/{container}/v{version}/{type}/`
- **Files:**
  - `core.json` — VS Code built-in entries
  - `{extensionId}.json` — per-extension entries
  - `latest.txt` — current version
- **Containers:** `text-3-small` or `metis-1024-I16-Binary` (selected by embedding model)
- **Cache types** (`RemoteCacheType`): `settings`, `commands`, `api`, `extensions`, `project-templates`, `tools`
- **Fallback:** if CDN is unreachable, falls back to the local cache

### Workspace chunk cache (`WorkspaceChunkAndEmbeddingCache`)

Source: `src/platform/workspaceChunkSearch/node/workspaceChunkAndEmbeddingCache.ts`

Persists the per-file chunks + embeddings to disk so indexing survives restarts. The cache is version-validated on load; mismatches cause a full reindex.

---

## Ignore / Filter Rules

Source: `workspaceChunkSearchService.ts:564` — `filterIgnoredChunks()`

```typescript
private async filterIgnoredChunks(chunks) {
  return coalesce(await Promise.all(chunks.map(async entry => {
    const isIgnored = await this._ignoreService.isCopilotIgnored(entry.chunk.file);
    return isIgnored ? null : entry;
  })));
}
```

`IIgnoreService` combines:
- `.gitignore` patterns
- `.copilotignore` patterns (Copilot-specific exclusions)

Any chunk whose file URI is matched by either is dropped from results before ranking.

---

## Telemetry Events

All events below are real; comments come from GDPR annotations in source.

| Event | File | Key properties |
|---|---|---|
| `workspaceChunkSearch.created` | `workspaceChunkSearchService.ts:306` | `embeddingType` |
| `workspaceChunkSearchStrategy` | `workspaceChunkSearchService.ts:397` | `strategy`, `errorDiagMessage`, `embeddingType`, `execTime`, `workspaceIndexFileCount`, `wasFirstSearchInWorkspace` |
| `workspaceChunkSearch.perf.searchFileChunks` | `workspaceChunkSearchService.ts:469` | `status`, `embeddingType`, `execTime` |
| `embeddingsChunkSearch.perf.searchFileChunks` | `embeddingsChunkSearch.ts:191` | `status`, `workspaceSearchSource`, `execTime` |
| `embeddingsChunkSearch.perf.searchSubsetOfFiles` | `embeddingsChunkSearch.ts:~229` | `status`, `execTime` |
| `copilot.search.request` | `semanticSearchTextSearchProvider.ts` | `chunkCount`, `rankResult`, `combinedResultsCount`, `chunkSearchDuration`, `llmFilteringDuration`, `llmBestRank`, `llmWorstRank`, `strategy` |

State change events are debounced 250 ms (`workspaceChunkSearchService.ts:266-274`).

---

## Key File Index

| Purpose | Path |
|---|---|
| Public service interface | `src/platform/workspaceChunkSearch/node/workspaceChunkSearchService.ts` |
| Strategy interface | `src/platform/workspaceChunkSearch/common/workspaceChunkSearch.ts` |
| Local embeddings strategy | `src/platform/workspaceChunkSearch/node/embeddingsChunkSearch.ts` |
| Remote code search strategy | `src/platform/workspaceChunkSearch/node/codeSearch/codeSearchChunkSearch.ts` |
| Code search repo state machine | `src/platform/workspaceChunkSearch/node/codeSearch/codeSearchRepo.ts` |
| Workspace diff tracker | `src/platform/workspaceChunkSearch/node/codeSearch/workspaceDiff.ts` |
| External ingest | `src/platform/workspaceChunkSearch/node/codeSearch/externalIngestIndex.ts` |
| TF-IDF + semantic hybrid | `src/platform/workspaceChunkSearch/node/tfidfWithSemanticChunkSearch.ts` |
| Embedding vector store | `src/platform/workspaceChunkSearch/node/workspaceChunkEmbeddingsIndex.ts` |
| Chunk + embedding disk cache | `src/platform/workspaceChunkSearch/node/workspaceChunkAndEmbeddingCache.ts` |
| Embedding types & dot product | `src/platform/embeddings/common/embeddingsComputer.ts` |
| Cache hierarchy (local + CDN) | `src/platform/embeddings/common/embeddingsIndex.ts` |
| Remote embedding computation | `src/platform/embeddings/common/remoteEmbeddingsComputer.ts` |
| VS Code search panel entry point | `src/extension/workspaceSemanticSearch/node/semanticSearchTextSearchProvider.ts` |
| Combined ranking algorithm | `src/extension/workspaceSemanticSearch/node/combinedRank.ts` |
| Indexing commands & UX | `src/extension/workspaceChunkSearch/vscode-node/commands.ts` |
| Index status bar | `src/extension/workspaceChunkSearch/vscode-node/workspaceIndexingStatus.ts` |
| Reranker service interface | `src/platform/workspaceChunkSearch/common/rerankerService.ts` |
