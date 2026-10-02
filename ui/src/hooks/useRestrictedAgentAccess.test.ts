// [stenas:agent-visibility]
import { describe, expect, it } from "vitest";
import type { CurrentBoardAccess } from "@/api/access";
import { isRestrictedAgentAccess } from "./useRestrictedAgentAccess";

function access(role: string | null, extra: Partial<CurrentBoardAccess> = {}): CurrentBoardAccess {
  return {
    user: null,
    userId: "u1",
    isInstanceAdmin: false,
    companyIds: ["c1"],
    memberships: [{ companyId: "c1", membershipRole: role as never, status: "active" }],
    source: "session",
    keyId: null,
    ...extra,
  };
}

describe("isRestrictedAgentAccess", () => {
  it("restricts operators, viewers, legacy members and unset roles", () => {
    for (const role of ["operator", "viewer", "member", null]) {
      expect(isRestrictedAgentAccess(access(role), "c1"), String(role)).toBe(true);
    }
  });

  it("does not restrict owners, admins, instance admins or the local board", () => {
    expect(isRestrictedAgentAccess(access("owner"), "c1")).toBe(false);
    expect(isRestrictedAgentAccess(access("admin"), "c1")).toBe(false);
    expect(isRestrictedAgentAccess(access("operator", { isInstanceAdmin: true }), "c1")).toBe(false);
    expect(isRestrictedAgentAccess(access("operator", { source: "local_implicit" }), "c1")).toBe(false);
  });

  it("is not restricted while access is unknown", () => {
    expect(isRestrictedAgentAccess(undefined, "c1")).toBe(false);
    expect(isRestrictedAgentAccess(access("operator"), null)).toBe(false);
  });
});
