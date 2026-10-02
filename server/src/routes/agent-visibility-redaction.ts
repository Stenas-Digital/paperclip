/**
 * [stenas:agent-visibility] Response redaction helpers for restricted actors.
 *
 * Fork-only. Issue payloads embed summaries of *other* issues (ancestors,
 * blockers, related work). The visibility rule needs creator columns those
 * summaries do not carry, so the ids are resolved in one batched query.
 */
import type { Db } from "@paperclipai/db";
import {
  isIssueVisible,
  loadIssueVisibilityFields,
  type AgentVisibility,
} from "../services/agent-visibility.js";

type WithId = { id: string };

function collectRelationIds(value: unknown, out: Set<string>) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const record = item as Record<string, unknown>;
    if (typeof record?.id === "string") out.add(record.id);
    collectRelationIds(record?.terminalBlockers, out);
  }
}

function collectPayloadIds(payload: Record<string, unknown>, out: Set<string>) {
  for (const key of ["ancestors", "blockedBy", "blocks"]) collectRelationIds(payload[key], out);
  const relatedWork = payload.relatedWork as { outbound?: unknown; inbound?: unknown } | undefined;
  for (const items of [relatedWork?.outbound, relatedWork?.inbound]) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const id = (item as { issue?: { id?: unknown } })?.issue?.id;
      if (typeof id === "string") out.add(id);
    }
  }
}

type Fields = Awaited<ReturnType<typeof loadIssueVisibilityFields>>;

function visibleId(visibility: AgentVisibility, fields: Fields, id: unknown) {
  return typeof id === "string" && isIssueVisible(visibility, fields.get(id));
}

function redactRelationList(visibility: AgentVisibility, fields: Fields, value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value
    .filter((item) => visibleId(visibility, fields, (item as WithId)?.id))
    .map((item) => {
      const record = item as Record<string, unknown>;
      if (!Array.isArray(record.terminalBlockers)) return item;
      return { ...record, terminalBlockers: redactRelationList(visibility, fields, record.terminalBlockers) };
    });
}

function redactWithFields<T extends object>(visibility: AgentVisibility, fields: Fields, payload: T): T {
  const record = payload as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  for (const key of ["ancestors", "blockedBy", "blocks"]) {
    if (key in record) next[key] = redactRelationList(visibility, fields, record[key]);
  }
  if (record.relatedWork && typeof record.relatedWork === "object") {
    const summary = record.relatedWork as { outbound?: unknown; inbound?: unknown };
    const keep = (items: unknown) =>
      Array.isArray(items)
        ? items.filter((item) => visibleId(visibility, fields, (item as { issue?: WithId }).issue?.id))
        : items;
    const relatedWork = { ...summary, outbound: keep(summary.outbound), inbound: keep(summary.inbound) };
    next.relatedWork = relatedWork;
    if ("referencedIssueIdentifiers" in record && Array.isArray(relatedWork.outbound)) {
      next.referencedIssueIdentifiers = (relatedWork.outbound as Array<{ issue: { identifier: string | null; id: string } }>)
        .map((item) => item.issue.identifier ?? item.issue.id);
    }
  }
  return next as T;
}

/** Keeps only visible issues from a list of issue summaries. */
export async function filterVisibleIssues<T extends WithId>(
  db: Db,
  visibility: AgentVisibility,
  items: readonly T[] | null | undefined,
): Promise<T[]> {
  if (!items) return [];
  if (!visibility.restricted) return [...items];
  const fields = await loadIssueVisibilityFields(db, items.map((item) => item.id));
  return items.filter((item) => isIssueVisible(visibility, fields.get(item.id)));
}

/** Drops hidden issues from embedded relation summaries on one issue payload. */
export async function redactIssueRelations<T extends object>(db: Db, visibility: AgentVisibility, payload: T): Promise<T> {
  if (!visibility.restricted) return payload;
  const ids = new Set<string>();
  collectPayloadIds(payload as Record<string, unknown>, ids);
  return redactWithFields(visibility, await loadIssueVisibilityFields(db, [...ids]), payload);
}

/** Batched variant for issue lists. */
export async function redactIssueRelationsMany<T extends object>(db: Db, visibility: AgentVisibility, payloads: T[]): Promise<T[]> {
  if (!visibility.restricted) return payloads;
  const ids = new Set<string>();
  for (const payload of payloads) collectPayloadIds(payload as Record<string, unknown>, ids);
  const fields = await loadIssueVisibilityFields(db, [...ids]);
  return payloads.map((payload) => redactWithFields(visibility, fields, payload));
}
