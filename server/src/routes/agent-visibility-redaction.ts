/**
 * [stenas:agent-visibility] Response redaction helpers for restricted actors.
 *
 * Fork-only. Issue payloads embed summaries of *other* issues (ancestors,
 * blockers, related work). Those summaries carry `assigneeAgentId`, so hidden
 * ones can be dropped without extra queries.
 */
import { isIssueVisible, type AgentVisibility } from "../services/agent-visibility.js";

type WithAssignee = { assigneeAgentId?: string | null };

export function filterVisibleIssues<T extends WithAssignee>(
  visibility: AgentVisibility,
  items: readonly T[] | null | undefined,
): T[] {
  if (!items) return [];
  if (!visibility.restricted) return [...items];
  return items.filter((item) => isIssueVisible(visibility, item));
}

function redactRelationList(visibility: AgentVisibility, value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value
    .filter((item) => isIssueVisible(visibility, item as WithAssignee))
    .map((item) => {
      const record = item as Record<string, unknown>;
      if (!Array.isArray(record.terminalBlockers)) return item;
      return { ...record, terminalBlockers: redactRelationList(visibility, record.terminalBlockers) };
    });
}

function redactRelatedWork(visibility: AgentVisibility, value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const summary = value as { outbound?: unknown; inbound?: unknown };
  const keep = (items: unknown) =>
    Array.isArray(items)
      ? items.filter((item) => isIssueVisible(visibility, (item as { issue?: WithAssignee }).issue ?? null))
      : items;
  return { ...summary, outbound: keep(summary.outbound), inbound: keep(summary.inbound) };
}

/** Drops hidden issues from embedded relation summaries on an issue payload. */
export function redactIssueRelations<T extends object>(visibility: AgentVisibility, payload: T): T {
  if (!visibility.restricted) return payload;
  const record = payload as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  for (const key of ["ancestors", "blockedBy", "blocks"]) {
    if (key in record) next[key] = redactRelationList(visibility, record[key]);
  }
  if ("relatedWork" in record) {
    const relatedWork = redactRelatedWork(visibility, record.relatedWork) as
      | { outbound?: Array<{ issue: { identifier: string | null; id: string } }> }
      | undefined;
    next.relatedWork = relatedWork;
    if ("referencedIssueIdentifiers" in record && Array.isArray(relatedWork?.outbound)) {
      next.referencedIssueIdentifiers = relatedWork.outbound.map((item) => item.issue.identifier ?? item.issue.id);
    }
  }
  return next as T;
}
