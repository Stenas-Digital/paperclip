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
  heartbeatRuns,
  issueApprovals,
  issueAttachments,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import { isUuidLike, normalizeIssueIdentifier } from "@paperclipai/shared";
import { agentService } from "../services/agents.js";
import {
  isAgentVisible,
  isIssueVisible,
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
    return db
      .select({ id: issues.id, companyId: issues.companyId, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
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
      .select({ companyId: issueAttachments.companyId, issueId: issueAttachments.issueId })
      .from(issueAttachments)
      .where(eq(issueAttachments.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    return (await issueHiddenFor(req, row.issueId, row.companyId)) ? "Attachment not found" : null;
  });

  const workProductGuard = guard(async (req) => {
    const id = param(req, "workProductId");
    if (!id || !isUuidLike(id)) return null;
    const row = await db
      .select({ companyId: issueWorkProducts.companyId, issueId: issueWorkProducts.issueId })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
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
    const linked = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issueApprovals)
      .innerJoin(issues, eq(issues.id, issueApprovals.issueId))
      .where(and(eq(issueApprovals.approvalId, id), eq(issueApprovals.companyId, approval.companyId)));
    return linked.every((issue) => isIssueVisible(visibility, issue)) ? null : "Approval not found";
  });

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

  return router;
}
