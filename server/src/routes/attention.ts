import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { AttentionSortMode } from "@paperclipai/shared";
import { attentionService } from "../services/attention.js";
import { badRequest } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
// [stenas:agent-visibility]
import { resolveEffectiveAgentVisibility } from "../services/agent-visibility.js";
import { canReadDecisionSource } from "../services/decision-queues.js";

function optionalQueryString(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} must be a non-empty string`);
  return value.trim();
}

export function attentionRoutes(db: Db) {
  const router = Router();
  const svc = attentionService(db);

  router.get("/companies/:companyId/attention", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    const includeDismissed = req.query.includeDismissed === "true";
    const archived = req.query.archived === "true";
    const all = req.query.all === "true";
    const activitySince = optionalQueryString(req.query.activitySince, "activitySince");
    const activityUntil = optionalQueryString(req.query.activityUntil, "activityUntil");
    const queue = optionalQueryString(req.query.queue, "queue");
    const cursor = optionalQueryString(req.query.cursor, "cursor");
    const sortValue = optionalQueryString(req.query.sort, "sort");
    if (sortValue !== undefined && sortValue !== "activity" && sortValue !== "decide") {
      throw badRequest("sort must be 'activity' or 'decide'");
    }
    const limitValue = optionalQueryString(req.query.limit, "limit");
    const limit = limitValue === undefined ? undefined : Number(limitValue);
    if (limit !== undefined && !Number.isInteger(limit)) throw badRequest("limit must be an integer");
    const feed = await svc.list(companyId, {
      userId: req.actor.userId,
      includeDismissed,
      archived,
      all,
      allowUnscopedAll: all,
      activitySince,
      activityUntil,
      queue,
      cursor,
      sort: sortValue as AttentionSortMode | undefined,
      limit,
    });
    // [stenas:agent-visibility] drop items whose source is hidden from a
    // restricted user and adjust the counters by what was removed (page-local).
    const attentionVisibility = await resolveEffectiveAgentVisibility(db, req.actor, companyId);
    if (attentionVisibility.restricted) {
      const readable = await Promise.all(
        feed.items.map((item) => canReadDecisionSource(db, req.actor, companyId, item.sourceKind, item.subject.id)),
      );
      const removed = feed.items.filter((_, index) => !readable[index]);
      const countsBySourceKind = { ...feed.countsBySourceKind };
      for (const item of removed) {
        countsBySourceKind[item.sourceKind] = Math.max(0, (countsBySourceKind[item.sourceKind] ?? 0) - 1);
      }
      res.json({
        ...feed,
        items: feed.items.filter((_, index) => readable[index]),
        totalCount: Math.max(0, feed.totalCount - removed.length),
        deskBadgeCount: Math.max(0, feed.deskBadgeCount - removed.length),
        countsBySourceKind,
      });
      return;
    }
    res.json(feed);
  });

  return router;
}
