import type { Request } from "express";
import { forbidden } from "../errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function prefixPath(prefix: string, key: string) {
  return prefix.length > 0 ? `${prefix}.${key}` : key;
}

function collectWorkspaceStrategyCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "runtimeProvisionCommand")) {
    paths.push(prefixPath(prefix, "runtimeProvisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  return paths;
}

function collectWorkspaceRuntimeCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  for (const collectionKey of ["commands", "services", "jobs"] as const) {
    const entries = raw[collectionKey];
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      if (isRecord(entry) && hasOwn(entry, "command")) {
        paths.push(`${prefixPath(prefix, collectionKey)}[${index}].command`);
      }
    });
  }
  return paths;
}

function collectExecutionWorkspaceConfigCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "runtimeProvisionCommand")) {
    paths.push(prefixPath(prefix, "runtimeProvisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  if (hasOwn(raw, "cleanupCommand")) {
    paths.push(prefixPath(prefix, "cleanupCommand"));
  }
  paths.push(
    ...collectWorkspaceRuntimeCommandPaths(
      raw.workspaceRuntime,
      prefixPath(prefix, "workspaceRuntime"),
    ),
  );
  return paths;
}

export function assertNoAgentHostWorkspaceCommandMutation(req: Request, paths: string[]) {
  if (req.actor.type !== "agent" || paths.length === 0) return;
  throw forbidden(
    `Agent keys cannot modify host-executed workspace commands (${paths.join(", ")}).`,
  );
}

// [stenas:identity-lock] A task's assigneeAdapterOverrides.adapterConfig is merged
// into the assignee's run, which executes as the assignee's Unix user. Agents may
// not set it, or one agent could run its own command or env as another identity.
export function assertNoAgentAssigneeAdapterConfigOverride(
  req: Request,
  input: { assigneeAdapterOverrides?: unknown },
) {
  if (req.actor.type !== "agent" || !isRecord(input.assigneeAdapterOverrides)) return;
  const adapterConfig = input.assigneeAdapterOverrides.adapterConfig;
  if (!isRecord(adapterConfig) || Object.keys(adapterConfig).length === 0) return;
  throw forbidden(
    `Agent keys cannot set assigneeAdapterOverrides.adapterConfig (${Object.keys(adapterConfig)
      .sort()
      .map((key) => `assigneeAdapterOverrides.adapterConfig.${key}`)
      .join(", ")}).`,
  );
}

// [stenas:identity-lock] Project env is merged into every run in the project,
// including other agents' runs under their own Unix users, so agents may not set it.
export function assertNoAgentProjectEnvMutation(req: Request, input: { env?: unknown }) {
  if (req.actor.type !== "agent" || input.env === undefined) return;
  throw forbidden("Agent keys cannot set project env.");
}

export function collectAgentAdapterWorkspaceCommandPaths(
  adapterConfig: unknown,
  prefix = "adapterConfig",
): string[] {
  if (!isRecord(adapterConfig)) return [];
  return collectWorkspaceStrategyCommandPaths(
    adapterConfig.workspaceStrategy,
    `${prefix}.workspaceStrategy`,
  );
}

export function collectProjectExecutionWorkspaceCommandPaths(policy: unknown): string[] {
  if (!isRecord(policy)) return [];
  return [
    ...collectWorkspaceStrategyCommandPaths(
      policy.workspaceStrategy,
      "executionWorkspacePolicy.workspaceStrategy",
    ),
    ...collectWorkspaceRuntimeCommandPaths(
      policy.workspaceRuntime,
      "executionWorkspacePolicy.workspaceRuntime",
    ),
  ];
}

export function collectProjectWorkspaceCommandPaths(
  workspacePatch: unknown,
  prefix = "",
): string[] {
  if (!isRecord(workspacePatch)) return [];
  const paths = hasOwn(workspacePatch, "cleanupCommand")
    ? [prefixPath(prefix, "cleanupCommand")]
    : [];
  if (isRecord(workspacePatch.runtimeConfig)) {
    paths.push(
      ...collectWorkspaceRuntimeCommandPaths(
        workspacePatch.runtimeConfig.workspaceRuntime,
        prefixPath(prefix, "runtimeConfig.workspaceRuntime"),
      ),
    );
  }
  return paths;
}

export function collectIssueWorkspaceCommandPaths(input: {
  executionWorkspaceSettings?: unknown;
  assigneeAdapterOverrides?: unknown;
}): string[] {
  const paths: string[] = [];
  if (isRecord(input.executionWorkspaceSettings)) {
    paths.push(
      ...collectWorkspaceStrategyCommandPaths(
        input.executionWorkspaceSettings.workspaceStrategy,
        "executionWorkspaceSettings.workspaceStrategy",
      ),
    );
    paths.push(
      ...collectWorkspaceRuntimeCommandPaths(
        input.executionWorkspaceSettings.workspaceRuntime,
        "executionWorkspaceSettings.workspaceRuntime",
      ),
    );
  }
  if (isRecord(input.assigneeAdapterOverrides)) {
    const adapterConfig = input.assigneeAdapterOverrides.adapterConfig;
    if (isRecord(adapterConfig)) {
      paths.push(
        ...collectWorkspaceStrategyCommandPaths(
          adapterConfig.workspaceStrategy,
          "assigneeAdapterOverrides.adapterConfig.workspaceStrategy",
        ),
      );
    }
  }
  return paths;
}

export function collectExecutionWorkspaceCommandPaths(input: {
  config?: unknown;
  metadata?: unknown;
}): string[] {
  const paths: string[] = [];
  if (input.config !== undefined) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.config, "config"));
  }
  if (isRecord(input.metadata) && hasOwn(input.metadata, "config")) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.metadata.config, "metadata.config"));
  }
  return paths;
}
