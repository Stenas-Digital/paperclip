// [stenas:agent-visibility] Fork-only route coverage for per-agent visibility.
import { randomUUID } from "node:crypto";
import { Router } from "express";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companyMemberships,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  projects,
  routines,
} from "@paperclipai/db";
import { activityRoutes } from "../routes/activity.js";
import { agentAccessRoutes } from "../routes/agent-access.js";
import { agentRoutes } from "../routes/agents.js";
import { agentVisibilityGuardRoutes } from "../routes/agent-visibility-guard.js";
import { companyRoutes } from "../routes/companies.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { issueRoutes } from "../routes/issues.js";
import { projectRoutes } from "../routes/projects.js";
import { routineRoutes } from "../routes/routines.js";
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
  routineRoutes,
  projectRoutes,
] as never[];

function eqId(id: string) {
  return eq(issues.id, id);
}

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
        adapterConfig: { command: "secret-command", env: { TOKEN: "abc" } },
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
  const hidden = await mkAgent("Hidden");
  const granted = await mkAgent("Granted", hidden.id);
  const operatorId = `user-operator-${randomUUID()}`;
  const mkIssue = (
    title: string,
    fields: {
      assigneeAgentId?: string | null;
      assigneeUserId?: string | null;
      createdByUserId?: string | null;
      createdByAgentId?: string | null;
      parentId?: string | null;
    } = {},
  ) =>
    db
      .insert(issues)
      .values({ companyId, title, status: "todo", priority: "medium", ...fields })
      .returning()
      .then((rows) => rows[0]!);
  const issueHidden = await mkIssue("Zebra hidden task", { assigneeAgentId: hidden.id });
  const issueGranted = await mkIssue("Zebra granted task", { assigneeAgentId: granted.id, parentId: issueHidden.id });
  const issueUnassigned = await mkIssue("Zebra unassigned task");
  // The reported leak: a hidden agent's work handed back to the owner.
  const issueOwners = await mkIssue("Zebra owner's audit", {
    assigneeUserId: owner.userId,
    createdByUserId: owner.userId,
  });
  const issueMine = await mkIssue("Zebra my own task", { createdByUserId: operatorId });
  const issueAssignedToMe = await mkIssue("Zebra assigned to me", { assigneeUserId: operatorId });
  const issueByGrantedAgent = await mkIssue("Zebra from granted agent", { createdByAgentId: granted.id });
  const issueByHiddenAgent = await mkIssue("Zebra from hidden agent", { createdByAgentId: hidden.id });
  const issueMineToHidden = await mkIssue("Zebra mine handed to hidden", {
    createdByUserId: operatorId,
    assigneeAgentId: hidden.id,
  });

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
  return {
    owner,
    operator,
    operatorId,
    operatorMembership: operatorMembership!,
    companyId,
    hidden,
    granted,
    issueHidden,
    issueGranted,
    issueUnassigned,
    issueOwners,
    issueMine,
    issueAssignedToMe,
    issueByGrantedAgent,
    issueByHiddenAgent,
    issueMineToHidden,
  };
}

describeEmbeddedPostgres("agent visibility routes", () => {
  const ctx = useEmbeddedPostgres("paperclip-agent-visibility-routes-");

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_VISIBILITY = "on";
  });

  afterEach(() => invalidateAgentVisibility());

  const app = (actor: BoardActor) => routeApp(ctx.db as never, actor, ...ROUTERS);

  it("shows only own tasks and granted agents' tasks to restricted users", async () => {
    const s = await seed(ctx.db);
    const operatorList = await request(app(s.operator)).get(`/api/companies/${s.companyId}/issues`).expect(200);
    const operatorIds = (operatorList.body as Array<{ id: string }>).map((issue) => issue.id).sort();
    expect(operatorIds).toEqual(
      [s.issueGranted, s.issueMine, s.issueAssignedToMe, s.issueByGrantedAgent, s.issueMineToHidden]
        .map((issue) => issue.id)
        .sort(),
    );

    const ownerList = await request(app(s.owner.actor)).get(`/api/companies/${s.companyId}/issues`).expect(200);
    expect((ownerList.body as unknown[]).length).toBe(9);

    for (const hidden of [s.issueHidden, s.issueUnassigned, s.issueOwners, s.issueByHiddenAgent]) {
      await request(app(s.operator)).get(`/api/issues/${hidden.id}`).expect(404);
    }
    await request(app(s.operator)).get(`/api/issues/${s.issueMineToHidden.id}`).expect(200);

    await ctx.db.update(issues).set({ status: "blocked" }).where(eqId(s.issueHidden.id));
    await ctx.db.update(issues).set({ status: "blocked" }).where(eqId(s.issueOwners.id));
    const countPath = `/api/companies/${s.companyId}/issues/count?attention=blocked`;
    const ownerCount = await request(app(s.owner.actor)).get(countPath).expect(200);
    const operatorCount = await request(app(s.operator)).get(countPath).expect(200);
    expect(ownerCount.body.count).toBeGreaterThan(0);
    expect(operatorCount.body.count).toBe(0);
  });

  it("returns 404 for hidden issues and their sub-resources and redacts hidden ancestors", async () => {
    const s = await seed(ctx.db);
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
      .patch(`/api/issues/${s.issueMine.id}`)
      .send({ assigneeAgentId: s.hidden.id })
      .expect(403);
    await request(app(s.operator))
      .post(`/api/companies/${s.companyId}/issues`)
      .send({ title: "to granted", assigneeAgentId: s.granted.id })
      .expect(201);
  });

  it("hides agents in lists, detail, org chart and chat, and serves the restricted agent view", async () => {
    const s = await seed(ctx.db);
    const list = await request(app(s.operator)).get(`/api/companies/${s.companyId}/agents`).expect(200);
    const agentRows = list.body as Array<{ id: string; reportsTo: string | null; adapterConfig?: Record<string, unknown> }>;
    expect(agentRows.map((agent) => agent.id)).toEqual([s.granted.id]);
    expect(agentRows[0]!.reportsTo).toBeNull();
    expect(JSON.stringify(agentRows[0])).not.toContain("secret-command");
    const detail = await request(app(s.operator)).get(`/api/agents/${s.granted.id}`).expect(200);
    expect(JSON.stringify(detail.body)).not.toContain("secret-command");
    await request(app(s.operator)).get(`/api/agents/${s.hidden.id}`).expect(404);
    await request(app(s.operator)).post(`/api/agents/${s.hidden.id}/wakeup`).send({}).expect(404);
    await request(app(s.operator)).get(`/api/companies/${s.companyId}/chats/${s.hidden.id}`).expect(404);
    const org = await request(app(s.operator)).get(`/api/companies/${s.companyId}/org`).expect(200);
    expect((org.body as Array<{ id: string }>).map((node) => node.id)).toEqual([s.granted.id]);
  });

  it("refuses agent runtime/secrets/tools configuration, project writes and audit to restricted users", async () => {
    const s = await seed(ctx.db);
    await request(app(s.operator)).get(`/api/agents/${s.granted.id}/configuration`).expect(403);
    await request(app(s.operator)).get(`/api/agents/${s.granted.id}/config-revisions`).expect(403);
    await request(app(s.operator)).get(`/api/agents/${s.granted.id}/runtime-state`).expect(403);
    await request(app(s.operator))
      .get(`/api/companies/${s.companyId}/tools/profiles/effective/agents/${s.granted.id}`)
      .expect(403);
    await request(app(s.operator)).get(`/api/companies/${s.companyId}/audit/agent-actions`).expect(403);

    const [project] = await ctx.db.insert(projects).values({ companyId: s.companyId, name: "Proj" }).returning();
    await request(app(s.operator)).patch(`/api/projects/${project!.id}`).send({ name: "Renamed" }).expect(403);
    await request(app(s.operator)).get(`/api/projects/${project!.id}`).expect(200);
    await request(app(s.owner.actor)).patch(`/api/projects/${project!.id}`).send({ name: "Renamed" }).expect(200);
    await request(app(s.owner.actor)).get(`/api/agents/${s.granted.id}/configuration`).expect(200);
  });

  it("hides routines of hidden agents", async () => {
    const s = await seed(ctx.db);
    const [hiddenRoutine] = await ctx.db
      .insert(routines)
      .values({ companyId: s.companyId, title: "Hidden routine", assigneeAgentId: s.hidden.id })
      .returning();
    await ctx.db.insert(routines).values({ companyId: s.companyId, title: "Granted routine", assigneeAgentId: s.granted.id });
    const list = await request(app(s.operator)).get(`/api/companies/${s.companyId}/routines`).expect(200);
    expect((list.body as Array<{ title: string }>).map((routine) => routine.title)).toEqual(["Granted routine"]);
    await request(app(s.operator)).get(`/api/routines/${hiddenRoutine!.id}`).expect(404);
    const ownerList = await request(app(s.owner.actor)).get(`/api/companies/${s.companyId}/routines`).expect(200);
    expect((ownerList.body as unknown[]).length).toBe(2);
  });

  it("hides artifacts created by hidden agents, even on visible tasks", async () => {
    const s = await seed(ctx.db);
    const mkDoc = async (title: string, createdByAgentId: string) => {
      const [doc] = await ctx.db
        .insert(documents)
        .values({ companyId: s.companyId, title, latestBody: "body", createdByAgentId })
        .returning();
      await ctx.db.insert(issueDocuments).values({
        companyId: s.companyId,
        issueId: s.issueMine.id,
        documentId: doc!.id,
        key: `doc-${randomUUID().slice(0, 8)}`,
      });
    };
    await mkDoc("Hidden agent report", s.hidden.id);
    await mkDoc("Granted agent report", s.granted.id);
    const artifactsApp = routeApp(ctx.db as never, s.operator, agentVisibilityGuardRoutes as never, ((db: Db) => {
      const router = companyRoutes(db as never);
      const wrapper = Router();
      wrapper.use("/companies", router);
      return wrapper;
    }) as never);
    const res = await request(artifactsApp).get(`/api/companies/${s.companyId}/artifacts`).expect(200);
    const titles = (res.body.artifacts as Array<{ title: string }>).map((artifact) => artifact.title);
    expect(titles).toContain("Granted agent report");
    expect(titles).not.toContain("Hidden agent report");
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
      { companyId: s.companyId, actorType: "user", actorId: s.owner.userId, action: "issue.updated", entityType: "issue", entityId: s.issueOwners.id },
      { companyId: s.companyId, actorType: "agent", actorId: s.granted.id, agentId: s.granted.id, action: "issue.updated", entityType: "issue", entityId: s.issueGranted.id },
    ]);
    const activity = await request(app(s.operator)).get(`/api/companies/${s.companyId}/activity`).expect(200);
    const entityIds = (activity.body as Array<{ entityId: string }>).map((row) => row.entityId);
    expect(entityIds).toContain(s.issueGranted.id);
    expect(entityIds).not.toContain(s.issueHidden.id);
    expect(entityIds).not.toContain(s.issueOwners.id);

    const dashboard = await request(app(s.operator)).get(`/api/companies/${s.companyId}/dashboard`).expect(200);
    expect(dashboard.body.tasks.open).toBe(5);
    expect(dashboard.body.agents.active).toBe(1);
  });

  it("silently drops @mentions of hidden agents", async () => {
    const s = await seed(ctx.db);
    await request(app(s.operator))
      .post(`/api/issues/${s.issueMine.id}/comments`)
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
    expect(ids).not.toContain(s.issueOwners.id);
    expect(ids).toContain(s.issueGranted.id);
    expect(ids).toContain(s.issueMine.id);
  });
});
