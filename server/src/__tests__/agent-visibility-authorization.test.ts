// [stenas:agent-visibility] Fork-only tests for per-agent visibility.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  instanceUserRoles,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import { accessService } from "../services/access.js";
import {
  AGENT_ACCESS_PERMISSION_KEY,
  agentVisibilityService,
  invalidateAgentVisibility,
  pruneOrgTreeForVisibility,
  resolveEffectiveAgentVisibility,
} from "../services/agent-visibility.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

type Db = Parameters<typeof authorizationService>[0];

async function seed(db: Db) {
  const company = await db
    .insert(companies)
    .values({ name: `Visibility ${randomUUID()}`, issuePrefix: `V${randomUUID().slice(0, 6).toUpperCase()}` })
    .returning()
    .then((rows) => rows[0]!);
  const mkAgent = (name: string) =>
    db
      .insert(agents)
      .values({ companyId: company.id, name: `${name} ${randomUUID()}`, role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} })
      .returning()
      .then((rows) => rows[0]!);
  const granted = await mkAgent("Granted");
  const hidden = await mkAgent("Hidden");
  const mkIssue = (assigneeAgentId: string | null, assigneeUserId: string | null = null) =>
    db
      .insert(issues)
      .values({ companyId: company.id, title: `Issue ${randomUUID()}`, status: "todo", priority: "medium", assigneeAgentId, assigneeUserId })
      .returning()
      .then((rows) => rows[0]!);
  const issueGranted = await mkIssue(granted.id);
  const issueHidden = await mkIssue(hidden.id);
  const issueUnassigned = await mkIssue(null);
  const users: Record<string, string> = {};
  for (const role of ["owner", "admin", "operator", "viewer"] as const) {
    const userId = `user-${role}-${randomUUID()}`;
    users[role] = userId;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: role,
    });
  }
  for (const role of ["operator", "viewer"]) {
    await agentVisibilityService(db as never).setUserAgentAccess(company.id, users[role]!, [granted.id], null);
  }
  return { company, granted, hidden, issueGranted, issueHidden, issueUnassigned, users };
}

function board(userId: string, companyId: string, role?: string): AuthorizationActor {
  return {
    type: "board",
    source: "session",
    userId,
    companyIds: [companyId],
    memberships: role ? [{ companyId, membershipRole: role, status: "active" }] : undefined,
    isInstanceAdmin: false,
  };
}

function issueResource(issue: { id: string; companyId: string; assigneeAgentId: string | null; assigneeUserId: string | null; status: string }) {
  return {
    type: "issue" as const,
    companyId: issue.companyId,
    issueId: issue.id,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    status: issue.status,
  };
}

describeEmbeddedPostgres("agent visibility authorization", () => {
  const ctx = useEmbeddedPostgres("paperclip-agent-visibility-authz-");

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_VISIBILITY = "on";
  });

  afterEach(() => {
    process.env.PAPERCLIP_AGENT_VISIBILITY = "on";
    delete process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE;
    invalidateAgentVisibility();
  });

  it("owners and admins see every agent; operators and viewers only granted ones", async () => {
    const s = await seed(ctx.db);
    const authz = authorizationService(ctx.db);
    for (const role of ["owner", "admin"]) {
      const decision = await authz.decide({
        actor: board(s.users[role]!, s.company.id, role),
        action: "agent:read",
        resource: { type: "agent", companyId: s.company.id, agentId: s.hidden.id },
      });
      expect(decision.allowed, role).toBe(true);
    }
    for (const role of ["operator", "viewer"]) {
      const hidden = await authz.decide({
        actor: board(s.users[role]!, s.company.id, role),
        action: "agent:read",
        resource: { type: "agent", companyId: s.company.id, agentId: s.hidden.id },
      });
      expect(hidden).toMatchObject({ allowed: false, reason: "deny_scope" });
      const granted = await authz.decide({
        actor: board(s.users[role]!, s.company.id, role),
        action: "agent:read",
        resource: { type: "agent", companyId: s.company.id, agentId: s.granted.id },
      });
      expect(granted.allowed, role).toBe(true);
    }
  });

  it("resolves the role from the database when the actor carries no memberships", async () => {
    const s = await seed(ctx.db);
    const decision = await authorizationService(ctx.db).decide({
      actor: board(s.users.operator!, s.company.id),
      action: "agent:read",
      resource: { type: "agent", companyId: s.company.id, agentId: s.hidden.id },
    });
    expect(decision.allowed).toBe(false);
  });

  it("defaults to deny for a restricted user without any grant", async () => {
    const s = await seed(ctx.db);
    const userId = `user-new-${randomUUID()}`;
    await ctx.db.insert(companyMemberships).values({
      companyId: s.company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "operator",
    });
    const visibility = await resolveEffectiveAgentVisibility(ctx.db, board(userId, s.company.id, "operator"), s.company.id);
    expect(visibility).toMatchObject({ restricted: true });
    expect(visibility.restricted && visibility.allowedAgentIds.size).toBe(0);
  });

  it("instance admins are unrestricted", async () => {
    const s = await seed(ctx.db);
    await ctx.db.insert(instanceUserRoles).values({ userId: s.users.operator!, role: "instance_admin" });
    const visibility = await resolveEffectiveAgentVisibility(ctx.db, board(s.users.operator!, s.company.id, "operator"), s.company.id);
    expect(visibility.restricted).toBe(false);
  });

  it("applies the own-or-granted task rule to read/comment/mutate and closes the missing-field bypass", async () => {
    const s = await seed(ctx.db);
    const authz = authorizationService(ctx.db);
    const actor = board(s.users.operator!, s.company.id, "operator");
    const extra = async (values: Record<string, string | null>) =>
      ctx.db
        .insert(issues)
        .values({ companyId: s.company.id, title: `Issue ${randomUUID()}`, status: "todo", priority: "medium", ...values })
        .returning()
        .then((rows) => rows[0]!);
    const me = s.users.operator!;
    const cases = [
      [s.issueGranted, true],
      [s.issueUnassigned, false],
      [s.issueHidden, false],
      [await extra({ createdByUserId: me }), true],
      [await extra({ assigneeUserId: me }), true],
      [await extra({ createdByAgentId: s.granted.id }), true],
      [await extra({ createdByAgentId: s.hidden.id }), false],
      [await extra({ assigneeUserId: s.users.owner!, createdByUserId: s.users.owner! }), false],
      [await extra({ createdByUserId: me, assigneeAgentId: s.hidden.id }), true],
    ] as const;
    for (const [issue, expected] of cases) {
      for (const action of ["issue:read", "issue:comment", "issue:mutate"] as const) {
        const decision = await authz.decide({ actor, action, resource: issueResource(issue) });
        expect(decision.allowed, `${action} ${issue.title}`).toBe(expected);
      }
    }
    // A resource without status/assignee fields used to fall through as
    // "unsupported" (which the delegation intersection treats as allowed).
    const bare = await authz.decide({
      actor,
      action: "issue:mutate",
      resource: { type: "issue", companyId: s.company.id, issueId: s.issueHidden.id },
    });
    expect(bare).toMatchObject({ allowed: false, reason: "deny_scope" });
  });

  it("denies assigning to a hidden agent and reassigning a hidden issue", async () => {
    const s = await seed(ctx.db);
    const authz = authorizationService(ctx.db);
    const actor = board(s.users.operator!, s.company.id, "operator");
    const toHidden = await authz.decide({
      actor,
      action: "tasks:assign",
      resource: { type: "issue", companyId: s.company.id, issueId: null, assigneeAgentId: s.hidden.id },
    });
    expect(toHidden).toMatchObject({ allowed: false, reason: "deny_scope" });
    const toGranted = await authz.decide({
      actor,
      action: "tasks:assign",
      resource: { type: "issue", companyId: s.company.id, issueId: null, assigneeAgentId: s.granted.id },
    });
    expect(toGranted.allowed).toBe(true);
    const fromHidden = await authz.decide({
      actor,
      action: "tasks:assign",
      resource: { type: "issue", companyId: s.company.id, issueId: s.issueHidden.id, assigneeAgentId: s.granted.id },
    });
    expect(fromHidden.allowed).toBe(false);
  });

  it("closes company_scope:read for direct restricted users only", async () => {
    const s = await seed(ctx.db);
    const authz = authorizationService(ctx.db);
    const operator = await authz.decide({
      actor: board(s.users.operator!, s.company.id, "operator"),
      action: "company_scope:read",
      resource: { type: "company", companyId: s.company.id },
    });
    expect(operator).toMatchObject({ allowed: false, reason: "deny_scope" });
    const owner = await authz.decide({
      actor: board(s.users.owner!, s.company.id, "owner"),
      action: "company_scope:read",
      resource: { type: "company", companyId: s.company.id },
    });
    expect(owner.allowed).toBe(true);
  });

  it("enforces the restriction on agents acting for a restricted user", async () => {
    const s = await seed(ctx.db);
    const authz = authorizationService(ctx.db);
    const delegated = (userId: string, role: string): AuthorizationActor => ({
      type: "agent",
      agentId: s.granted.id,
      companyId: s.company.id,
      source: "agent_jwt",
      onBehalfOfUserId: userId,
      onBehalfOfMemberships: [{ companyId: s.company.id, membershipRole: role, status: "active" }],
    });
    const forOperator = await authz.decide({
      actor: delegated(s.users.operator!, "operator"),
      action: "issue:read",
      resource: issueResource(s.issueHidden),
    });
    expect(forOperator).toMatchObject({ allowed: false, code: "RESPONSIBLE_USER_UNAUTHORIZED" });

    const forOwner = await authz.decide({
      actor: delegated(s.users.owner!, "owner"),
      action: "issue:read",
      resource: issueResource(s.issueHidden),
    });
    expect(forOwner.allowed).toBe(true);

    process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE = "shadow";
    const shadow = await authz.decide({
      actor: delegated(s.users.operator!, "operator"),
      action: "issue:read",
      resource: issueResource(s.issueHidden),
    });
    expect(shadow.allowed).toBe(true);
  });

  it("a delegated agent keeps access to its own issue after its user loses the grant", async () => {
    const s = await seed(ctx.db);
    await agentVisibilityService(ctx.db).setUserAgentAccess(s.company.id, s.users.operator!, [], null);
    const decision = await authorizationService(ctx.db).decide({
      actor: {
        type: "agent",
        agentId: s.granted.id,
        companyId: s.company.id,
        source: "agent_jwt",
        onBehalfOfUserId: s.users.operator!,
        onBehalfOfMemberships: [{ companyId: s.company.id, membershipRole: "operator", status: "active" }],
      },
      action: "issue:read",
      resource: issueResource(s.issueGranted),
    });
    expect(decision.allowed).toBe(true);
  });

  it("the kill switch disables all restrictions", async () => {
    const s = await seed(ctx.db);
    process.env.PAPERCLIP_AGENT_VISIBILITY = "off";
    const decision = await authorizationService(ctx.db).decide({
      actor: board(s.users.operator!, s.company.id, "operator"),
      action: "agent:read",
      resource: { type: "agent", companyId: s.company.id, agentId: s.hidden.id },
    });
    expect(decision.allowed).toBe(true);
  });

  it("member permission replace-all paths keep the agent-access grant", async () => {
    const s = await seed(ctx.db);
    const access = accessService(ctx.db);
    const member = await ctx.db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, s.company.id), eq(companyMemberships.principalId, s.users.operator!)))
      .then((rows) => rows[0]!);
    await access.setMemberPermissions(s.company.id, member.id, [{ permissionKey: "tasks:assign" }], null);
    await access.updateMemberAndPermissions(s.company.id, member.id, { membershipRole: "operator", grants: [] }, null);
    // A smuggled agents:access grant through the generic path is ignored.
    await access.setPrincipalGrants(
      s.company.id,
      "user",
      s.users.operator!,
      [{ permissionKey: AGENT_ACCESS_PERMISSION_KEY, scope: { agentIds: [s.hidden.id] } }],
      null,
    );
    const rows = await ctx.db
      .select()
      .from(principalPermissionGrants)
      .where(and(
        eq(principalPermissionGrants.companyId, s.company.id),
        eq(principalPermissionGrants.principalId, s.users.operator!),
        eq(principalPermissionGrants.permissionKey, AGENT_ACCESS_PERMISSION_KEY),
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope).toEqual({ agentIds: [s.granted.id] });
  });

  it("prunes hidden agents from the org tree and promotes visible reports", () => {
    const visibility = { restricted: true as const, companyId: "c", userId: "u", allowedAgentIds: new Set(["b", "d"]) };
    const tree = [{ id: "a", reports: [{ id: "b", reports: [] }, { id: "c", reports: [{ id: "d", reports: [] }] }] }];
    expect(pruneOrgTreeForVisibility(tree, visibility)).toEqual([
      { id: "b", reports: [] },
      { id: "d", reports: [] },
    ]);
  });
});
