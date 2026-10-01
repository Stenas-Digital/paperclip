// [stenas:agent-visibility] Fork-only tests for live event filtering.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, issues } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import {
  createAgentVisibilityLiveEventListener,
  liveEventVisibleToRestricted,
} from "../realtime/live-events-visibility-filter.js";
import { agentVisibilityService, invalidateAgentVisibility } from "../services/agent-visibility.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

type Db = Parameters<typeof agentVisibilityService>[0];

let nextId = 1;
function event(companyId: string, type: LiveEvent["type"], payload: Record<string, unknown>): LiveEvent {
  return { id: nextId++, companyId, type, createdAt: new Date().toISOString(), payload };
}

async function seed(db: Db) {
  const company = await db
    .insert(companies)
    .values({ name: `Live ${randomUUID()}`, issuePrefix: `L${randomUUID().slice(0, 6).toUpperCase()}` })
    .returning()
    .then((rows) => rows[0]!);
  const mkAgent = () =>
    db
      .insert(agents)
      .values({ companyId: company.id, name: `Agent ${randomUUID()}`, role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} })
      .returning()
      .then((rows) => rows[0]!);
  const granted = await mkAgent();
  const hidden = await mkAgent();
  const issue = await db
    .insert(issues)
    .values({ companyId: company.id, title: "Task", status: "todo", priority: "medium", assigneeAgentId: granted.id })
    .returning()
    .then((rows) => rows[0]!);
  const operatorId = `user-${randomUUID()}`;
  const ownerId = `user-${randomUUID()}`;
  await db.insert(companyMemberships).values([
    { companyId: company.id, principalType: "user", principalId: operatorId, status: "active", membershipRole: "operator" },
    { companyId: company.id, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" },
  ]);
  await agentVisibilityService(db).setUserAgentAccess(company.id, operatorId, [granted.id], null);
  return { company, granted, hidden, issue, operatorId, ownerId };
}

describeEmbeddedPostgres("live event visibility filter", () => {
  const ctx = useEmbeddedPostgres("paperclip-live-events-visibility-");

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_VISIBILITY = "on";
  });

  afterEach(() => invalidateAgentVisibility());

  it("drops events about hidden agents, hidden issues and their runs", async () => {
    const s = await seed(ctx.db);
    const visibility = { restricted: true as const, companyId: s.company.id, userId: s.operatorId, allowedAgentIds: new Set([s.granted.id]) };
    const visible = (payload: Record<string, unknown>, type: LiveEvent["type"] = "activity.logged") =>
      liveEventVisibleToRestricted(ctx.db, visibility, event(s.company.id, type, payload));

    expect(await visible({ agentId: s.hidden.id }, "agent.status")).toBe(false);
    expect(await visible({ agentId: s.granted.id }, "agent.status")).toBe(true);
    expect(await visible({ entityType: "agent", entityId: s.hidden.id })).toBe(false);
    expect(await visible({ entityType: "issue", entityId: s.issue.id })).toBe(true);
    expect(await visible({ action: "company.updated" })).toBe(true);

    // Reassignment to a hidden agent is picked up on the very next issue event.
    await ctx.db.update(issues).set({ assigneeAgentId: s.hidden.id }).where(eq(issues.id, s.issue.id));
    expect(await visible({ entityType: "issue", entityId: s.issue.id })).toBe(false);
    expect(await visible({ details: { issueId: s.issue.id } })).toBe(false);
  });

  it("passes owner sockets through and preserves order for restricted ones", async () => {
    const s = await seed(ctx.db);
    const ownerReceived: number[] = [];
    const ownerListener = createAgentVisibilityLiveEventListener(
      ctx.db,
      { companyId: s.company.id, actorType: "board", actorId: s.ownerId },
      (e) => ownerReceived.push(e.id),
    );
    const received: number[] = [];
    const listener = createAgentVisibilityLiveEventListener(
      ctx.db,
      { companyId: s.company.id, actorType: "board", actorId: s.operatorId },
      (e) => received.push(e.id),
    );
    const events = [
      event(s.company.id, "agent.status", { agentId: s.granted.id }),
      event(s.company.id, "agent.status", { agentId: s.hidden.id }),
      event(s.company.id, "heartbeat.run.log", { agentId: s.granted.id, issueId: s.issue.id }),
      event(s.company.id, "heartbeat.run.log", { agentId: s.hidden.id }),
    ];
    for (const e of events) {
      listener(e);
      ownerListener(e);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toEqual([events[0]!.id, events[2]!.id]);
    expect(ownerReceived).toEqual(events.map((e) => e.id));
  });
});
