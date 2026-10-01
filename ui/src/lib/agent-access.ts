// [stenas:agent-visibility] Fork-only helpers for per-member agent access.
import type { CompanyMember } from "@/api/access";

/** Roles limited to explicitly granted agents (owners and admins see all). */
export const AGENT_ACCESS_RESTRICTED_ROLES: ReadonlyArray<CompanyMember["membershipRole"]> = ["operator", "viewer", null];

export function memberAgentAccessIds(member: Pick<CompanyMember, "grants">): string[] {
  const grant = member.grants.find((entry) => entry.permissionKey === "agents:access");
  const raw = grant?.scope?.agentIds;
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}
