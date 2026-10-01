# Per-agent visibility for restricted users (Stenas fork)

Status: Phase 1 implemented on `stenas/agent-visibility`, based on upstream `v2026.916.1`.
This is a **fork-only** customisation for `Stenas-Digital/paperclip`. It deliberately departs from
upstream's "board access is full control" model, so that one company's employees can share a
Paperclip instance without seeing each other's agents.

## Rule

- **Unrestricted:** company role `owner` or `admin`, instance admins, and the local implicit board.
- **Restricted:** `operator`, `viewer`, legacy `member`, and unset roles. These users see only agents
  granted to them through an `agents:access` permission grant (`principal_permission_grants`,
  scope `{ agentIds: string[] }`). Without a grant they see no agents (default deny).
- **Tasks:** a task is visible iff it is unassigned, assigned to a human, or assigned to a visible
  agent. A task reassigned to a hidden agent disappears, including for its creator.
- **Agents acting for a user:** an agent acting on behalf of a responsible user inherits that user's
  visibility, plus itself. This happens through upstream's responsible-user intersection, so it is
  enforced unless `PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE=shadow`.
- **Who manages access:** owners (holders of `users:manage_permissions` who are themselves
  unrestricted), in Settings → Members → Edit.
- **Kill switch:** `PAPERCLIP_AGENT_VISIBILITY=off`.

## Design

There is no database migration. Every fork hunk in an upstream file is marked
`[stenas:agent-visibility]`, so `rg "\[stenas:agent-visibility\]"` lists everything to re-check on
a rebase.

| Piece | Where |
|---|---|
| Resolver, SQL helpers, run filter, org pruning, `decideBase` hook, grant service | `server/src/services/agent-visibility.ts` (new) |
| Hook in the authorization engine; `delegatedByAgentId` on the intersection actor | `server/src/services/authorization.ts` |
| `agents:access` kept out of the replace-all grant paths | `server/src/services/access.ts` |
| Central 404 guard for `/issues/:id`, `/agents/:id`, `/heartbeat-runs/:id`, attachments, work products, approvals, chats, feedback traces | `server/src/routes/agent-visibility-guard.ts` (new), mounted first in `app.ts` |
| Owner-only grant API: `GET` and `PUT /companies/:cid/members/:mid/agent-access` | `server/src/routes/agent-access.ts` (new) |
| Redaction of embedded relation summaries | `server/src/routes/agent-visibility-redaction.ts` (new) |
| Live-events WebSocket filter | `server/src/realtime/live-events-visibility-filter.ts` (new) |
| Members UI: "Agent access" picker and "N agents" badge | `ui/src/pages/CompanyAccess.tsx`, `ui/src/lib/agent-access.ts` (new), `ui/src/api/access.ts` |

**Fail-closed default.** For direct restricted users, `company_scope:read` is denied. Every
company-wide endpoint therefore refuses them unless it was explicitly re-opened with filtering. Phase
1 re-opened: the task list and count, search, the company activity feed, run lists and live runs,
approvals, the dashboard, sidebar badges, the attention inbox and company artifacts.

**Known traps.**
- `scopeAllows` treats an empty `agentIds` list as unconstrained, so `agents:access` must never be
  evaluated through `decidePrincipalGrant`.
- `setPrincipalPermission` rewrites the member's role to `member`, so it must never be used for this
  grant.

## Phase 2 (closed to restricted users until done)

- Costs by agent, company timeline, status cards, execution workspaces, project and goal counts, cases,
  user profiles, exports, summary slots, built-in agents, plugin host services, email (AgentMail),
  chat connectors, file-resource content, workspace-operation logs.
- Agent-key WebSocket sockets.
- Redacting comments written by hidden agents on visible tasks.
- Linking hidden tasks when creating an approval.
- A CI check listing routes gated only by `assertCompanyAccess`.

## Tests

- `server/src/__tests__/agent-visibility-authorization.test.ts`
- `server/src/__tests__/agent-visibility-routes.test.ts`
- `server/src/__tests__/live-events-visibility-filter.test.ts`

The shared test setup (`setup-supertest.ts`) sets the kill switch, so upstream suites keep verifying
upstream semantics. The fork suites switch the feature back on.
