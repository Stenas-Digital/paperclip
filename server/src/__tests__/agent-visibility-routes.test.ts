// [stenas:agent-visibility] Fork-only route coverage for per-agent visibility.
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companyMemberships,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { activityRoutes } from "../routes/activity.js";
import { agentAccessRoutes } from "../routes/agent-access.js";
import { agentRoutes } from "../routes/agents.js";
import { agentVisibilityGuardRoutes } from "../routes/agent-visibility-guard.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { issueRoutes } from "../routes/issues.js";
import { invalidateAgentVisibility, agentVisibilityService } from "../services/agent-visibility.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

type Db = Parameters<typeof agentVisibilityService>[0];

const ROUTERS = [
  agentVisibilityGuardRoutes,
  agentAccessRoutes,
  issueRoutes,
  agentRoutes,
  activityRoutes,
  dashboardRoutes,
] as never[];

async function seed(db: Db) {
  const owner = await seedCompanyWithBoardAccess(db, "Agent visibility");
  const companyId = owner.companyId;
  const mkAgent = (name: string, reportsTo: string | null = null) =>
    db
      .insert(agents)
      .values({
        companyId,
        name: `${name}-${randomUUID().slice(0, 8)}`,
        role: "engineer",
        reportsTo,
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
  const hidden = await mkAgent("Hidden");
  const granted = await mkAgent("Granted", hidden.id);
  const mkIssue = (title: string, assigneeAgentId: string | null, parentId: string | null = null) =>
    db
      .insert(issues)
      .values({ companyId, title, status: "todo", priority: "medium", assigneeAgentId, parentId })
      .returning()
      .then((rows) => rows[0]!);
  const issueHidden = await mkIssue("Zebra hidden task", hidden.id);
  const issueGranted = await mkIssue("Zebra granted task", granted.id, issueHidden.id);
  const issueUnassigned = await mkIssue("Zebra unassigned task", null);

  const operatorId = `user-operator-${randomUUID()}`;
  const [operatorMembership] = await db
    .insert(companyMemberships)
    .values({ companyId, principalType: "user", principalId: operatorId, status: "active", membershipRole: "operator" })
    .returning();
  await agentVisibilityService(db).setUserAgentAccess(companyId, operatorId, [granted.id], owner.userId);
  const operator: BoardActor = {
    type: "board",
    source: "session",
    userId: operatorId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: false,
  };
  return { owner, operator, operatorMembership: operatorMembership!, companyId, hidden, granted, issueHidden, issueGranted, issueUnassigned };
}

describeEmbeddedPostgres("agent visibility routes", () => {
  const ctx = useEmbeddedPostgres("paperclip-agent-visibility-routes-");

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_VISIBILITY = "on";
  });

  afterEach(() => invalidateAgentVisibility());

  const app = (actor: BoardActor) => routeApp(ctx.db as never, actor, ...ROUTERS);

  it("filters the issue list and count for restricted users only", async () => {
    const s = await seed(ctx.db);
    const operatorList = await request(app(s.operator)).get(`/api/companies/${s.companyId}/issues`).expect(200);
    const operatorIds = (operatorList.body as Array<{ id: string }>).map((issue) => issue.id).sort();
    expect(operatorIds).toEqual([s.issueGranted.id, s.issueUnassigned.id].sort());

    const ownerList = await request(app(s.owner.actor)).get(`/api/companies/${s.companyId}/issues`).expect(200);
    expect((ownerList.body as unknown[]).length).toBe(3);

    await ctx.db.update(issues).set({ status: "blocked" }).where(eqId(s.issueHidden.id));
    await ctx.db.update(issues).set({ status: "blocked" }).where(eqId(s.issueUnassigned.id));
    const countPath = `/api/companies/${s.companyId}/issues/count?attention=blocked`;
    const ownerCount = await request(app(s.owner.actor)).get(countPath).expect(200);
    const operatorCount = await request(app(s.operator)).get(countPath).expect(200);
    expect(ownerCount.body.count).toBeGreaterThan(0);
    expect(operatorCount.body.count).toBe(ownerCount.body.count - 1);
  });

  it("returns 404 for hidden issues and their sub-resources and redacts hidden ancestors", async () => {
    const s = await seed(ctx.db);
    await request(app(s.operator)).get(`/api/issues/${s.issueHidden.id}`).expect(404);
    await request(app(s.operator)).get(`/api/issues/${s.issueHidden.id}/comments`).expect(404);
    await request(app(s.operator))
      .post(`/api/issues/${s.issueHidden.id}/comments`)
      .send({ body: "sneaky" })
      .expect(404);
    const visible = await request(app(s.operator)).get(`/api/issues/${s.issueGranted.id}`).expect(200);
    expect(visible.body.ancestors).toEqual([]);
    const ownerView = await request(app(s.owner.actor)).get(`/api/issues/${s.issueGranted.id}`).expect(200);
    expect(ownerView.body.ancestors).toHaveLength(1);
  });

  it("blocks creating or reassigning work to a hidden agent", async () => {
    const s = await seed(ctx.db);
    await request(app(s.operator))
      .post(`/api/companies/${s.companyId}/issues`)
      .send({ title: "to hidden", assigneeAgentId: s.hidden.id })
      .expect(403);
    await request(app(s.operator))
      .patch(`/api/issues/${s.issueUnassigned.id}`)
      .send({ assigneeAgentId: s.hidden.id })
      .expect(403);
    await request(app(s.operator))
      .post(`/api/companies/${s.companyId}/issues`)
      .send({ title: "to granted", assigneeAgentId: s.granted.id })
      .expect(201);
  });

  it("hides a task from its creator once it is reassigned to a hidden agent", async () => {
    const s = await seed(ctx.db);
    await ctx.db.update(issues).set({ assigneeAgentId: s.hidden.id }).where(eqId(s.issueUnassigned.id));
    await request(app(s.operator)).get(`/api/issues/${s.issueUnassigned.id}`).expect(404);
  });

  it("hides agents in lists, detail, org chart and chat", async () => {
    const s = await seed(ctx.db);
    const list = await request(app(s.operator)).get(`/api/companies/${s.companyId}/agents`).expect(200);
    const agentRows = list.body as Array<{ id: string; reportsTo: string | null }>;
    expect(agentRows.map((agent) => agent.id)).toEqual([s.granted.id]);
    expect(agentRows[0]!.reportsTo).toBeNull();
    await request(app(s.operator)).get(`/api/agents/${s.hidden.id}`).expect(404);
    await request(app(s.operator)).post(`/api/agents/${s.hidden.id}/wakeup`).send({}).expect(404);
    await request(app(s.operator)).get(`/api/companies/${s.companyId}/chats/${s.hidden.id}`).expect(404);
    const org = await request(app(s.operator)).get(`/api/companies/${s.companyId}/org`).expect(200);
    expect((org.body as Array<{ id: string }>).map((node) => node.id)).toEqual([s.granted.id]);
  });

  it("filters runs, activity and dashboard counts", async () => {
    const s = await seed(ctx.db);
    const [hiddenRun] = await ctx.db
      .insert(heartbeatRuns)
      .values({ companyId: s.companyId, agentId: s.hidden.id, status: "succeeded", contextSnapshot: {} })
      .returning();
    await ctx.db
      .insert(heartbeatRuns)
      .values({ companyId: s.companyId, agentId: s.granted.id, status: "succeeded", contextSnapshot: {} });
    const runs = await request(app(s.operator)).get(`/api/companies/${s.companyId}/heartbeat-runs`).expect(200);
    expect((runs.body as Array<{ agentId: string }>).every((run) => run.agentId === s.granted.id)).toBe(true);
    await request(app(s.operator)).get(`/api/heartbeat-runs/${hiddenRun!.id}`).expect(404);

    await ctx.db.insert(activityLog).values([
      { companyId: s.companyId, actorType: "agent", actorId: s.hidden.id, agentId: s.hidden.id, action: "issue.updated", entityType: "issue", entityId: s.issueHidden.id },
      { companyId: s.companyId, actorType: "agent", actorId: s.granted.id, agentId: s.granted.id, action: "issue.updated", entityType: "issue", entityId: s.issueGranted.id },
    ]);
    const activity = await request(app(s.operator)).get(`/api/companies/${s.companyId}/activity`).expect(200);
    const entityIds = (activity.body as Array<{ entityId: string }>).map((row) => row.entityId);
    expect(entityIds).toContain(s.issueGranted.id);
    expect(entityIds).not.toContain(s.issueHidden.id);

    const dashboard = await request(app(s.operator)).get(`/api/companies/${s.companyId}/dashboard`).expect(200);
    expect(dashboard.body.tasks.open).toBe(2);
    expect(dashboard.body.agents.active).toBe(1);
  });

  it("silently drops @mentions of hidden agents", async () => {
    const s = await seed(ctx.db);
    await request(app(s.operator))
      .post(`/api/issues/${s.issueUnassigned.id}/comments`)
      .send({ body: `ping @${s.hidden.name}` })
      .expect(201);
    const comments = await ctx.db.select().from(issueComments);
    expect(comments.length).toBeGreaterThan(0);
  });

  it("lets owners manage agent access and refuses everyone else", async () => {
    const s = await seed(ctx.db);
    const path = `/api/companies/${s.companyId}/members/${s.operatorMembership.id}/agent-access`;
    const current = await request(app(s.owner.actor)).get(path).expect(200);
    expect(current.body).toMatchObject({ restrictedByRole: true, agentIds: [s.granted.id] });

    const updated = await request(app(s.owner.actor))
      .put(path)
      .send({ agentIds: [s.granted.id, s.hidden.id] })
      .expect(200);
    expect(updated.body.agentIds.sort()).toEqual([s.granted.id, s.hidden.id].sort());
    invalidateAgentVisibility();
    await request(app(s.operator)).get(`/api/issues/${s.issueHidden.id}`).expect(200);

    await request(app(s.operator)).put(path).send({ agentIds: [] }).expect(403);
    await request(app(s.owner.actor)).put(path).send({ agentIds: [randomUUID()] }).expect(422);
  });

  it("searches only visible issues", async () => {
    const s = await seed(ctx.db);
    const res = await request(app(s.operator))
      .get(`/api/companies/${s.companyId}/search?q=Zebra&scope=issues`)
      .expect(200);
    const ids = (res.body.results as Array<{ id: string }>).map((row) => row.id);
    expect(ids).not.toContain(s.issueHidden.id);
    expect(ids).toContain(s.issueGranted.id);
  });
});

import { eq } from "drizzle-orm";
function eqId(id: string) {
  return eq(issues.id, id);
}
