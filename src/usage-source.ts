import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  GET_USAGE_RESOURCE,
  LIST_USAGE_RESOURCES,
  usageMeasurementSchema,
  usageSourceContract,
  type UsageMeasurement,
} from "./usage-contract.ts";

const CACHE_TTL_MS = 60_000;

const resourceIdSchema = z.tuple([z.string().min(1), z.string().min(1)]);
const accountSchema = z.object({
  accountKey: z.string().min(1).nullable().catch(null),
  plan: z
    .object({
      id: z.string().min(1),
      multiplier: z.number().int().positive().nullable(),
    })
    .nullable()
    .catch(null),
});
const windowSchema = z.object({
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]).catch("custom"),
  model: z.string().nullable().catch(null),
});

/**
 * Host-scoped usage like BB's own providers: one resource per machine whose
 * OpenCode v2 provider reports usage, so the panel groups it by machine. The
 * bridge's `provider/usage` collects; this only caches and adapts.
 */
export function registerGoUsageSource(
  bb: BbPluginApi,
  options: { providerId: string; enabled(): boolean },
) {
  const { providerId } = options;
  const cache = new Map<string, UsageMeasurement>();
  const pending = new Map<
    string,
    { refresh: boolean; promise: Promise<UsageMeasurement> }
  >();
  let generation = 0;

  function clear() {
    generation++;
    cache.clear();
    pending.clear();
  }

  function assertCurrent(revision: number) {
    if (!options.enabled() || revision !== generation)
      throw new Error(
        "OpenCode Go usage configuration changed. Relist resources.",
      );
  }

  async function load(
    resourceId: string,
    refresh: boolean,
  ): Promise<UsageMeasurement> {
    if (!options.enabled())
      throw new Error("Usage resource no longer exists. Relist resources.");
    const revision = generation;
    const parsed = resourceIdSchema.safeParse(
      (() => {
        try {
          return JSON.parse(resourceId);
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success || parsed.data[1] !== providerId)
      throw new Error("Usage resource no longer exists. Relist resources.");
    const [hostId] = parsed.data;
    const host = await bb.sdk.hosts.get({ hostId }).catch((error) => {
      throw error instanceof Error && "status" in error && error.status === 404
        ? new Error("Usage resource no longer exists. Relist resources.")
        : error;
    });
    const previous = cache.get(resourceId);
    const unavailable = (message: string) =>
      usageMeasurementSchema.parse({
        accountKey: previous?.accountKey ?? null,
        observedAt: previous?.observedAt ?? null,
        usage: {
          status: "error",
          accountEmail: null,
          planLabel: null,
          message,
        },
      });
    if (host.status === "disconnected")
      return unavailable("Machine is disconnected.");
    if (
      !(await bb.sdk.providers.list({ hostId, capability: "usage" })).some(
        (provider) => provider.id === providerId,
      )
    )
      throw new Error("Usage resource no longer exists. Relist resources.");
    assertCurrent(revision);
    if (
      !refresh &&
      previous?.usage.status === "ok" &&
      previous.observedAt !== null &&
      Date.now() - previous.observedAt < CACHE_TTL_MS
    )
      return previous;
    let measurement: UsageMeasurement;
    try {
      const usage = (
        await bb.sdk.system.usageLimits({ hostId, providerId, refresh })
      )[providerId];
      // The bridge answers `supported: false` where it has no OpenCode to
      // ask; BB hides not_installed rows instead of reporting a failure.
      const value = (usage ?? { status: "not_installed" }) as Record<
        string,
        unknown
      > & { status: string; windows?: Record<string, unknown>[] };
      const account = accountSchema.parse(value);
      measurement = usageMeasurementSchema.parse({
        accountKey: account.accountKey,
        observedAt:
          value.status === "ok" ? Date.now() : (previous?.observedAt ?? null),
        usage: {
          status: value.status,
          accountEmail: value.accountEmail ?? null,
          planLabel: value.planLabel ?? null,
          ...(value.status === "error" ? { message: value.message } : {}),
          plan: account.plan,
          ...(value.status === "ok"
            ? {
                windows: (value.windows ?? []).map((window, index) => ({
                  label: window.label,
                  usedPercent: window.usedPercent,
                  resetsAt: window.resetsAt ?? null,
                  ...windowSchema.parse(window),
                  id: `${index}:${String(window.label)}`,
                  cost: window.cost ?? null,
                })),
              }
            : {}),
        },
      });
    } catch {
      return unavailable("Usage could not be collected from this machine.");
    }
    assertCurrent(revision);
    cache.set(resourceId, measurement);
    return measurement;
  }

  async function get(
    resourceId: string,
    refresh: boolean,
  ): Promise<UsageMeasurement> {
    const existing = pending.get(resourceId);
    if (existing) {
      if (!refresh || existing.refresh) return existing.promise;
      const revision = generation;
      await existing.promise.catch(() => {});
      assertCurrent(revision);
      return get(resourceId, refresh);
    }
    const entry = {
      refresh,
      promise: load(resourceId, refresh).finally(() => {
        if (pending.get(resourceId) === entry) pending.delete(resourceId);
      }),
    };
    pending.set(resourceId, entry);
    return entry.promise;
  }

  bb.rpc.register(
    usageSourceContract,
    {
      async [LIST_USAGE_RESOURCES]() {
        if (!options.enabled()) return { resources: [] };
        const revision = generation;
        const hosts = await bb.sdk.hosts.list();
        const resources = (
          await Promise.all(
            hosts.map(async (host) =>
              (
                await bb.sdk.providers.list({
                  hostId: host.id,
                  capability: "usage",
                })
              )
                .filter((provider) => provider.id === providerId)
                .map((provider) => {
                  const id = JSON.stringify([host.id, provider.id]);
                  return {
                    id,
                    accountKey: cache.get(id)?.accountKey ?? null,
                    providerId: provider.id,
                    label: provider.displayName,
                    scope: {
                      kind: "host" as const,
                      hostId: host.id,
                      hostName: host.name,
                    },
                  };
                }),
            ),
          )
        ).flat();
        if (!options.enabled() || revision !== generation)
          return { resources: [] };
        const ids = new Set(resources.map((resource) => resource.id));
        for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
        return { resources };
      },
      [GET_USAGE_RESOURCE]: ({ resourceId, refresh }) =>
        get(resourceId, refresh),
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Host-local OpenCode Go usage owned by the OpenCode v2 provider plugin. Inventory reads metadata only. Opt-in; disabled by default.",
    },
  );
  return { clear };
}
