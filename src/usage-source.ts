import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  GET_USAGE_RESOURCE,
  LIST_USAGE_RESOURCES,
  goUsageSnapshotSchema,
  unavailableGoUsage,
  usageSourceContract,
  type GoUsageSnapshot,
  type UsageMeasurement,
} from "./usage-contract.ts";

const CACHE_TTL_MS = 60_000;

export function registerGoUsageSource(
  bb: BbPluginApi,
  options: {
    enabled(): boolean;
    load(hostId: string, signal: AbortSignal): Promise<GoUsageSnapshot>;
  },
) {
  const cache = new Map<string, { at: number; snapshot: GoUsageSnapshot }>();
  const pending = new Map<
    string,
    { refresh: boolean; promise: Promise<UsageMeasurement> }
  >();
  let generation = 0;
  let controller = new AbortController();

  function clear() {
    generation++;
    controller.abort();
    controller = new AbortController();
    cache.clear();
    pending.clear();
  }

  async function collect(
    hostId: string,
    refresh: boolean,
  ): Promise<UsageMeasurement> {
    if (!options.enabled()) throw new Error("OpenCode Go usage is disabled.");
    const revision = generation;
    const signal = controller.signal;
    const hosts = await bb.sdk.hosts.list();
    if (
      !hosts.some((host) => host.id === hostId && host.status === "connected")
    )
      throw new Error("Usage resource no longer exists. Relist resources.");
    if (!options.enabled() || revision !== generation)
      throw new Error(
        "OpenCode Go usage configuration changed. Relist resources.",
      );
    const entry = cache.get(hostId);
    const cached = entry?.snapshot.measurement;
    if (
      !refresh &&
      cached?.usage.status === "ok" &&
      cached.observedAt !== null &&
      entry &&
      Date.now() - entry.at < CACHE_TTL_MS
    )
      return cached;

    let snapshot: GoUsageSnapshot;
    try {
      snapshot = goUsageSnapshotSchema.parse(
        await options.load(hostId, signal),
      );
    } catch {
      snapshot = unavailableGoUsage(
        "Could not collect Go usage from this host.",
      );
    }
    if (!options.enabled() || revision !== generation)
      throw new Error(
        "OpenCode Go usage configuration changed. Relist resources.",
      );
    cache.set(hostId, { at: Date.now(), snapshot });
    return snapshot.measurement;
  }

  async function get(
    hostId: string,
    refresh: boolean,
  ): Promise<UsageMeasurement> {
    if (!options.enabled()) throw new Error("OpenCode Go usage is disabled.");
    const revision = generation;
    const existing = pending.get(hostId);
    if (existing) {
      if (!refresh || existing.refresh) return existing.promise;
      await existing.promise.catch(() => {});
      if (revision !== generation)
        throw new Error(
          "OpenCode Go usage configuration changed. Relist resources.",
        );
      return get(hostId, refresh);
    }
    const entry = {
      refresh,
      promise: collect(hostId, refresh).finally(() => {
        if (pending.get(hostId) === entry) pending.delete(hostId);
      }),
    };
    pending.set(hostId, entry);
    return entry.promise;
  }

  bb.rpc.register(
    usageSourceContract,
    {
      async [LIST_USAGE_RESOURCES]() {
        if (!options.enabled()) return { resources: [] };
        const revision = generation;
        const hosts = (await bb.sdk.hosts.list()).filter(
          (host) => host.status === "connected",
        );
        if (!options.enabled() || revision !== generation)
          return { resources: [] };
        const ids = new Set(hosts.map((host) => host.id));
        for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
        return {
          label: "OpenCode Go",
          resources: hosts.map((host) => ({
            id: host.id,
            accountKey:
              cache.get(host.id)?.snapshot.measurement.accountKey ?? null,
            providerId: "opencode2",
            label:
              cache.get(host.id)?.snapshot.label ??
              `OpenCode Go · ${host.name}`,
            // Shared scope lets BB deduplicate the same workspace across hosts,
            // including identities learned during this panel's first collection.
            scope: { kind: "shared" as const },
          })),
        };
      },
      [GET_USAGE_RESOURCE]: ({ resourceId, refresh }) =>
        get(resourceId, refresh),
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Optional OpenCode Go usage from configured OpenCode instances on all connected hosts. Shared display group, deduplicated by provider-issued workspace identity. Disabled by default.",
    },
  );
  return { clear };
}
