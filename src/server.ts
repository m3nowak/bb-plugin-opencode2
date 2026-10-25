// BB provider registration for OpenCode v2.
//
// The host bridge talks to OpenCode's local v2 HTTP API. This file only owns
// provider metadata and keeps process/API details out of the BB server runtime.
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_SERVER_URL,
  connectionUrl,
  serverUrlSchema,
  type ConnectionSettings,
} from "./connection-settings.ts";
import {
  AGENT_OPTION_ID,
  opencodeHostContract,
  opencodeSettingsRpcContract,
  type HostStatus,
  type ModelSummary,
} from "./settings-contract.ts";
import { normalizeModelSettings } from "./model-settings.ts";
import { registerGoUsageSource } from "./usage-source.ts";

const PROVIDER_ID = "opencode2";
const SETTINGS_KEY = "model-settings";
const SEEDS_KEY = "new-thread-agents";
// A new-thread pick that is never used must not attach to a thread much later.
const SEED_TTL_MS = 10 * 60_000;
const ALIGN_POLL_MS = 300;
const ALIGN_TIMEOUT_MS = 30_000;

type AgentSeed = { agent: string; at: number };

export default async function plugin(bb: BbPluginApi) {
  const connection = bb.settings.define({
    connectionMode: {
      type: "select",
      label: "OpenCode connection",
      options: ["auto", "custom"],
      experimental_optionLabels: {
        auto: "Automatic local service",
        custom: "Existing local instance",
      },
      default: "auto",
      description:
        "After changing the server, reload this plugin and start new threads. Active turns keep their existing connection.",
    },
    serverUrl: {
      type: "string",
      label: "OpenCode server URL",
      default: DEFAULT_SERVER_URL,
      experimental_schema: serverUrlSchema,
      description:
        "Existing instance on the BB server machine. Only loopback HTTP(S) addresses are supported.",
    },
    serverUsername: {
      type: "string",
      label: "OpenCode username",
      default: "opencode",
      experimental_schema: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[^:\r\n]+$/),
    },
    serverPassword: {
      type: "string",
      label: "OpenCode password",
      secret: true,
      description:
        "Stored as a BB secret. Used only for the existing-instance connection.",
      experimental_schema: z.string().max(16_384),
    },
  });
  let modelSettings = normalizeModelSettings(
    await bb.storage.kv.get(SETTINGS_KEY),
  );
  // The composer's agent pick before its thread exists, by project. The new
  // thread takes it once: BB's own session-option selection can only be set on
  // a thread that already exists, so the first turn gets it as a provider
  // option instead.
  const seeds = new Map<string, AgentSeed>(
    Object.entries(
      ((await bb.storage.kv.get(SEEDS_KEY)) as Record<
        string,
        AgentSeed
      > | null) ?? {},
    ),
  );
  const newThreads = new Set<string>();
  bb.events.on("thread.created", ({ thread }) => {
    if (thread.providerId === PROVIDER_ID) newThreads.add(thread.id);
  });
  const host = bb.hosts.experimental_client({ contract: opencodeHostContract });
  const syncedSettings = new Map<string, string>();
  const goUsage = registerGoUsageSource(bb, {
    providerId: PROVIDER_ID,
    enabled: () => modelSettings.reportGoUsage,
  });
  connection.onChange(() => {
    syncedSettings.clear();
    goUsage.clear();
  });

  async function connectedHostIds(signal?: AbortSignal) {
    return (await bb.sdk.hosts.list({ signal }))
      .filter((item) => item.status === "connected")
      .map((item) => item.id);
  }

  async function syncSettings(hostIds?: string[], signal?: AbortSignal) {
    const connected = hostIds ?? (await connectedHostIds(signal));
    const values = await connection.get();
    const mode = values.connectionMode === "custom" ? "custom" : "auto";
    const config: ConnectionSettings = {
      mode,
      url: values.serverUrl,
      username: values.serverUsername,
      password: mode === "custom" ? (values.serverPassword ?? "") : "",
    };
    const revision = createHash("sha256")
      .update(JSON.stringify({ modelSettings, config }))
      .digest("hex");
    // A localhost URL names the BB server machine, not every enrolled machine.
    // Never distribute this password to remote execution hosts.
    const localHosts =
      mode === "custom"
        ? new Set(
            (await bb.sdk.hosts.list({ signal }))
              .filter((item) => item.machineProviderId === null)
              .map((item) => item.id),
          )
        : new Set<string>();
    const targets = connected.filter(
      (hostId) => syncedSettings.get(hostId) !== revision,
    );
    const results = await Promise.allSettled(
      targets.map((hostId) => {
        const call = host
          .call(
            "configureConnection",
            {
              ...config,
              password:
                mode === "custom" && !localHosts.has(hostId)
                  ? ""
                  : config.password,
            },
            { hostId, signal },
          )
          .then(() =>
            host.call("setModelSettings", modelSettings, { hostId, signal }),
          );
        if (!signal) return call;
        return new Promise((resolve, reject) => {
          const aborted = () =>
            reject(signal.reason ?? new Error("Settings sync aborted"));
          if (signal.aborted) {
            aborted();
            return;
          }
          signal.addEventListener("abort", aborted, { once: true });
          call.then(resolve, reject).finally(() => {
            signal.removeEventListener("abort", aborted);
          });
        });
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        syncedSettings.set(targets[index], revision);
      }
    });
    for (const hostId of syncedSettings.keys()) {
      if (!connected.includes(hostId)) syncedSettings.delete(hostId);
    }
    if (
      !signal?.aborted &&
      results.some((result) => result.status === "rejected")
    ) {
      bb.log.warn(
        "Could not sync OpenCode model settings to every connected host",
      );
      if (mode === "custom")
        throw new Error(
          "Could not synchronize the configured OpenCode connection. No automatic fallback was used.",
        );
    }
  }

  async function listModels() {
    const hostIds = await connectedHostIds();
    await syncSettings(hostIds);
    const results = await Promise.allSettled(
      hostIds.map((hostId) => host.call("listModels", {}, { hostId })),
    );
    const models = new Map<string, ModelSummary>();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const model of result.value.models) models.set(model.id, model);
    }
    return {
      models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  function freshSeed(projectId: string) {
    const seed = seeds.get(projectId);
    return seed && Date.now() - seed.at <= SEED_TTL_MS ? seed.agent : null;
  }

  async function setSeed(projectId: string, agent: string | null) {
    if (agent === null) seeds.delete(projectId);
    else seeds.set(projectId, { agent, at: Date.now() });
    await bb.storage.kv.set(SEEDS_KEY, Object.fromEntries(seeds));
    return { agent };
  }

  // The new thread's native selection may still hold a stale draft choice from
  // before it existed, which would show as pending and apply on a later turn.
  // Overwrite it once the host has reported the option; the thread cannot take
  // a selection before that.
  async function alignNativeSelection(threadId: string, agent: string) {
    const deadline = Date.now() + ALIGN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, ALIGN_POLL_MS));
      try {
        const timeline = await bb.sdk.threads.timeline({
          threadId,
          summaryOnly: "true",
        });
        const option = timeline.sessionOptions?.find(
          (candidate) => candidate.id === AGENT_OPTION_ID,
        );
        if (!option) continue;
        if (option.value === agent && (option.pendingValue ?? null) === null)
          return;
        await bb.sdk.threads.update({
          threadId,
          sessionOptions: { [AGENT_OPTION_ID]: agent },
        });
      } catch (error) {
        bb.log.warn(
          `Could not align the agent selection: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }
  }

  // Only a thread's first command may take the pick, and only a thread created
  // while this plugin was running, so an older thread never inherits it.
  function takeSeed(threadId: string, projectId: string) {
    if (!newThreads.delete(threadId)) return undefined;
    const agent = freshSeed(projectId);
    if (agent === null) return undefined;
    void setSeed(projectId, null);
    void alignNativeSelection(threadId, agent);
    return agent;
  }

  async function getStatus() {
    const hosts = (await bb.sdk.hosts.list()).filter(
      (item) => item.status === "connected",
    );
    await syncSettings(hosts.map((item) => item.id));
    const results = await Promise.all(
      hosts.map(async (item): Promise<HostStatus> => {
        try {
          return {
            hostId: item.id,
            hostName: item.name,
            status: await host.call("getStatus", {}, { hostId: item.id }),
          };
        } catch (error) {
          return {
            hostId: item.id,
            hostName: item.name,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return { hosts: results };
  }

  bb.rpc.register(opencodeSettingsRpcContract, {
    getSettings: () => modelSettings,
    listModels,
    getNewThreadAgent: ({ projectId }) => ({ agent: freshSeed(projectId) }),
    setNewThreadAgent: ({ projectId, agent }) => setSeed(projectId, agent),
    getStatus,
    async saveSettings(next) {
      modelSettings = normalizeModelSettings(next);
      if (!modelSettings.reportGoUsage) goUsage.clear();
      await bb.storage.kv.set(SETTINGS_KEY, modelSettings);
      await syncSettings();
      bb.realtime.publish("settings-changed", modelSettings);
      return modelSettings;
    },
  });

  bb.background.service("sync-model-settings", {
    async start(signal) {
      while (!signal.aborted) {
        await syncSettings(undefined, signal);
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          const stop = () => {
            clearTimeout(timeout);
            resolve();
          };
          const timeout = setTimeout(() => {
            signal.removeEventListener("abort", stop);
            resolve();
          }, 5_000);
          signal.addEventListener("abort", stop, { once: true });
        });
      }
    },
  });

  bb.providers.register({
    id: PROVIDER_ID,
    displayName: "OpenCode v2",
    icon: "./icons/opencode.svg",
    strings: {
      // Also shown by the usage panel, where the sign-in is OpenCode Console.
      signInHint:
        "Run `opencode2 auth login` on this machine to connect a model provider, or OpenCode Console for Go usage.",
      expiredHint:
        "An OpenCode model provider or OpenCode Console sign-in needs to be reconnected. Run `opencode2 auth login`, then reload.",
      installUrl: "https://opencode.ai/v2/docs/",
      brandPrefix: "OpenCode ",
      iconTint: { light: "#18181B", dark: "#FAFAFA" },
      planModeCopy:
        "OpenCode's read-only plan agent will explore and plan without editing files.",
    },
    // Only show the provider when `opencode2` is installed on the target machine.
    experimental_visibility: "installed",
    // Usage is OpenCode Go only, opt-in; the bridge answers unsupported
    // until `reportGoUsage` is on.
    maintenance: { health: true, usage: true, installation: true },
    models: { scope: "workspace" },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: true,
      fork: "checkpoint",
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ],
    },
    composerActions: ["plan"],
    // OpenCode discovers skills in more places than BB scans by default;
    // the host entry answers with the roots OpenCode actually uses.
    experimental_resolvesNativeRoots: true,
    // Settings reach every session and turn command as providerOptions, so a
    // change applies on the next turn without waiting for the host sync.
    deriveProviderOptions: ({ threadId, projectId, settings }) => {
      const agent = takeSeed(threadId, projectId);
      const connectionId =
        settings.connectionMode === "custom"
          ? `custom:${connectionUrl(String(settings.serverUrl ?? DEFAULT_SERVER_URL))}`
          : "auto";
      return { modelSettings, connectionId, ...(agent ? { agent } : {}) };
    },
  });

  bb.log.info("registered OpenCode v2 provider");
}
