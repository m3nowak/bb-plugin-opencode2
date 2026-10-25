import { z } from "zod";

export const MIN_OPENCODE_VERSION = "2.0.26";
export const DEFAULT_SERVER_URL = "http://127.0.0.1:4095";

/** The bridge uses the execution machine's filesystem and loopback MCP proxy. */
export function connectionUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an HTTP(S) loopback origin without credentials, path, query, or fragment",
    );
  return url.origin;
}

export const serverUrlSchema = z.string().refine((value) => {
  try {
    connectionUrl(value);
    return true;
  } catch {
    return false;
  }
}, "Use a local OpenCode origin, for example http://127.0.0.1:4095");

export const connectionSettingsSchema = z
  .object({
    mode: z.enum(["auto", "custom"]),
    url: serverUrlSchema,
    username: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^:\r\n]+$/),
    password: z.string().max(16_384),
  })
  .strict();

export type ConnectionSettings = z.infer<typeof connectionSettingsSchema>;
export const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings = {
  mode: "auto",
  url: DEFAULT_SERVER_URL,
  username: "opencode",
  password: "",
};

export function connectionIdentity(settings: ConnectionSettings): string {
  return settings.mode === "auto"
    ? "auto"
    : `custom:${connectionUrl(settings.url)}`;
}
