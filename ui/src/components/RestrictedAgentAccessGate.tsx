// [stenas:agent-visibility] Fork-only: redirects users with restricted agent
// access away from pages they cannot use (the server refuses them anyway).
import { useContext, type ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { Navigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useRestrictedAgentAccess } from "@/hooks/useRestrictedAgentAccess";

function Gate({ children, to }: { children: ReactNode; to: string }) {
  const { selectedCompanyId } = useCompany();
  // Only redirect once the user is known to be restricted; the server refuses
  // the underlying data either way, so there is no need to block on loading.
  const { restricted } = useRestrictedAgentAccess(selectedCompanyId);
  if (restricted) return <Navigate to={to} replace />;
  return <>{children}</>;
}

export function RestrictedAgentAccessGate({ children, to = "/dashboard" }: { children: ReactNode; to?: string }) {
  // Route trees rendered without a QueryClient (tests, previews) pass through.
  if (!useContext(QueryClientContext)) return <>{children}</>;
  return <Gate to={to}>{children}</Gate>;
}
