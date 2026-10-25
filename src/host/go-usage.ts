import { z } from "zod";
import { unavailableGoUsage, type GoUsageSnapshot } from "../usage-contract.ts";

const meterSchema = z.object({
  percent: z.number().min(0).max(100),
  limited: z.boolean(),
  resetsAt: z
    .number()
    .int()
    .nonnegative()
    .refine((value) => Number.isFinite(new Date(value).getTime())),
});
const limitsSchema = z.object({
  data: z
    .object({
      workspace: z.object({
        id: z.string().min(1),
        name: z.string().optional(),
      }),
      go: z
        .object({
          rolling: meterSchema,
          weekly: meterSchema,
          monthly: meterSchema,
        })
        .optional(),
    })
    .nullable(),
});

export function mapGoUsage(value: unknown, now = Date.now()): GoUsageSnapshot {
  const parsed = limitsSchema.safeParse(value);
  if (!parsed.success)
    return unavailableGoUsage("OpenCode returned an invalid usage response.");
  const info = parsed.data.data;
  if (!info) {
    return {
      label: null,
      measurement: {
        accountKey: null,
        observedAt: null,
        usage: {
          status: "unauthenticated",
          plan: null,
          accountEmail: null,
          planLabel: null,
        },
      },
    };
  }
  const label = `OpenCode Go · ${info.workspace.name?.trim() || info.workspace.id}`;
  const accountKey = `opencode.ai:workspace:${info.workspace.id}`;
  if (!info.go) {
    const result = unavailableGoUsage(
      "This OpenCode workspace has no Go subscription allowance.",
    );
    return {
      label,
      measurement: { ...result.measurement, accountKey },
    };
  }
  const go = info.go;
  return {
    label,
    measurement: {
      accountKey,
      observedAt: now,
      usage: {
        status: "ok",
        // The endpoint does not distinguish Go from Go Plus. Do not guess.
        plan: null,
        accountEmail: null,
        planLabel: "OpenCode Go",
        windows: (
          [
            ["rolling", "five-hour", "Five-hour limit"],
            ["weekly", "weekly", "Weekly limit"],
            ["monthly", "custom", "Monthly limit"],
          ] as const
        ).map(([id, kind, label]) => {
          const meter = go[id];
          return {
            id,
            kind,
            label,
            usedPercent: meter.percent,
            resetsAt: new Date(meter.resetsAt).toISOString(),
            model: null,
            cost: null,
          };
        }),
      },
    },
  };
}

/** Only the configured local OpenCode API handles provider authentication. */
export class GoUsageReader {
  private controller = new AbortController();

  clear() {
    this.controller.abort();
    this.controller = new AbortController();
  }

  async read(
    request: (path: string, init: RequestInit) => Promise<unknown>,
    callerSignal?: AbortSignal,
  ): Promise<GoUsageSnapshot> {
    const signal = this.controller.signal;
    try {
      const value = await request("/api/experimental/usage/limits", {
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(30_000),
          ...(callerSignal ? [callerSignal] : []),
        ]),
      });
      if (signal.aborted || callerSignal?.aborted)
        return unavailableGoUsage(
          "OpenCode Go usage collection was cancelled.",
        );
      return mapGoUsage(value);
    } catch (error) {
      // Never expose an API response body, URL, or credential through the panel.
      const message = error instanceof Error ? error.message : "";
      return unavailableGoUsage(
        /OpenCode API (404|405|501)\b/.test(message)
          ? "This OpenCode version does not support Go usage limits. Update OpenCode."
          : "Could not read Go usage from the configured OpenCode instance. Check its connection and Console sign-in.",
      );
    }
  }
}
