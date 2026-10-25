import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// Wire contract advertised by BB's provider-usage.v1 sources. Keep this local:
// it is a plugin-to-plugin RPC, not the provider bridge's usage response.
const accountKeySchema = z.string().min(1).nullable().default(null);
const planSchema = z
  .object({
    id: z.string().min(1),
    multiplier: z.number().int().positive().nullable(),
  })
  .strict()
  .nullable()
  .default(null);
const accountFields = {
  plan: planSchema,
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
};
const usageSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      ...accountFields,
      windows: z.array(
        z
          .object({
            kind: z.enum(["five-hour", "daily", "weekly", "custom"]),
            id: z.string().min(1),
            label: z.string().min(1),
            usedPercent: z.number().nonnegative(),
            resetsAt: z.string().nullable(),
            model: z.string().nullable(),
            cost: z
              .object({
                usedUsdCents: z.number().nonnegative(),
                limitUsdCents: z.number().positive(),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      ),
    })
    .strict(),
  z.object({ status: z.literal("not_installed"), ...accountFields }).strict(),
  z.object({ status: z.literal("unauthenticated"), ...accountFields }).strict(),
  z.object({ status: z.literal("expired"), ...accountFields }).strict(),
  z
    .object({
      status: z.literal("error"),
      ...accountFields,
      message: z.string(),
    })
    .strict(),
]);

export const usageMeasurementSchema = z
  .object({
    accountKey: accountKeySchema,
    observedAt: z.number().int().nonnegative().nullable(),
    usage: usageSchema,
  })
  .strict();

export const LIST_USAGE_RESOURCES = "provider-usage.v1.listResources";
export const GET_USAGE_RESOURCE = "provider-usage.v1.getResource";
export const usageSourceContract = defineRpcContract({
  [LIST_USAGE_RESOURCES]: {
    input: z.object({}).strict(),
    output: z
      .object({
        label: z.string().min(1).optional(),
        resources: z.array(
          z
            .object({
              accountKey: accountKeySchema,
              id: z.string().min(1),
              providerId: z.string().min(1),
              label: z.string().min(1),
              scope: z.discriminatedUnion("kind", [
                z.object({ kind: z.literal("shared") }).strict(),
                z
                  .object({
                    kind: z.literal("host"),
                    hostId: z.string().min(1),
                    hostName: z.string().min(1),
                  })
                  .strict(),
              ]),
            })
            .strict(),
        ),
      })
      .strict(),
    experimental_description:
      "Lists one OpenCode v2 resource per machine whose provider reports usage. Reads local metadata only; never fetches usage. Machines group their own resources.",
  },
  [GET_USAGE_RESOURCE]: {
    input: z
      .object({ resourceId: z.string().min(1), refresh: z.boolean() })
      .strict(),
    output: usageMeasurementSchema,
    experimental_description:
      "Returns OpenCode Go usage for one machine's OpenCode Console sign-in. A false refresh permits a measurement cached for 60 seconds; true requests a fresh attempt. Collection failures are usage states, not zero usage.",
  },
});

export type UsageMeasurement = z.infer<typeof usageMeasurementSchema>;
