// [stenas:agent-visibility] Fork-only: is the signed-in user restricted to
// granted agents in this company? Owners, admins, instance admins and the
// local implicit board are not. The server enforces the same rule; this only
// hides navigation the user cannot use.
import { useQuery } from "@tanstack/react-query";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";

const UNRESTRICTED_ROLES = new Set(["owner", "admin"]);

export function isRestrictedAgentAccess(access: CurrentBoardAccess | undefined, companyId: string | null | undefined) {
  if (!access || !companyId) return false;
  if (access.source === "local_implicit" || access.isInstanceAdmin) return false;
  const membership = access.memberships?.find(
    (entry) => entry.companyId === companyId && entry.status === "active",
  );
  return !UNRESTRICTED_ROLES.has(membership?.membershipRole ?? "");
}

export function useRestrictedAgentAccess(companyId: string | null | undefined) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  return { restricted: isRestrictedAgentAccess(data, companyId), loading: isLoading };
}
