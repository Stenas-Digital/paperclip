/**
 * [stenas:agent-visibility] Owner-managed per-member agent access.
 *
 * Fork-only. GET/PUT /companies/:companyId/members/:memberId/agent-access
 * reads and replaces the `agents:access` grant of a user member. Only actors
 * holding `users:manage_permissions` who are themselves unrestricted
 * (owner/admin/instance admin) may change it.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, logActivity } from "../services/index.js";
import {
  agentVisibilityService,
  resolveBoardAgentVisibility,
} from "../services/agent-visibility.js";
import { assertCompanyAccess } from "./authz.js";

const RESTRICTED_ROLES = new Set(["operator", "viewer", "member"]);

export const updateMemberAgentAccessSchema = z.object({
  agentIds: z.array(z.string().uuid()).max(500),
});

export function agentAccessRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const visibility = agentVisibilityService(db);

  async function assertCanManageAgentAccess(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") throw unauthorized();
    if (req.actor.source !== "local_implicit") {
      if (!req.actor.userId) throw unauthorized();
      const allowed = await access.canUser(companyId, req.actor.userId, "users:manage_permissions");
      if (!allowed) throw forbidden("Permission denied");
    }
    const own = await resolveBoardAgentVisibility(db, req.actor, companyId);
    if (own.restricted) throw forbidden("Only unrestricted members can manage agent access");
  }

  async function loadUserMember(companyId: string, memberId: string) {
    const member = await access.getMemberById(companyId, memberId);
    if (!member) throw notFound("Member not found");
    if (member.principalType !== "user") throw unprocessable("Agent access applies to user members only");
    return member;
  }

  function describe(member: { id: string; principalId: string; membershipRole: string | null }, agentIds: string[]) {
    return {
      memberId: member.id,
      principalId: member.principalId,
      membershipRole: member.membershipRole,
      restrictedByRole: !member.membershipRole || RESTRICTED_ROLES.has(member.membershipRole),
      agentIds,
    };
  }

  router.get("/companies/:companyId/members/:memberId/agent-access", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManageAgentAccess(req, companyId);
    const member = await loadUserMember(companyId, req.params.memberId as string);
    res.json(describe(member, await visibility.getUserAgentAccess(companyId, member.principalId)));
  });

  router.put(
    "/companies/:companyId/members/:memberId/agent-access",
    validate(updateMemberAgentAccessSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanManageAgentAccess(req, companyId);
      const member = await loadUserMember(companyId, req.params.memberId as string);
      const requested = [...new Set((req.body.agentIds as string[]) ?? [])];
      const unknown = await visibility.assertAgentsInCompany(companyId, requested);
      if (unknown.length > 0) {
        throw unprocessable("Some agents do not belong to this company", { agentIds: unknown });
      }
      const { previous, next } = await visibility.setUserAgentAccess(
        companyId,
        member.principalId,
        requested,
        req.actor.userId ?? null,
      );
      const previousSet = new Set(previous);
      const nextSet = new Set(next);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "company_member.agent_access_updated",
        entityType: "company_membership",
        entityId: member.id,
        details: {
          principalId: member.principalId,
          agentIds: next,
          addedAgentIds: next.filter((id) => !previousSet.has(id)),
          removedAgentIds: previous.filter((id) => !nextSet.has(id)),
        },
      });
      res.json(describe(member, next));
    },
  );

  return router;
}
