/**
 * [stenas:agent-visibility] Per-agent visibility for restricted board users.
 *
 * Fork-only module (Stenas-Digital/paperclip). Owners and admins (and instance
 * admins / the local implicit board) see every agent. Every other company role
 * sees only the agents granted to them through an `agents:access` permission
 * grant whose scope is `{ agentIds: string[] }`. No grant means no agents.
 *
 * A task (issue) is visible to a restricted user iff it has no assignee agent
 * (unassigned or assigned to a human) or its assignee agent is visible.
 *
 * Agents acting on behalf of a responsible user inherit that user's
 * visibility (plus themselves), mirroring the responsible-user intersection in
 * authorization.ts.
 *
 * The grant is deliberately never evaluated through `scopeAllows` /
 * `decidePrincipalGrant`: there an empty `agentIds` list means "unconstrained".
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyMemberships,
  instanceUserRoles,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { subscribeAllCompanyLiveEvents } from "./live-events.js";

export const AGENT_ACCESS_PERMISSION_KEY = "agents:access" as const;

const UNRESTRICTED_COMPANY_ROLES = new Set(["owner", "admin"]);
const USER_STATE_TTL_MS = 5_000;

export type AgentVisibility =
  | {
      restricted: false;
      reason: "disabled" | "local_implicit" | "instance_admin" | "owner" | "admin" | "agent_actor";
    }
  | {
      restricted: true;
      companyId: string;
      userId: string | null;
      allowedAgentIds: ReadonlySet<string>;
      /** No active membership: upstream authorization denies on its own. */
      noMembership?: boolean;
    };

type MembershipLike = { companyId: string; membershipRole?: string | null; status?: string };

/** Structural subset of both Express `req.actor` and `AuthorizationActor`. */
export type AgentVisibilityActor = {
  type: "board" | "agent" | "none";
  userId?: string | null;
  source?: string | null;
  isInstanceAdmin?: boolean;
  ignoreInstanceAdmin?: boolean;
  memberships?: MembershipLike[];
  agentId?: string | null;
  onBehalfOfUserId?: string | null;
  onBehalfOfMemberships?: MembershipLike[];
  delegatedByAgentId?: string | null;
};

type UserState = {
  hasMembership: boolean;
  membershipRole: string | null;
  isInstanceAdmin: boolean;
  agentIds: string[];
};

type DbLike = Pick<Db, "select" | "insert" | "delete" | "update" | "transaction">;

export function agentVisibilityDisabled() {
  return process.env.PAPERCLIP_AGENT_VISIBILITY?.trim().toLowerCase() === "off";
}

function responsibleUserShadowMode() {
  // Mirrors responsibleUserAuthzShadowMode() in authorization.ts (not imported
  // to avoid a circular module dependency).
  const mode = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE?.trim().toLowerCase();
  const shadow = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW?.trim().toLowerCase();
  return mode === "shadow" || shadow === "1" || shadow === "true" || shadow === "yes";
}

export function readAgentAccessScope(scope: unknown): string[] {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return [];
  const raw = (scope as Record<string, unknown>).agentIds;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

// ---------------------------------------------------------------------------
// Process-level cache of per-user state, invalidated by member/grant changes.
// ---------------------------------------------------------------------------

const userStateCache = new Map<string, { expiresAt: number; promise: Promise<UserState> }>();
let invalidationSubscribed = false;

function cacheKey(companyId: string, userId: string) {
  return `${companyId}:${userId}`;
}

export function invalidateAgentVisibility(companyId?: string, userId?: string) {
  if (!companyId) {
    userStateCache.clear();
    return;
  }
  if (userId) {
    userStateCache.delete(cacheKey(companyId, userId));
    return;
  }
  for (const key of userStateCache.keys()) {
    if (key.startsWith(`${companyId}:`)) userStateCache.delete(key);
  }
}

export function isMemberAccessChangeAction(action: unknown) {
  return typeof action === "string" && (action.startsWith("company_member.") || action.startsWith("join."));
}

function ensureInvalidationSubscription() {
  if (invalidationSubscribed) return;
  invalidationSubscribed = true;
  subscribeAllCompanyLiveEvents((event) => {
    if (event.type !== "activity.logged") return;
    if (isMemberAccessChangeAction(event.payload?.action)) invalidateAgentVisibility(event.companyId);
  });
}

async function loadUserState(db: DbLike, companyId: string, userId: string): Promise<UserState> {
  const [membership, adminRole, grant] = await Promise.all([
    db
      .select({ membershipRole: companyMemberships.membershipRole })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null),
    db
      .select({ scope: principalPermissionGrants.scope })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, userId),
          eq(principalPermissionGrants.permissionKey, AGENT_ACCESS_PERMISSION_KEY),
        ),
      )
      .then((rows) => rows[0] ?? null),
  ]);
  return {
    hasMembership: Boolean(membership),
    membershipRole: membership?.membershipRole ?? null,
    isInstanceAdmin: Boolean(adminRole),
    agentIds: readAgentAccessScope(grant?.scope),
  };
}

function getUserState(db: DbLike, companyId: string, userId: string): Promise<UserState> {
  ensureInvalidationSubscription();
  const key = cacheKey(companyId, userId);
  const now = Date.now();
  const cached = userStateCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = loadUserState(db, companyId, userId);
  userStateCache.set(key, { expiresAt: now + USER_STATE_TTL_MS, promise });
  void promise.catch(() => {
    if (userStateCache.get(key)?.promise === promise) userStateCache.delete(key);
  });
  return promise;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const actorMemo = new WeakMap<object, Map<string, Promise<AgentVisibility>>>();

function memoize(actor: object, key: string, compute: () => Promise<AgentVisibility>) {
  let byKey = actorMemo.get(actor);
  if (!byKey) {
    byKey = new Map();
    actorMemo.set(actor, byKey);
  }
  const existing = byKey.get(key);
  if (existing) return existing;
  const promise = compute();
  byKey.set(key, promise);
  void promise.catch(() => {
    if (byKey?.get(key) === promise) byKey.delete(key);
  });
  return promise;
}

function restrictedEmpty(companyId: string, userId: string | null): AgentVisibility {
  return { restricted: true, companyId, userId, allowedAgentIds: new Set() };
}

async function resolveBoardUser(
  db: DbLike,
  actor: AgentVisibilityActor,
  companyId: string,
): Promise<AgentVisibility> {
  if (agentVisibilityDisabled()) return { restricted: false, reason: "disabled" };
  if (actor.source === "local_implicit") return { restricted: false, reason: "local_implicit" };
  const userId = actor.userId?.trim() || null;
  if (!userId) return restrictedEmpty(companyId, null);

  if (!actor.ignoreInstanceAdmin && actor.isInstanceAdmin) {
    return { restricted: false, reason: "instance_admin" };
  }
  const actorMembership = actor.memberships?.find(
    (membership) => membership.companyId === companyId && (membership.status ?? "active") === "active",
  );
  const actorRole = actorMembership?.membershipRole ?? null;
  if (actorRole && UNRESTRICTED_COMPANY_ROLES.has(actorRole)) {
    return { restricted: false, reason: actorRole as "owner" | "admin" };
  }

  const state = await getUserState(db, companyId, userId);
  if (!actor.ignoreInstanceAdmin && actor.source !== "cloud_tenant" && state.isInstanceAdmin) {
    return { restricted: false, reason: "instance_admin" };
  }
  const role = actorRole ?? state.membershipRole;
  if (role && UNRESTRICTED_COMPANY_ROLES.has(role)) {
    return { restricted: false, reason: role as "owner" | "admin" };
  }

  const allowed = new Set(state.agentIds);
  if (actor.delegatedByAgentId) allowed.add(actor.delegatedByAgentId);
  return {
    restricted: true,
    companyId,
    userId,
    allowedAgentIds: allowed,
    ...(!actorMembership && !state.hasMembership ? { noMembership: true } : {}),
  };
}

/** Visibility of a board actor as seen by `decideBase` (no delegation expansion). */
export function resolveBoardAgentVisibility(
  db: DbLike,
  actor: AgentVisibilityActor,
  companyId: string,
): Promise<AgentVisibility> {
  return memoize(actor, `board:${companyId}`, () => resolveBoardUser(db, actor, companyId));
}

/**
 * Effective visibility for any request actor: board users resolve as
 * themselves; agents acting for a responsible user resolve as that user plus
 * themselves; agents without a responsible user are unrestricted.
 */
export function resolveEffectiveAgentVisibility(
  db: DbLike,
  actor: AgentVisibilityActor | null | undefined,
  companyId: string,
): Promise<AgentVisibility> {
  if (!actor || actor.type === "none") return Promise.resolve(restrictedEmpty(companyId, null));
  if (actor.type === "board") return resolveBoardAgentVisibility(db, actor, companyId);
  return memoize(actor, `effective:${companyId}`, async () => {
    if (agentVisibilityDisabled()) return { restricted: false, reason: "disabled" };
    const responsibleUserId = actor.onBehalfOfUserId?.trim();
    if (!responsibleUserId || responsibleUserShadowMode()) {
      return { restricted: false, reason: "agent_actor" };
    }
    return resolveBoardUser(
      db,
      {
        type: "board",
        userId: responsibleUserId,
        source: "session",
        isInstanceAdmin: false,
        ignoreInstanceAdmin: true,
        memberships: actor.onBehalfOfMemberships,
        delegatedByAgentId: actor.agentId ?? null,
      },
      companyId,
    );
  });
}

// ---------------------------------------------------------------------------
// Predicates and SQL helpers
// ---------------------------------------------------------------------------

export function isAgentVisible(visibility: AgentVisibility, agentId: string | null | undefined) {
  if (!visibility.restricted) return true;
  return Boolean(agentId && visibility.allowedAgentIds.has(agentId));
}

export function isIssueVisible(
  visibility: AgentVisibility,
  issue: { assigneeAgentId?: string | null } | null | undefined,
) {
  if (!visibility.restricted) return true;
  if (!issue) return false;
  return !issue.assigneeAgentId || visibility.allowedAgentIds.has(issue.assigneeAgentId);
}

export function visibleAgentIdList(visibility: AgentVisibility): string[] | null {
  return visibility.restricted ? [...visibility.allowedAgentIds] : null;
}

/** SQL condition restricting issues to the visible set, or undefined when unrestricted. */
export function agentVisibilityIssueCondition(
  visibility: AgentVisibility | { allowedAgentIds: readonly string[] } | null | undefined,
  assigneeColumn: AnyPgColumn = issues.assigneeAgentId,
): SQL | undefined {
  if (!visibility) return undefined;
  if ("restricted" in visibility && !visibility.restricted) return undefined;
  const ids = [...visibility.allowedAgentIds];
  if (ids.length === 0) return isNull(assigneeColumn);
  return or(isNull(assigneeColumn), inArray(assigneeColumn, ids));
}

/** SQL condition restricting an agent-id column to visible agents (null column = not agent-scoped, kept). */
export function agentVisibilityAgentCondition(
  visibility: AgentVisibility | null | undefined,
  agentColumn: AnyPgColumn,
  options: { keepNull?: boolean } = {},
): SQL | undefined {
  if (!visibility || !visibility.restricted) return undefined;
  const ids = [...visibility.allowedAgentIds];
  const inSet = ids.length > 0 ? inArray(agentColumn, ids) : sql`false`;
  return options.keepNull ? or(isNull(agentColumn), inSet) : inSet;
}

export function filterVisibleAgentIds(visibility: AgentVisibility, agentIds: readonly string[]) {
  if (!visibility.restricted) return [...agentIds];
  return agentIds.filter((agentId) => visibility.allowedAgentIds.has(agentId));
}

type RunLike = { agentId?: string | null; issueId?: string | null; contextSnapshot?: unknown };

function runIssueId(run: RunLike): string | null {
  if (typeof run.issueId === "string" && run.issueId) return run.issueId;
  const snapshot = run.contextSnapshot;
  if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    const issueId = (snapshot as Record<string, unknown>).issueId;
    if (typeof issueId === "string" && issueId) return issueId;
  }
  return null;
}

/** Loads assignee agent ids for the given issues (missing issues are omitted). */
export async function loadIssueAssignees(db: DbLike, issueIds: readonly string[]) {
  const unique = [...new Set(issueIds.filter(Boolean))];
  if (unique.length === 0) return new Map<string, string | null>();
  const rows = await db
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(inArray(issues.id, unique));
  return new Map(rows.map((row) => [row.id, row.assigneeAgentId]));
}

/** Drops runs whose agent is hidden or whose task is hidden. */
export async function filterRunsForVisibility<T extends RunLike>(
  db: DbLike,
  visibility: AgentVisibility,
  runs: readonly T[],
): Promise<T[]> {
  if (!visibility.restricted) return [...runs];
  const agentVisible = runs.filter((run) => isAgentVisible(visibility, run.agentId));
  const assignees = await loadIssueAssignees(
    db,
    agentVisible.map(runIssueId).filter((id): id is string => Boolean(id)),
  );
  return agentVisible.filter((run) => {
    const issueId = runIssueId(run);
    if (!issueId || !assignees.has(issueId)) return true;
    return isIssueVisible(visibility, { assigneeAgentId: assignees.get(issueId) ?? null });
  });
}

// ---------------------------------------------------------------------------
// Org tree pruning
// ---------------------------------------------------------------------------

type OrgNodeLike = { id: string; reports?: OrgNodeLike[] } & Record<string, unknown>;

/**
 * Removes hidden agents from an org tree. Visible descendants of a hidden node
 * are promoted to the nearest visible ancestor (or the root list).
 */
export function pruneOrgTreeForVisibility<T extends OrgNodeLike>(nodes: T[], visibility: AgentVisibility): T[] {
  if (!visibility.restricted) return nodes;
  const prune = (list: OrgNodeLike[]): OrgNodeLike[] => {
    const out: OrgNodeLike[] = [];
    for (const node of list) {
      const reports = prune(Array.isArray(node.reports) ? node.reports : []);
      if (visibility.allowedAgentIds.has(node.id)) {
        out.push({ ...node, reports });
      } else {
        out.push(...reports);
      }
    }
    return out;
  };
  return prune(nodes) as T[];
}

/** Nulls `reportsTo` when it references a hidden agent. */
export function redactHiddenManager<T extends { reportsTo?: string | null }>(row: T, visibility: AgentVisibility): T {
  if (!visibility.restricted || !row.reportsTo || visibility.allowedAgentIds.has(row.reportsTo)) return row;
  return { ...row, reportsTo: null };
}

// ---------------------------------------------------------------------------
// Authorization hook (called from decideBase for board actors)
// ---------------------------------------------------------------------------

type HookResource =
  | { type: "company"; companyId: string }
  | { type: "agent"; companyId: string; agentId?: string | null }
  | { type: "project"; companyId: string; projectId?: string | null }
  | {
      type: "issue";
      companyId: string;
      issueId?: string | null;
      parentIssueId?: string | null;
      assigneeAgentId?: string | null;
    };

const AGENT_SCOPED_ACTIONS = new Set([
  "agent:read",
  "agent:wake",
  "agent_config:read",
  "agent_config:update",
  "skill_config:update",
]);
const ISSUE_ACTIONS = new Set(["issue:read", "issue:comment", "issue:mutate"]);

/**
 * Returns a denial explanation when a restricted board actor may not perform
 * the action, or null to fall through to upstream logic unchanged.
 */
export async function decideAgentVisibilityForBoard(
  db: DbLike,
  input: {
    actor: AgentVisibilityActor;
    action: string;
    resource: HookResource;
    loadIssueAssignee: (issueId: string) => Promise<{ companyId: string; assigneeAgentId: string | null } | null>;
  },
): Promise<{ explanation: string } | null> {
  const { action, resource } = input;
  const relevant =
    AGENT_SCOPED_ACTIONS.has(action) ||
    ISSUE_ACTIONS.has(action) ||
    action === "tasks:assign" ||
    action === "company_scope:read";
  if (!relevant) return null;

  const visibility = await resolveBoardAgentVisibility(db, input.actor, resource.companyId);
  if (!visibility.restricted) return null;
  // Non-members are denied by upstream with a more precise reason.
  if (visibility.noMembership) return null;

  const hiddenAgent = { explanation: "Agent is not visible to this user (restricted agent visibility)." };
  const hiddenIssue = { explanation: "Issue is not visible to this user (restricted agent visibility)." };

  const issueHidden = async (issueId: string | null | undefined, knownAssignee?: string | null) => {
    if (!issueId) return false;
    if (knownAssignee !== undefined) return !isIssueVisible(visibility, { assigneeAgentId: knownAssignee });
    const issue = await input.loadIssueAssignee(issueId);
    if (!issue || issue.companyId !== resource.companyId) return false; // let upstream answer
    return !isIssueVisible(visibility, issue);
  };

  if (AGENT_SCOPED_ACTIONS.has(action)) {
    if (resource.type === "agent" && resource.agentId && !isAgentVisible(visibility, resource.agentId)) {
      return hiddenAgent;
    }
    return null;
  }

  if (ISSUE_ACTIONS.has(action)) {
    if (resource.type !== "issue") return null;
    if (resource.issueId) {
      return (await issueHidden(resource.issueId, resource.assigneeAgentId)) ? hiddenIssue : null;
    }
    if (resource.parentIssueId && (await issueHidden(resource.parentIssueId))) return hiddenIssue;
    return null;
  }

  if (action === "tasks:assign") {
    if (resource.type !== "issue") return null;
    if (resource.assigneeAgentId && !isAgentVisible(visibility, resource.assigneeAgentId)) return hiddenAgent;
    // The existing issue (reassignment) and the parent (child create) must be visible too.
    if (resource.issueId && (await issueHidden(resource.issueId))) return hiddenIssue;
    if (resource.parentIssueId && (await issueHidden(resource.parentIssueId))) return hiddenIssue;
    return null;
  }

  // company_scope:read — closed for direct restricted users so every
  // company-wide endpoint fails closed unless it filters explicitly. Agents
  // acting for a restricted user keep it (their flows depend on it) and are
  // still bound by the per-resource checks above.
  if (input.actor.delegatedByAgentId) return null;
  return {
    explanation: "Company-wide read access is limited for users with restricted agent visibility.",
  };
}

// ---------------------------------------------------------------------------
// Grant management
// ---------------------------------------------------------------------------

export function agentVisibilityService(db: Db) {
  async function getUserAgentAccess(companyId: string, userId: string): Promise<string[]> {
    const row = await db
      .select({ scope: principalPermissionGrants.scope })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, userId),
          eq(principalPermissionGrants.permissionKey, AGENT_ACCESS_PERMISSION_KEY),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return readAgentAccessScope(row?.scope);
  }

  async function assertAgentsInCompany(companyId: string, agentIds: string[]) {
    if (agentIds.length === 0) return [];
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
    const found = new Set(rows.map((row) => row.id));
    return agentIds.filter((id) => !found.has(id));
  }

  async function setUserAgentAccess(
    companyId: string,
    userId: string,
    agentIds: string[],
    grantedByUserId: string | null,
  ): Promise<{ previous: string[]; next: string[] }> {
    const next = [...new Set(agentIds)].sort();
    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: principalPermissionGrants.id, scope: principalPermissionGrants.scope })
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, "user"),
            eq(principalPermissionGrants.principalId, userId),
            eq(principalPermissionGrants.permissionKey, AGENT_ACCESS_PERMISSION_KEY),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const previous = readAgentAccessScope(existing?.scope).sort();
      if (next.length === 0) {
        if (existing) {
          await tx.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, existing.id));
        }
      } else if (existing) {
        await tx
          .update(principalPermissionGrants)
          .set({ scope: { agentIds: next }, grantedByUserId, updatedAt: new Date() })
          .where(eq(principalPermissionGrants.id, existing.id));
      } else {
        await tx.insert(principalPermissionGrants).values({
          companyId,
          principalType: "user",
          principalId: userId,
          permissionKey: AGENT_ACCESS_PERMISSION_KEY,
          scope: { agentIds: next },
          grantedByUserId,
        });
      }
      return { previous, next };
    });
    invalidateAgentVisibility(companyId, userId);
    return result;
  }

  async function grantAgent(companyId: string, userId: string, agentId: string, grantedByUserId: string | null) {
    const current = await getUserAgentAccess(companyId, userId);
    if (current.includes(agentId)) return { previous: current, next: current };
    return setUserAgentAccess(companyId, userId, [...current, agentId], grantedByUserId);
  }

  return { getUserAgentAccess, setUserAgentAccess, grantAgent, assertAgentsInCompany };
}
