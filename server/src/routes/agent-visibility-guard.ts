/**
 * [stenas:agent-visibility] Central 404 guard for entity-by-id routes.
 *
 * Fork-only. Mounted once in app.ts before every API router so that all
 * current and future `/issues/:id/*`, `/agents/:id/*`, `/heartbeat-runs/:id/*`
 * (and a few other entity) routes refuse hidden resources for restricted
 * actors — reads and writes alike. Responds 404 rather than 403 so a hidden
 * id cannot be probed for existence. Unrestricted actors pay one memoized
 * check and pass straight through; unknown ids fall through to the route.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  assets,
  heartbeatRuns,
  issueApprovals,
  issueAttachments,
  issues,
  issueWorkProducts,
  projects,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import { isUuidLike, normalizeIssueIdentifier } from "@paperclipai/shared";
import { agentService } from "../services/agents.js";
import {
  isAgentVisible,
  isIssueVisible,
  loadIssueVisibilityFields,
  resolveEffectiveAgentVisibility,
  type AgentVisibility,
} from "../services/agent-visibility.js";

type Guard = (req: Request, res: Response, next: NextFunction) => Promise<void>;

function param(req: Request, name: string): string | null {
  const value = req.params[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function agentVisibilityGuardRoutes(db: Db) {
  const router = Router();
  const agentsSvc = agentService(db);

  async function visibilityFor(req: Request, companyId: string): Promise<AgentVisibility> {
    return resolveEffectiveAgentVisibility(db, req.actor, companyId);
  }

  async function loadIssueByRef(rawRef: string) {
    const select = {
      id: issues.id,
      companyId: issues.companyId,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      createdByUserId: issues.createdByUserId,
      createdByAgentId: issues.createdByAgentId,
    };
    if (isUuidLike(rawRef)) {
      return db.select(select).from(issues).where(eq(issues.id, rawRef)).then((rows) => rows[0] ?? null);
    }
    const identifier = normalizeIssueIdentifier(rawRef);
    if (!identifier) return null;
    return db
      .select(select)
      .from(issues)
      .where(eq(issues.identifier, identifier.toUpperCase()))
      .then((rows) => rows[0] ?? null);
  }

  async function loadIssueById(issueId: string) {
    return (await loadIssueVisibilityFields(db, [issueId])).get(issueId) ?? null;
  }

  async function issueHiddenFor(req: Request, issueId: string | null | undefined, companyId: string) {
    if (!issueId) return false;
    const issue = await loadIssueById(issueId);
    if (!issue || issue.companyId !== companyId) return false;
    return !isIssueVisible(await visibilityFor(req, companyId), issue);
  }

  async function resolveAgentRef(req: Request, rawRef: string, companyIdHint: string | null) {
    if (isUuidLike(rawRef)) {
      return db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, rawRef))
        .then((rows) => rows[0] ?? null);
    }
    const companyId =
      companyIdHint ??
      (typeof req.query.companyId === "string" && req.query.companyId.trim() ? req.query.companyId.trim() : null) ??
      (req.actor.type === "agent" ? req.actor.companyId ?? null : null);
    if (!companyId) return null;
    const resolved = await agentsSvc.resolveByReference(companyId, rawRef);
    return resolved.agent ? { id: resolved.agent.id, companyId: resolved.agent.companyId } : null;
  }

  function guard(fn: (req: Request) => Promise<string | null>): Guard {
    return async (req, res, next) => {
      try {
        if (req.actor.type === "none") return next();
        const notFoundMessage = await fn(req);
        if (notFoundMessage) {
          res.status(404).json({ error: notFoundMessage });
          return;
        }
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  const issueGuard = guard(async (req) => {
    const ref = param(req, "issueRef");
    if (!ref) return null;
    const issue = await loadIssueByRef(ref);
    if (!issue) return null;
    const visibility = await visibilityFor(req, issue.companyId);
    return isIssueVisible(visibility, issue) ? null : "Issue not found";
  });

  const agentGuard = guard(async (req) => {
    const ref = param(req, "agentRef");
    if (!ref || ref === "me") return null;
    const agent = await resolveAgentRef(req, ref, param(req, "companyId"));
    if (!agent) return null;
    const visibility = await visibilityFor(req, agent.companyId);
    return isAgentVisible(visibility, agent.id) ? null : "Agent not found";
  });

  const runGuard = guard(async (req) => {
    const runId = param(req, "runId");
    if (!runId || !isUuidLike(runId)) return null;
    const run = await db
      .select({
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) return null;
    const visibility = await visibilityFor(req, run.companyId);
    if (!isAgentVisible(visibility, run.agentId)) return "Heartbeat run not found";
    const snapshot = run.contextSnapshot as Record<string, unknown> | null;
    const issueId = typeof snapshot?.issueId === "string" ? snapshot.issueId : null;
    if (await issueHiddenFor(req, issueId, run.companyId)) return "Heartbeat run not found";
    return null;
  });

  const attachmentGuard = guard(async (req) => {
    const id = param(req, "attachmentId");
    if (!id || !isUuidLike(id)) return null;
    const row = await db
      .select({
        companyId: issueAttachments.companyId,
        issueId: issueAttachments.issueId,
        creatorAgentId: assets.createdByAgentId,
      })
      .from(issueAttachments)
      .leftJoin(assets, eq(assets.id, issueAttachments.assetId))
      .where(eq(issueAttachments.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    if (row.creatorAgentId && !isAgentVisible(await visibilityFor(req, row.companyId), row.creatorAgentId)) {
      return "Attachment not found";
    }
    return (await issueHiddenFor(req, row.issueId, row.companyId)) ? "Attachment not found" : null;
  });

  const workProductGuard = guard(async (req) => {
    const id = param(req, "workProductId");
    if (!id || !isUuidLike(id)) return null;
    const row = await db
      .select({
        companyId: issueWorkProducts.companyId,
        issueId: issueWorkProducts.issueId,
        creatorAgentId: heartbeatRuns.agentId,
      })
      .from(issueWorkProducts)
      .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, issueWorkProducts.createdByRunId))
      .where(eq(issueWorkProducts.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    if (row.creatorAgentId && !isAgentVisible(await visibilityFor(req, row.companyId), row.creatorAgentId)) {
      return "Work product not found";
    }
    return (await issueHiddenFor(req, row.issueId, row.companyId)) ? "Work product not found" : null;
  });

  const approvalGuard = guard(async (req) => {
    const id = param(req, "approvalId");
    if (!id || !isUuidLike(id)) return null;
    const approval = await db
      .select({ companyId: approvals.companyId, requestedByAgentId: approvals.requestedByAgentId })
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!approval) return null;
    const visibility = await visibilityFor(req, approval.companyId);
    if (!visibility.restricted) return null;
    if (approval.requestedByAgentId && !isAgentVisible(visibility, approval.requestedByAgentId)) {
      return "Approval not found";
    }
    const linkedIds = await db
      .select({ issueId: issueApprovals.issueId })
      .from(issueApprovals)
      .where(and(eq(issueApprovals.approvalId, id), eq(issueApprovals.companyId, approval.companyId)));
    const linked = await loadIssueVisibilityFields(db, linkedIds.map((row) => row.issueId));
    return [...linked.values()].every((issue) => isIssueVisible(visibility, issue)) ? null : "Approval not found";
  });

  async function routineHidden(req: Request, routineId: string | null) {
    if (!routineId || !isUuidLike(routineId)) return false;
    const routine = await db
      .select({ companyId: routines.companyId, assigneeAgentId: routines.assigneeAgentId })
      .from(routines)
      .where(eq(routines.id, routineId))
      .then((rows) => rows[0] ?? null);
    if (!routine?.assigneeAgentId) return false;
    return !isAgentVisible(await visibilityFor(req, routine.companyId), routine.assigneeAgentId);
  }

  const routineGuard = guard(async (req) =>
    (await routineHidden(req, param(req, "routineId"))) ? "Routine not found" : null,
  );

  const routineTriggerGuard = guard(async (req) => {
    const id = param(req, "triggerId");
    if (!id || !isUuidLike(id)) return null;
    const trigger = await db
      .select({ routineId: routineTriggers.routineId })
      .from(routineTriggers)
      .where(eq(routineTriggers.id, id))
      .then((rows) => rows[0] ?? null);
    return (await routineHidden(req, trigger?.routineId ?? null)) ? "Routine trigger not found" : null;
  });

  /**
   * Surfaces restricted board users have no access to at all (agent runtime /
   * secrets / tools configuration, project configuration writes, audit). Only
   * direct board actors; agents keep their own configuration flows.
   */
  function restrictedBoardDeny(
    message: string,
    opts: { companyIdFrom?: "param" | "agent" | "project"; writesOnly?: boolean } = {},
  ): Guard {
    return async (req, res, next) => {
      try {
        if (req.actor.type !== "board") return next();
        if (opts.writesOnly && (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS")) return next();
        let companyId: string | null = null;
        if (opts.companyIdFrom === "agent") {
          const ref = param(req, "agentRef");
          companyId = ref ? (await resolveAgentRef(req, ref, null))?.companyId ?? null : null;
        } else if (opts.companyIdFrom === "project") {
          const projectId = param(req, "projectId");
          companyId = projectId && isUuidLike(projectId)
            ? await db.select({ companyId: projects.companyId }).from(projects).where(eq(projects.id, projectId)).then((rows) => rows[0]?.companyId ?? null)
            : null;
        } else {
          companyId = param(req, "companyId");
        }
        if (!companyId) return next();
        if ((await visibilityFor(req, companyId)).restricted) {
          res.status(403).json({ error: message });
          return;
        }
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  // Feedback traces are operator debugging data; restricted users never see them.
  const feedbackTraceGuard: Guard = async (req, res, next) => {
    try {
      if (req.actor.type !== "board") return next();
      const visibility = req.actor.memberships?.length
        ? await Promise.all(
            req.actor.memberships.map((membership) => visibilityFor(req, membership.companyId)),
          )
        : [];
      if (visibility.length > 0 && visibility.every((entry) => entry.restricted)) {
        res.status(404).json({ error: "Feedback trace not found" });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };

  router.use("/issues/:issueRef", issueGuard);
  router.use("/agents/:agentRef", agentGuard);
  router.use("/companies/:companyId/chats/:agentRef", agentGuard);
  router.use("/heartbeat-runs/:runId", runGuard);
  router.use("/attachments/:attachmentId", attachmentGuard);
  router.use("/work-products/:workProductId", workProductGuard);
  router.use("/approvals/:approvalId", approvalGuard);
  router.use("/feedback-traces/:traceId", feedbackTraceGuard);
  router.use("/routines/:routineId", routineGuard);
  const agentConfigDenied = restrictedBoardDeny("Agent configuration is not available with restricted agent access.", { companyIdFrom: "agent" });
  router.use("/agents/:agentRef/configuration", agentConfigDenied);
  router.use("/agents/:agentRef/config-revisions", agentConfigDenied);
  router.use("/agents/:agentRef/runtime-state", agentConfigDenied);
  router.use(
    "/companies/:companyId/tools/profiles/effective/agents/:agentRef",
    restrictedBoardDeny("Agent tools are not available with restricted agent access."),
  );
  router.use(
    "/projects/:projectId",
    restrictedBoardDeny("Project configuration is not available with restricted agent access.", {
      companyIdFrom: "project",
      writesOnly: true,
    }),
  );
  router.use("/companies/:companyId/audit", restrictedBoardDeny("Audit is not available with restricted agent access."));
  router.use("/routine-triggers/:triggerId", routineTriggerGuard);

  return router;
}
