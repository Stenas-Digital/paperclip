import type { Request } from "express";
import { describe, expect, it } from "vitest";
import {
  assertNoAgentAssigneeAdapterConfigOverride,
  assertNoAgentProjectEnvMutation,
  collectExecutionWorkspaceCommandPaths,
  collectIssueWorkspaceCommandPaths,
  collectProjectExecutionWorkspaceCommandPaths,
  collectProjectWorkspaceCommandPaths,
} from "../routes/workspace-command-authz.js";

describe("workspace host-command mutation detection", () => {
  it.each([
    {
      name: "project execution policy commands",
      actual: () => collectProjectExecutionWorkspaceCommandPaths({
        workspaceRuntime: { commands: [{ name: "seed", command: "pnpm seed" }] },
      }),
      expected: "executionWorkspacePolicy.workspaceRuntime.commands[0].command",
    },
    {
      name: "project execution policy services",
      actual: () => collectProjectExecutionWorkspaceCommandPaths({
        workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] },
      }),
      expected: "executionWorkspacePolicy.workspaceRuntime.services[0].command",
    },
    {
      name: "project workspace jobs",
      actual: () => collectProjectWorkspaceCommandPaths({
        runtimeConfig: { workspaceRuntime: { jobs: [{ name: "build", command: "pnpm build" }] } },
      }),
      expected: "runtimeConfig.workspaceRuntime.jobs[0].command",
    },
    {
      name: "issue execution workspace services",
      actual: () => collectIssueWorkspaceCommandPaths({
        executionWorkspaceSettings: {
          workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] },
        },
      }),
      expected: "executionWorkspaceSettings.workspaceRuntime.services[0].command",
    },
    {
      name: "execution workspace config commands",
      actual: () => collectExecutionWorkspaceCommandPaths({
        config: { workspaceRuntime: { commands: [{ name: "seed", command: "pnpm seed" }] } },
      }),
      expected: "config.workspaceRuntime.commands[0].command",
    },
    {
      name: "execution workspace metadata jobs",
      actual: () => collectExecutionWorkspaceCommandPaths({
        metadata: {
          config: { workspaceRuntime: { jobs: [{ name: "build", command: "pnpm build" }] } },
        },
      }),
      expected: "metadata.config.workspaceRuntime.jobs[0].command",
    },
  ])("detects $name", ({ actual, expected }) => {
    expect(actual()).toContain(expected);
  });

  it("ignores descriptive runtime entries without a command field", () => {
    expect(collectProjectExecutionWorkspaceCommandPaths({
      workspaceRuntime: {
        commands: [{ name: "seed" }],
        services: [{ name: "web", port: 3100 }],
        jobs: [null, "build"],
      },
    })).toEqual([]);
  });
});

// [stenas:identity-lock]
describe("agent identity lock on task overrides and project env", () => {
  const agentReq = { actor: { type: "agent", agentId: "agent-1" } } as unknown as Request;
  const boardReq = { actor: { type: "board", userId: "user-1" } } as unknown as Request;

  it("refuses agent-set assigneeAdapterOverrides.adapterConfig", () => {
    expect(() => assertNoAgentAssigneeAdapterConfigOverride(agentReq, {
      assigneeAdapterOverrides: { adapterConfig: { env: { NODE_OPTIONS: "--require /tmp/x.js" } } },
    })).toThrow(/assigneeAdapterOverrides\.adapterConfig\.env/);
    expect(() => assertNoAgentAssigneeAdapterConfigOverride(agentReq, {
      assigneeAdapterOverrides: { adapterConfig: { command: "/bin/sh" } },
    })).toThrow(/assigneeAdapterOverrides\.adapterConfig\.command/);
  });

  it("allows agents to send overrides without adapterConfig", () => {
    expect(() => assertNoAgentAssigneeAdapterConfigOverride(agentReq, {
      assigneeAdapterOverrides: { useProjectWorkspace: true },
    })).not.toThrow();
    expect(() => assertNoAgentAssigneeAdapterConfigOverride(agentReq, {
      assigneeAdapterOverrides: { adapterConfig: {} },
    })).not.toThrow();
    expect(() => assertNoAgentAssigneeAdapterConfigOverride(agentReq, {})).not.toThrow();
  });

  it("leaves board users free to set overrides and project env", () => {
    expect(() => assertNoAgentAssigneeAdapterConfigOverride(boardReq, {
      assigneeAdapterOverrides: { adapterConfig: { model: "x" } },
    })).not.toThrow();
    expect(() => assertNoAgentProjectEnvMutation(boardReq, { env: { A: "b" } })).not.toThrow();
  });

  it("refuses agent-set project env, including clearing it", () => {
    expect(() => assertNoAgentProjectEnvMutation(agentReq, { env: { A: "b" } })).toThrow(/project env/);
    expect(() => assertNoAgentProjectEnvMutation(agentReq, { env: null })).toThrow(/project env/);
    expect(() => assertNoAgentProjectEnvMutation(agentReq, { name: "x" } as { env?: unknown })).not.toThrow();
  });
});
