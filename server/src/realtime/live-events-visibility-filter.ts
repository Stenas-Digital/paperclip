/**
 * [stenas:agent-visibility] Per-connection filtering of company live events.
 *
 * Fork-only. Upstream forwards every company event to every member's socket.
 * For restricted board users this drops events that reference a hidden agent,
 * a hidden issue (assigned to a hidden agent) or a run of either. Unrestricted
 * sockets get a synchronous pass-through. Event order is preserved with a
 * per-connection promise chain; lookups fail closed (the event is dropped).
 */
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import {
  isAgentVisible,
  isIssueVisible,
  isMemberAccessChangeAction,
  resolveEffectiveAgentVisibility,
  type AgentVisibility,
} from "../services/agent-visibility.js";

const LOOKUP_TTL_MS = 3_000;
const LOOKUP_MAX_ENTRIES = 5_000;
const VISIBILITY_REFRESH_MS = 60_000;

type CacheEntry<T> = { expiresAt: number; promise: Promise<T> };

function createLookupCache<T>(load: (ids: string[]) => Promise<Map<string, T>>) {
  const entries = new Map<string, CacheEntry<T | null>>();
  return {
    evict(id: string) {
      entries.delete(id);
    },
    get(id: string): Promise<T | null> {
      const now = Date.now();
      const cached = entries.get(id);
      if (cached && cached.expiresAt > now) return cached.promise;
      if (entries.size >= LOOKUP_MAX_ENTRIES) {
        for (const [key, entry] of entries) {
          if (entry.expiresAt <= now || entries.size >= LOOKUP_MAX_ENTRIES) entries.delete(key);
          if (entries.size < LOOKUP_MAX_ENTRIES) break;
        }
      }
      const promise = load([id]).then((rows) => rows.get(id) ?? null);
      entries.set(id, { expiresAt: now + LOOKUP_TTL_MS, promise });
      void promise.catch(() => {
        if (entries.get(id)?.promise === promise) entries.delete(id);
      });
      return promise;
    },
  };
}

type IssueRef = { assigneeAgentId: string | null };
type RunRef = { agentId: string; issueId: string | null };

const cachesByDb = new WeakMap<object, {
  issues: ReturnType<typeof createLookupCache<IssueRef>>;
  runs: ReturnType<typeof createLookupCache<RunRef>>;
}>();

function cachesFor(db: Db) {
  let caches = cachesByDb.get(db);
  if (!caches) {
    caches = {
      issues: createLookupCache<IssueRef>(async (ids) => {
        const rows = await db
          .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
          .from(issues)
          .where(inArray(issues.id, ids));
        return new Map(rows.map((row) => [row.id, { assigneeAgentId: row.assigneeAgentId }]));
      }),
      runs: createLookupCache<RunRef>(async (ids) => {
        const rows = await db
          .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, contextSnapshot: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, ids[0]!));
        return new Map(rows.map((row) => {
          const snapshot = row.contextSnapshot as Record<string, unknown> | null;
          const issueId = typeof snapshot?.issueId === "string" ? snapshot.issueId : null;
          return [row.id, { agentId: row.agentId, issueId }];
        }));
      }),
    };
    cachesByDb.set(db, caches);
  }
  return caches;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Exposed for tests: decides whether a restricted socket may receive an event. */
export async function liveEventVisibleToRestricted(
  db: Db,
  visibility: AgentVisibility,
  event: LiveEvent,
): Promise<boolean> {
  if (!visibility.restricted) return true;
  const caches = cachesFor(db);
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const details = (payload.details && typeof payload.details === "object" ? payload.details : {}) as Record<
    string,
    unknown
  >;
  const entityType = str(payload.entityType);
  const entityId = str(payload.entityId);

  const agentIds = new Set<string>();
  const issueIds = new Set<string>();
  const directAgent = str(payload.agentId);
  if (directAgent) agentIds.add(directAgent);
  if (entityType === "agent" && entityId) agentIds.add(entityId);
  const directIssue = str(payload.issueId);
  if (directIssue) issueIds.add(directIssue);
  if (entityType === "issue" && entityId) {
    // A logged issue change may be a reassignment: re-read the assignee now.
    caches.issues.evict(entityId);
    issueIds.add(entityId);
  }
  const detailIssue = str(details.issueId);
  if (detailIssue) issueIds.add(detailIssue);

  for (const agentId of agentIds) {
    if (!isAgentVisible(visibility, agentId)) return false;
  }

  const runId = str(payload.runId);
  if (runId && agentIds.size === 0 && issueIds.size === 0) {
    const run = await caches.runs.get(runId);
    if (run) {
      if (!isAgentVisible(visibility, run.agentId)) return false;
      if (run.issueId) issueIds.add(run.issueId);
    }
  }

  for (const issueId of issueIds) {
    const issue = await caches.issues.get(issueId);
    if (issue && !isIssueVisible(visibility, issue)) return false;
  }
  return true;
}

/**
 * Wraps a socket sender so restricted board users only receive events about
 * what they can see. Agent-key sockets and the local trusted board pass through.
 */
export function createAgentVisibilityLiveEventListener(
  db: Db,
  context: { companyId: string; actorType: "board" | "agent"; actorId: string },
  send: (event: LiveEvent) => void,
): (event: LiveEvent) => void {
  if (context.actorType !== "board" || context.actorId === "board") return send;

  let visibility: AgentVisibility | null = null;
  let resolvedAt = 0;
  let stale = true;
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;

  const resolve = async () => {
    if (!stale && visibility && Date.now() - resolvedAt < VISIBILITY_REFRESH_MS) return visibility;
    // A fresh actor object bypasses the per-actor memo; the service's own
    // short TTL cache keeps this cheap.
    visibility = await resolveEffectiveAgentVisibility(
      db,
      { type: "board", userId: context.actorId, source: "session" },
      context.companyId,
    );
    resolvedAt = Date.now();
    stale = false;
    return visibility;
  };

  const handle = async (event: LiveEvent) => {
    try {
      const current = await resolve();
      if (!current.restricted) {
        send(event);
      } else if (await liveEventVisibleToRestricted(db, current, event)) {
        send(event);
      }
      if (event.type === "activity.logged" && isMemberAccessChangeAction((event.payload as Record<string, unknown>)?.action)) {
        stale = true;
      }
    } catch (err) {
      logger.warn({ err, companyId: context.companyId, eventType: event.type }, "live event visibility check failed; dropped");
    }
  };

  return (event: LiveEvent) => {
    // Fast path: known-unrestricted socket with nothing queued.
    if (pending === 0 && visibility && !visibility.restricted && !stale && Date.now() - resolvedAt < VISIBILITY_REFRESH_MS) {
      send(event);
      if (event.type === "activity.logged" && isMemberAccessChangeAction((event.payload as Record<string, unknown>)?.action)) {
        stale = true;
      }
      return;
    }
    pending += 1;
    chain = chain.then(() => handle(event)).finally(() => {
      pending -= 1;
    });
  };
}
