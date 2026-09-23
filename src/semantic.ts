import { join } from 'node:path';
import { z } from 'zod';
import { atomicWrite, readText } from './fs.js';
import { ensure, hash } from './model.js';
import type { Memory } from './model.js';
import type { Store } from './store.js';
import { settings } from './settings.js';

// Configuration comes only from the launching environment, never from recalled text.
export function embeddingConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.CO_MEMO_SEMANTIC !== '1') return null;
  try {
    const endpoint = new URL(env.CO_MEMO_EMBEDDING_URL ?? '');
    ensure(
      endpoint.protocol === 'https:' ||
        (endpoint.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)),
      'Invalid endpoint',
    );
    ensure(
      !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
      'Invalid endpoint',
    );
    const model = z.string().trim().min(1).max(200).parse(env.CO_MEMO_EMBEDDING_MODEL);
    const threshold = z
      .number()
      .min(0)
      .max(1)
      .parse(Number(env.CO_MEMO_EMBEDDING_THRESHOLD ?? '0.65'));
    return {
      endpoint: endpoint.href,
      model,
      threshold,
      key: env.CO_MEMO_EMBEDDING_API_KEY,
      namespace: hash(
        JSON.stringify([endpoint.href, model, env.CO_MEMO_EMBEDDING_REVISION ?? '', 'content-v1']),
      ),
    };
  } catch {
    throw new Error(
      'Invalid semantic configuration; check CO_MEMO_EMBEDDING_URL, MODEL and THRESHOLD',
    );
  }
}
type Config = NonNullable<ReturnType<typeof embeddingConfig>>;
const Vector = z.array(z.number().finite()).min(1).max(8192);
function unit(input: unknown): number[] {
  const v = Vector.parse(input);
  const scale = Math.max(...v.map(Math.abs));
  ensure(scale > 0, 'Zero vector');
  const norm = Math.sqrt(v.reduce((sum, n) => sum + (n / scale) ** 2, 0));
  return v.map((n) => n / scale / norm);
}
async function embed(config: Config, input: string): Promise<number[]> {
  // Includes response streaming, not just time to headers. Never log provider bodies or keys.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input, encoding_format: 'float' }),
    });
    ensure(response.ok && response.body, 'Embedding request failed');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      ensure(size <= 1024 * 1024, 'Embedding response too large');
      chunks.push(chunk);
    }
    const result = z
      .object({ data: z.array(z.object({ index: z.literal(0), embedding: Vector })).length(1) })
      .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    return unit(result.data[0]!.embedding);
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
function path(store: Store, config: Config, memory: Memory) {
  return join(store.home, 'embeddings-v1', config.namespace, `${memory.id}.json`);
}
function cached(store: Store, config: Config, memory: Memory): number[] | null {
  try {
    const text = readText(path(store, config, memory));
    if (!text) return null;
    const value = z
      .object({ version: z.number(), digest: z.string(), vector: Vector })
      .parse(JSON.parse(text));
    return value.version === memory.version && value.digest === hash(memory.content)
      ? unit(value.vector)
      : null;
  } catch {
    return null; // A corrupt or missing derived cache must never break lexical recall.
  }
}
function eligible(store: Store, projectId: string) {
  return settings(store, projectId).paused ? [] : store.search(projectId);
}

/** Explicit indexing only: sends eligible memory text, never runs implicitly on a read. */
export async function indexEmbeddings(store: Store, projectId: string, limit = 100) {
  const config = embeddingConfig();
  ensure(config, 'Semantic retrieval is disabled; set CO_MEMO_SEMANTIC=1 and configure a provider');
  ensure(Number.isSafeInteger(limit) && limit > 0 && limit <= 1000, 'Index limit must be 1..1000');
  const pending = store.lock(() => {
    ensure(!settings(store, projectId).paused, 'Co-memo is paused');
    return eligible(store, projectId).filter((m) => !cached(store, config, m));
  });
  let indexed = 0,
    skipped = 0,
    failed = 0;
  for (const snapshot of pending.slice(0, limit)) {
    const current = store.lock(() =>
      eligible(store, projectId).find(
        (m) => m.id === snapshot.id && m.version === snapshot.version,
      ),
    );
    if (!current) {
      skipped++;
      continue;
    }
    let vector: number[];
    try {
      vector = await embed(config, current.content);
    } catch {
      failed++;
      break;
    }
    store.lock(() => {
      // Another process may edit/delete/conflict/pause while the provider is running.
      if (
        !eligible(store, projectId).some(
          (m) => m.id === current.id && m.version === current.version,
        )
      ) {
        skipped++;
        return;
      }
      const target = path(store, config, current);
      const old = readText(target);
      atomicWrite(
        target,
        JSON.stringify({ version: current.version, digest: hash(current.content), vector }),
        old === null ? null : hash(old),
      );
      indexed++;
    });
  }
  const remaining = store.lock(
    () => eligible(store, projectId).filter((m) => !cached(store, config, m)).length,
  );
  return {
    indexed,
    skipped,
    failed,
    remaining,
    paused: store.lock(() => settings(store, projectId).paused),
  };
}

export interface SemanticRanking {
  mode: 'lexical' | 'hybrid';
  reason:
    | 'disabled'
    | 'no_query'
    | 'include_deleted'
    | 'invalid_configuration'
    | 'no_cache'
    | 'provider_unavailable'
    | 'ready'
    | 'paused';
  matches: { id: string; version: number; score: number }[];
}
/** Snapshot under lock, await outside it, then merge only against current eligible notes. */
export async function semanticRanking(
  store: Store,
  projectId: string,
  query?: string,
  deleted = false,
): Promise<SemanticRanking> {
  const fallback = (reason: SemanticRanking['reason']): SemanticRanking => ({
    mode: 'lexical',
    reason,
    matches: [],
  });
  if (!query?.trim()) return fallback('no_query');
  if (deleted) return fallback('include_deleted');
  let config: Config | null;
  try {
    config = embeddingConfig();
  } catch {
    return fallback('invalid_configuration');
  }
  if (!config) return fallback('disabled');
  const snapshot = store.lock(() =>
    eligible(store, projectId).flatMap((m) => {
      const vector = cached(store, config, m);
      return vector ? [{ id: m.id, version: m.version, vector }] : [];
    }),
  );
  if (!snapshot.length) return fallback('no_cache');
  try {
    const vector = await embed(config, query.slice(0, 16000));
    // A dimension change invalidates this search rather than mixing incompatible spaces.
    ensure(
      snapshot.every((m) => m.vector.length === vector.length),
      'Embedding dimensions changed',
    );
    return {
      mode: 'hybrid',
      reason: 'ready',
      matches: snapshot
        .map((m) => ({
          id: m.id,
          version: m.version,
          score: m.vector.reduce((sum, n, i) => sum + n * vector[i]!, 0),
        }))
        .filter((m) => m.score >= config.threshold)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, 100),
    };
  } catch {
    return fallback('provider_unavailable');
  }
}

/** Called with the store lock held; never returns the asynchronous snapshot's note text. */
export function hybridSearch(
  store: Store,
  projectId: string,
  query: string | undefined,
  deleted: boolean,
  ranking: SemanticRanking,
): Memory[] {
  if (settings(store, projectId).paused) return [];
  const lexical = store.search(projectId, query, deleted);
  if (ranking.mode !== 'hybrid') return lexical;
  const current = new Map(eligible(store, projectId).map((m) => [m.id, m]));
  const semantic = ranking.matches.flatMap((m) => {
    const note = current.get(m.id);
    return note?.version === m.version ? [note] : [];
  });
  const merged = new Map<string, { memory: Memory; score: number }>();
  for (const list of [lexical, semantic])
    list.forEach((memory, i) => {
      const previous = merged.get(memory.id);
      merged.set(memory.id, { memory, score: (previous?.score ?? 0) + 1 / (60 + i + 1) });
    });
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id))
    .slice(0, 100)
    .map((m) => m.memory);
}
