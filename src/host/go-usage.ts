import { z } from "zod";
import type { ConnectionSettings } from "../connection-settings.ts";
import type { ModelSettings } from "../settings-contract.ts";

/** The only place an OpenCode Console token is ever sent. */
export const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CONSOLE_SERVER = "https://opencode.ai/console";
const PLAN_LABEL = "OpenCode Go";

/** BB's `provider/usage` answer: `supported: false` hides this machine. */
export type GoUsageResult =
  | { supported: false }
  | { supported: true; usage: Record<string, unknown> & { status: string } };

const consoleCredentialSchema = z.object({
  integrationID: z.literal("opencode"),
  active: z.literal(true),
  value: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("oauth"),
      access: z.string().min(1),
      expires: z.number().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    z.object({
      type: z.literal("key"),
      key: z.string().min(1),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ]),
});

export type ConsoleCredential = {
  token: string;
  expires: number | null;
  server: string;
  orgID: string | null;
  email: string | null;
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The OpenCode Console sign-in, from OpenCode's own credential list. */
export function consoleCredential(value: unknown): ConsoleCredential | null {
  const entries = z.object({ data: z.array(z.unknown()) }).safeParse(value);
  if (!entries.success) return null;
  for (const entry of entries.data.data) {
    const parsed = consoleCredentialSchema.safeParse(entry);
    if (!parsed.success) continue;
    const credential = parsed.data.value;
    const metadata = credential.metadata ?? {};
    return {
      token: credential.type === "oauth" ? credential.access : credential.key,
      expires:
        credential.type === "oauth" ? (credential.expires ?? null) : null,
      // Credentials saved before August 2026 name the retired host, which
      // OpenCode maps onto the current Console path for path.
      server: (text(metadata.server) ?? CONSOLE_SERVER).replace(
        /^https:\/\/console\.opencode\.ai(?=\/|$)/,
        CONSOLE_SERVER,
      ),
      orgID: text(metadata.orgID),
      email: text(metadata.email),
    };
  }
  return null;
}

const meterSchema = z.object({
  status: z.string(),
  percent: z.number().min(0).max(100),
  resetsAt: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)))
    .nullable()
    .optional(),
});
const usageSchema = z.object({
  usage: z.object({
    rolling: meterSchema,
    weekly: meterSchema,
    monthly: meterSchema,
  }),
});

function account(credential: ConsoleCredential) {
  return {
    accountKey: credential.orgID
      ? `opencode.ai:workspace:${credential.orgID}`
      : null,
    accountEmail: credential.email,
    planLabel: PLAN_LABEL,
    // Go usage does not distinguish Go from Go Plus. Do not guess.
    plan: null,
  };
}

function unavailable(message: string, credential?: ConsoleCredential) {
  return {
    supported: true as const,
    usage: {
      status: "error",
      message,
      ...(credential
        ? account(credential)
        : { accountEmail: null, planLabel: null }),
    },
  };
}

/** Maps the Console's Go meters to BB's provider usage. */
export function mapGoUsage(
  value: unknown,
  credential: ConsoleCredential,
): GoUsageResult {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success)
    return unavailable(
      "OpenCode Console returned an invalid usage response.",
      credential,
    );
  const meters = parsed.data.usage;
  return {
    supported: true,
    usage: {
      status: "ok",
      ...account(credential),
      windows: (
        [
          ["rolling", "five-hour", "Five-hour limit"],
          ["weekly", "weekly", "Weekly limit"],
          ["monthly", "custom", "Monthly limit"],
        ] as const
      ).map(([id, kind, label]) => {
        const meter = meters[id];
        return {
          kind,
          label,
          // Go refuses requests until a rate-limited window resets.
          usedPercent: meter.status === "rate-limited" ? 100 : meter.percent,
          resetsAt: meter.resetsAt
            ? new Date(meter.resetsAt).toISOString()
            : null,
          model: null,
        };
      }),
    },
  };
}

/**
 * Go usage for this machine's OpenCode Console sign-in. The token comes from
 * the configured OpenCode instance and goes only to opencode.ai; it is never
 * logged, stored, or returned.
 */
export async function readGoUsage(options: {
  settings: ModelSettings;
  connection: ConnectionSettings;
  request: (path: string, init: RequestInit) => Promise<unknown>;
  fetch?: typeof fetch;
  now?: number;
}): Promise<GoUsageResult> {
  const { settings, connection } = options;
  if (!settings.providerEnabled || !settings.reportGoUsage)
    return { supported: false };
  // A custom instance's password reaches only the BB server machine; other
  // machines have no OpenCode to ask.
  if (connection.mode === "custom" && !connection.password)
    return { supported: false };
  let credential: ConsoleCredential | null;
  try {
    credential = consoleCredential(
      await options.request("/api/credential", {
        signal: AbortSignal.timeout(30_000),
      }),
    );
  } catch {
    // Never expose an API response body, URL, or credential through the panel.
    return unavailable(
      "Could not read credentials from the configured OpenCode instance.",
    );
  }
  if (!credential)
    return { supported: true, usage: { status: "unauthenticated" } };
  if (credential.server !== CONSOLE_SERVER)
    return unavailable(
      "Only the opencode.ai Console is supported for Go usage.",
      credential,
    );
  if (
    credential.expires !== null &&
    credential.expires <= (options.now ?? Date.now())
  )
    return {
      supported: true,
      usage: { status: "expired", ...account(credential) },
    };
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(GO_USAGE_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential.token}`,
        ...(credential.orgID ? { "x-opencode-org-id": credential.orgID } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return unavailable("Could not reach OpenCode Console.", credential);
  }
  if (response.status === 401) {
    await response.body?.cancel();
    return {
      supported: true,
      usage: { status: "expired", ...account(credential) },
    };
  }
  // The workspace has no Go subscription; BB hides the row.
  if (response.status === 403) {
    await response.body?.cancel();
    return { supported: true, usage: { status: "not_installed" } };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return unavailable(
      `OpenCode Console returned HTTP ${response.status}.`,
      credential,
    );
  }
  return mapGoUsage(await response.json().catch(() => null), credential);
}
