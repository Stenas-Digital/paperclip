# Agent identity lock (Stenas fork)

Status: implemented on `stenas/main`, based on upstream `v2026.916.1`.
This is a **fork-only** customisation for `Stenas-Digital/paperclip`.

## Why

On the Stenas box each agent runs as its **own Unix user**. Paperclip reaches that user over an SSH
execution environment to `127.0.0.1`. The user's `$HOME` holds that identity's connectors (Odoo API
key, Google token, browser), so the kernel stops one agent from reading another's credentials.

That isolation holds only if an agent cannot choose which Unix user runs it, or inject code into
another agent's run. Upstream allows both through the API:

- An agent may PATCH **itself**: `defaultEnvironmentId`, `adapterType`, `adapterConfig.command`/`env`,
  and `role`. It can also roll back its config to a revision with a different environment.
- An agent with `canCreateAgents` (on by default), or any CEO agent, may hire an agent with any
  environment, command or env. A CEO agent may also apply a company import with arbitrary agent configs.
- Any agent may create or update a task for another agent with
  `assigneeAdapterOverrides.adapterConfig`. It is merged into that agent's run (`heartbeat.ts`), so
  e.g. `env.NODE_OPTIONS=--require /tmp/x.js` executes as the assignee's Unix user.
- Any agent may set a **project's** `env`, which is merged into every run in that project.

The threat in scope is a misused or prompt-injected agent. Human operators are out of scope; the
agent-visibility fork and owner-only `agents:configure` cover them.

## Rule

For **agent-authenticated** callers only (board users are unaffected):

| Route | Refused |
|---|---|
| `PATCH /agents/:id` | Any of `adapterType`, `defaultEnvironmentId`, `role`, `adapterConfig` |
| `POST /agents/:id/config-revisions/:rid/rollback` | Always |
| `POST /companies/:cid/agent-hires`, `POST /companies/:cid/agents` | A non-null `defaultEnvironmentId`, or `adapterConfig` keys `command`, `agentCommand`, `acpAgentCommand`, `args`, `extraArgs`, `env`, `filesystemSandboxCommand`, `managedAiConnection` |
| `POST /companies/:cid/imports/apply` | Always (preview stays allowed) |
| Issue create, update and child-create routes | A non-empty `assigneeAdapterOverrides.adapterConfig` |
| `POST /companies/:cid/projects`, `PATCH /projects/:id` | Any `env` |

Agent hires still work. The hiring agent's Claude credential is still inherited server-side, and
the new agent has no environment, so it falls to the instance default. On the Stenas box that
default is a credential-less jail user. A human then assigns the real environment.

## Design

No migration. Every hunk in an upstream file is marked `[stenas:identity-lock]`, so
`rg "\[stenas:identity-lock\]"` lists everything to re-check on a rebase.

| Piece | Where |
|---|---|
| `assertAgentActorCannotChangeExecutionIdentity`, `assertAgentActorCannotChooseHireExecutionIdentity`; calls in PATCH, rollback, hire, create | `server/src/routes/agents.ts` |
| `assertNoAgentAssigneeAdapterConfigOverride`, `assertNoAgentProjectEnvMutation` | `server/src/routes/workspace-command-authz.ts` |
| Override check at the four issue mutation sites | `server/src/routes/issues.ts` |
| Project env check on create and PATCH | `server/src/routes/projects.ts` |
| Import apply refused for agents | `server/src/routes/companies.ts` |

In PATCH the identity check runs after the narrower upstream adapterConfig checks
(instructions bundle, workspace commands), so their more specific errors still win.

## Tests

- New: `agent-permissions-routes.test.ts` ("agent identity lock") and
  `workspace-command-authz.test.ts` ("agent identity lock on task overrides and project env").
- Changed to match the rule (each change is marked):
  - CEO-agent import apply in `companies-route-cross-company-authz.test.ts` and
    `company-portability-routes.test.ts`;
  - agent hires that supply `env` in `agent-hire-ai-connections.test.ts` and
    `agent-hire-auth-inheritance-routes.test.ts`.

## Not covered

- Routine `env`: agents can only manage routines assigned to themselves, so it reaches only their own runs.
- Environment `env_vars`: only instance admins can edit environments.
- An agent can still delegate a task to another agent in plain language. That is a prompt-level
  channel, not a credential leak.
