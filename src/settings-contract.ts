import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { connectionSettingsSchema } from "./connection-settings.ts";
import { goUsageSnapshotSchema } from "./usage-contract.ts";

/** The BB session option through which OpenCode's primary agent is chosen. */
export const AGENT_OPTION_ID = "agent";
/** OpenCode's default primary agent. */
export const DEFAULT_AGENT = "build";

export const modelSummarySchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    displayName: z.string().min(1),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const openCodeStatusSchema = z
  .object({
    status: z.enum([
      "ready",
      "not_installed",
      "unsupported_version",
      "unauthenticated",
      "unknown",
    ]),
    statusMessage: z.string().nullable(),
    installedVersion: z.string().nullable(),
    latestVersion: z.string().nullable(),
    minimumSupportedVersion: z.string(),
    loginCommand: z.string(),
    modelCount: z.number().int().nonnegative(),
    connectionMode: z.enum(["auto", "custom"]).optional(),
    serverUrl: z.string().optional(),
  })
  .strict();

export const hostStatusSchema = z
  .object({
    hostId: z.string().min(1),
    hostName: z.string(),
    status: openCodeStatusSchema.optional(),
    error: z.string().optional(),
  })
  .strict();

export const modelSettingsSchema = z
  .object({
    providerEnabled: z.boolean(),
    // null means every discovered model is enabled. An array is the exact
    // allowlist, including an empty array for "disable all".
    enabledModels: z.array(z.string().min(1)).max(10_000).nullable(),
    // Prevent OpenCode from starting native subagents (task tool) so agents
    // use BB for delegation instead. Missing key defaults to true so older
    // stored settings migrate to the safer default.
    disableSubagents: z.boolean().default(true),
    // Add one deny rule to OpenCode's global config so OpenCode's own
    // sessions (TUI, web) don't list BB threads' tools. On by default.
    hideBbToolsOutsideBb: z.boolean().default(true),
    reportGoUsage: z.boolean().default(false),
  })
  .strict();

export const opencodeHostContract = defineRpcContract({
  getGoUsage: {
    input: z.object({}).strict(),
    output: goUsageSnapshotSchema,
  },
  configureConnection: {
    input: connectionSettingsSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  listModels: {
    input: z.object({ cwd: z.string().min(1).optional() }).strict(),
    output: z
      .object({ models: z.array(modelSummarySchema).max(10_000) })
      .strict(),
  },
  setModelSettings: {
    input: modelSettingsSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  getStatus: {
    input: z.object({}).strict(),
    output: openCodeStatusSchema,
  },
});

export const opencodeSettingsRpcContract = defineRpcContract({
  getSettings: {
    input: z.null(),
    output: modelSettingsSchema,
  },
  listModels: {
    input: z.object({}).strict(),
    output: z
      .object({ models: z.array(modelSummarySchema).max(10_000) })
      .strict(),
  },
  // The agent picked in a new-thread composer, held until its thread exists.
  getNewThreadAgent: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({ agent: z.string().min(1).nullable() }).strict(),
  },
  setNewThreadAgent: {
    input: z
      .object({
        projectId: z.string().min(1),
        agent: z.string().min(1).nullable(),
      })
      .strict(),
    output: z.object({ agent: z.string().min(1).nullable() }).strict(),
  },
  saveSettings: {
    input: modelSettingsSchema,
    output: modelSettingsSchema,
  },
  getStatus: {
    input: z.object({}).strict(),
    output: z.object({ hosts: z.array(hostStatusSchema).max(1_000) }).strict(),
  },
});

export type ModelSettings = z.infer<typeof modelSettingsSchema>;
export type ModelSummary = z.infer<typeof modelSummarySchema>;
export type OpenCodeStatus = z.infer<typeof openCodeStatusSchema>;
export type HostStatus = z.infer<typeof hostStatusSchema>;
