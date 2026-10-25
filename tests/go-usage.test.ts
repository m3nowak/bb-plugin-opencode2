import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { providerUsageResultSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { DEFAULT_CONNECTION_SETTINGS } from "../src/connection-settings.ts";
import {
  consoleCredential,
  GO_USAGE_URL,
  readGoUsage,
} from "../src/host/go-usage.ts";
import { DEFAULT_MODEL_SETTINGS } from "../src/model-settings.ts";
import plugin from "../src/server.ts";
import {
  GET_USAGE_RESOURCE,
  LIST_USAGE_RESOURCES,
  usageMeasurementSchema,
  usageSourceContract,
} from "../src/usage-contract.ts";
import { registerGoUsageSource } from "../src/usage-source.ts";

const TOKEN = "console-access-token";
const SETTINGS = { ...DEFAULT_MODEL_SETTINGS, reportGoUsage: true };

function credentials(overrides: Record<string, unknown> = {}) {
  return {
    data: [
      {
        integrationID: "opencode-go",
        active: true,
        value: { type: "key", key: "go-key" },
      },
      {
        integrationID: "opencode",
        active: false,
        value: { type: "oauth", access: "stale", expires: 0 },
      },
      {
        integrationID: "opencode",
        active: true,
        value: {
          type: "oauth",
          methodID: "device",
          access: TOKEN,
          refresh: "refresh-token",
          expires: 2_000_000_000_000,
          metadata: {
            server: "https://opencode.ai/console",
            email: "member@example.com",
            orgID: "wrk_a",
            orgName: "Personal",
          },
          ...overrides,
        },
      },
    ],
  };
}

function goUsage(percent = 25) {
  const meter = {
    status: "ok",
    percent,
    resetsAt: "2027-01-15T08:00:00.000Z",
  };
  return {
    usage: {
      rolling: meter,
      weekly: { ...meter, percent: 60 },
      monthly: { ...meter, status: "rate-limited", percent: 97 },
    },
  };
}

function fixture(options: {
  credential?: unknown;
  status?: number;
  body?: unknown;
}) {
  const paths: string[] = [];
  const fetches: { url: string; init: RequestInit }[] = [];
  return {
    paths,
    fetches,
    read: (overrides: Partial<Parameters<typeof readGoUsage>[0]> = {}) =>
      readGoUsage({
        settings: SETTINGS,
        connection: DEFAULT_CONNECTION_SETTINGS,
        now: 1_800_000_000_000,
        request: async (path) => {
          paths.push(path);
          if (options.credential instanceof Error) throw options.credential;
          return options.credential ?? credentials();
        },
        fetch: async (url, init) => {
          fetches.push({ url: String(url), init: init! });
          if (options.status === 0) throw new Error(`network ${TOKEN}`);
          return new Response(JSON.stringify(options.body ?? goUsage()), {
            status: options.status ?? 200,
          });
        },
        ...overrides,
      }),
  };
}

test("picks the active Console sign-in and maps the retired Console host", () => {
  assert.deepEqual(consoleCredential(credentials()), {
    token: TOKEN,
    expires: 2_000_000_000_000,
    server: "https://opencode.ai/console",
    orgID: "wrk_a",
    email: "member@example.com",
  });
  assert.equal(
    consoleCredential(
      credentials({ metadata: { server: "https://console.opencode.ai" } }),
    )?.server,
    "https://opencode.ai/console",
  );
  assert.equal(
    consoleCredential({ data: credentials().data.slice(0, 2) }),
    null,
  );
  assert.equal(consoleCredential({}), null);
});

test("sends the Console token only to opencode.ai and maps Go meters to BB windows", async () => {
  const f = fixture({});
  const result = providerUsageResultSchema.parse(await f.read());
  assert.deepEqual(f.paths, ["/api/credential"]);
  assert.equal(f.fetches.length, 1);
  assert.equal(f.fetches[0].url, GO_USAGE_URL);
  assert.equal(f.fetches[0].init.redirect, "error");
  assert.deepEqual(f.fetches[0].init.headers, {
    accept: "application/json",
    authorization: `Bearer ${TOKEN}`,
    "x-opencode-org-id": "wrk_a",
  });
  assert.ok(result.supported);
  assert.equal(result.usage.status, "ok");
  if (result.usage.status !== "ok") return;
  assert.equal(result.usage.accountKey, "opencode.ai:workspace:wrk_a");
  assert.equal(result.usage.accountEmail, "member@example.com");
  assert.equal(result.usage.planLabel, "OpenCode Go");
  assert.equal(result.usage.plan, null);
  assert.deepEqual(
    result.usage.windows.map((window) => [
      window.kind,
      window.label,
      window.usedPercent,
      window.resetsAt,
    ]),
    [
      ["five-hour", "Five-hour limit", 25, "2027-01-15T08:00:00.000Z"],
      ["weekly", "Weekly limit", 60, "2027-01-15T08:00:00.000Z"],
      // Rate-limited means Go refuses requests until the reset.
      ["custom", "Monthly limit", 100, "2027-01-15T08:00:00.000Z"],
    ],
  );
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test("opt-in, disabled provider and password-less custom hosts report unsupported without requests", async () => {
  const f = fixture({});
  for (const overrides of [
    { settings: DEFAULT_MODEL_SETTINGS },
    { settings: { ...SETTINGS, providerEnabled: false } },
    {
      connection: {
        ...DEFAULT_CONNECTION_SETTINGS,
        mode: "custom" as const,
        password: "",
      },
    },
  ])
    assert.deepEqual(await f.read(overrides), { supported: false });
  assert.equal(f.paths.length, 0);
  assert.equal(f.fetches.length, 0);
});

test("maps sign-in, expiry, subscription and failure states without leaking secrets", async () => {
  const status = async (
    options: Parameters<typeof fixture>[0],
    expected: string,
    fetched = true,
  ) => {
    const f = fixture(options);
    const result = await f.read();
    assert.ok(result.supported);
    assert.equal(result.usage.status, expected, JSON.stringify(options));
    assert.equal(f.fetches.length, fetched ? 1 : 0);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.ok(!JSON.stringify(result).includes("private-body"));
    providerUsageResultSchema.parse(result);
  };
  await status({ credential: { data: [] } }, "unauthenticated", false);
  await status(
    { credential: credentials({ expires: 1_700_000_000_000 }) },
    "expired",
    false,
  );
  await status(
    { credential: new Error(`OpenCode API 500: private-body ${TOKEN}`) },
    "error",
    false,
  );
  await status(
    {
      credential: credentials({
        metadata: { server: "https://console.example.com" },
      }),
    },
    "error",
    false,
  );
  await status({ status: 401 }, "expired");
  await status({ status: 403 }, "not_installed");
  await status({ status: 503, body: "private-body" }, "error");
  await status({ status: 0 }, "error");
  await status({ body: { usage: { rolling: {} } } }, "error");
});

function sourceFixture() {
  let enabled = true;
  let hosts = [
    { id: "a", name: "Laptop", status: "connected" },
    { id: "b", name: "Desktop", status: "connected" },
    { id: "c", name: "No OpenCode", status: "connected" },
  ];
  const calls: { hostId: string; refresh: boolean }[] = [];
  let usage: (hostId: string) => Promise<Record<string, unknown>> = async (
    hostId,
  ) => ({
    opencode2: {
      status: "ok",
      accountKey: `opencode.ai:workspace:${hostId === "b" ? "wrk_b" : "wrk_a"}`,
      accountEmail: "member@example.com",
      planLabel: "OpenCode Go",
      plan: null,
      windows: [
        {
          kind: "five-hour",
          label: "Five-hour limit",
          usedPercent: 25,
          resetsAt: "2027-01-15T08:00:00.000Z",
          model: null,
        },
        {
          kind: "bogus",
          label: "Monthly limit",
          usedPercent: 90,
          resetsAt: null,
        },
      ],
    },
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    sdk: {
      hosts: {
        list: async () => hosts,
        get: async ({ hostId }: { hostId: string }) => {
          const host = hosts.find((item) => item.id === hostId);
          if (!host)
            throw Object.assign(new Error("not found"), { status: 404 });
          return host;
        },
      },
      providers: {
        list: async ({ hostId }: { hostId: string }) =>
          hostId === "c"
            ? [
                {
                  id: "codex",
                  pluginId: "provider-codex",
                  displayName: "Codex",
                },
              ]
            : [
                {
                  id: "opencode2",
                  pluginId: "opencode2",
                  displayName: "OpenCode v2",
                },
              ],
      },
      system: {
        usageLimits: async ({
          hostId,
          refresh,
        }: {
          hostId: string;
          refresh: boolean;
        }) => {
          calls.push({ hostId, refresh });
          return usage(hostId);
        },
      },
    } as never,
  });
  const source = registerGoUsageSource(bb, {
    providerId: "opencode2",
    enabled: () => enabled,
  });
  return {
    harness,
    source,
    calls,
    enable: (value: boolean) => {
      enabled = value;
    },
    setUsage: (fn: typeof usage) => {
      usage = fn;
    },
    disconnect: () => {
      hosts = hosts.map((host) => ({ ...host, status: "disconnected" }));
    },
    list: async () =>
      usageSourceContract[LIST_USAGE_RESOURCES].output.parse(
        await harness.callRpc(LIST_USAGE_RESOURCES, {}),
      ),
    get: async (hostId = "a", refresh = false) =>
      usageMeasurementSchema.parse(
        await harness.callRpc(GET_USAGE_RESOURCE, {
          resourceId: JSON.stringify([hostId, "opencode2"]),
          refresh,
        }),
      ),
  };
}

test("lists one host-scoped resource per machine with the provider, like BB's own providers", async () => {
  const f = sourceFixture();
  const listed = await f.list();
  assert.equal(listed.label, undefined);
  assert.deepEqual(listed.resources, [
    {
      id: JSON.stringify(["a", "opencode2"]),
      accountKey: null,
      providerId: "opencode2",
      label: "OpenCode v2",
      scope: { kind: "host", hostId: "a", hostName: "Laptop" },
    },
    {
      id: JSON.stringify(["b", "opencode2"]),
      accountKey: null,
      providerId: "opencode2",
      label: "OpenCode v2",
      scope: { kind: "host", hostId: "b", hostName: "Desktop" },
    },
  ]);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(
    f.harness.inspection.registrations.experimental_publishedRpcMethods.map(
      (method) => method.method,
    ),
    [LIST_USAGE_RESOURCES, GET_USAGE_RESOURCE],
  );
  await f.get("a");
  assert.equal(
    (await f.list()).resources[0].accountKey,
    "opencode.ai:workspace:wrk_a",
  );
  f.enable(false);
  assert.deepEqual(await f.list(), { resources: [] });
});

test("adapts BB's provider usage and caches successful reads for 60 seconds", async (t) => {
  const f = sourceFixture();
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const result = await f.get();
  assert.equal(result.observedAt, now);
  assert.equal(result.usage.status, "ok");
  if (result.usage.status !== "ok") return;
  assert.equal(result.usage.accountEmail, "member@example.com");
  assert.deepEqual(
    result.usage.windows.map((window) => [window.id, window.kind, window.cost]),
    [
      ["0:Five-hour limit", "five-hour", null],
      ["1:Monthly limit", "custom", null],
    ],
  );
  await f.get();
  assert.equal(f.calls.length, 1);
  await f.get("a", true);
  assert.deepEqual(f.calls[1], { hostId: "a", refresh: true });
  t.mock.method(Date, "now", () => now + 60_001);
  await f.get();
  assert.equal(f.calls.length, 3);
});

test("unsupported machines are hidden, and failures are states rather than zero usage", async () => {
  const f = sourceFixture();
  f.setUsage(async () => ({}));
  assert.equal((await f.get()).usage.status, "not_installed");
  f.setUsage(async () => ({
    opencode2: { status: "expired", accountKey: "opencode.ai:workspace:wrk_a" },
  }));
  const expired = await f.get("a", true);
  assert.equal(expired.usage.status, "expired");
  assert.equal(expired.accountKey, "opencode.ai:workspace:wrk_a");
  f.setUsage(async () => {
    throw new Error("private detail");
  });
  const failed = await f.get("a", true);
  assert.equal(failed.usage.status, "error");
  assert.ok(!JSON.stringify(failed).includes("private detail"));
  f.disconnect();
  assert.match(
    JSON.stringify(await f.get("a", true)),
    /Machine is disconnected/,
  );
});

test("invented and foreign resources never reach a provider", async () => {
  const f = sourceFixture();
  for (const resourceId of [
    "a",
    JSON.stringify(["a", "codex"]),
    JSON.stringify(["missing", "opencode2"]),
    JSON.stringify(["c", "opencode2"]),
  ])
    await assert.rejects(
      f.harness.callRpc(GET_USAGE_RESOURCE, { resourceId, refresh: true }),
      /no longer exists/,
    );
  f.enable(false);
  await assert.rejects(f.get(), /no longer exists/);
  assert.equal(f.calls.length, 0);
});

test("disabling during a read drops late data, and concurrent reads coalesce", async () => {
  const f = sourceFixture();
  let resolve!: (value: Record<string, unknown>) => void;
  f.setUsage(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = f.get();
  const second = f.get();
  await new Promise((done) => setImmediate(done));
  assert.equal(f.calls.length, 1);
  f.enable(false);
  f.source.clear();
  f.enable(true);
  const rejected = Promise.all([
    assert.rejects(first, /configuration changed/),
    assert.rejects(second, /configuration changed/),
  ]);
  resolve({ opencode2: { status: "unauthenticated" } });
  await rejected;
  assert.equal((await f.list()).resources[0].accountKey, null);
});

test("plugin reports usage through BB's provider maintenance and stays opt-in", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    experimental_hostEntry: true,
    sdk: {
      hosts: {
        list: async () => [{ id: "a", name: "Laptop", status: "connected" }],
      },
      providers: {
        list: async () => [
          {
            id: "opencode2",
            pluginId: "opencode2",
            displayName: "OpenCode v2",
          },
        ],
      },
    } as never,
    experimental_callHostRpc: async () => ({ ok: true }),
  });
  await plugin(bb);
  const provider = harness.inspection.registrations.providerRegistrations.find(
    (registration) => registration.id === "opencode2",
  );
  assert.equal(provider?.maintenance?.usage, true);
  assert.deepEqual(await harness.callRpc(LIST_USAGE_RESOURCES, {}), {
    resources: [],
  });
  await harness.callRpc("saveSettings", SETTINGS);
  assert.deepEqual(
    usageSourceContract[LIST_USAGE_RESOURCES].output
      .parse(await harness.callRpc(LIST_USAGE_RESOURCES, {}))
      .resources.map((resource) => resource.scope),
    [{ kind: "host", hostId: "a", hostName: "Laptop" }],
  );
  await harness.callRpc("saveSettings", DEFAULT_MODEL_SETTINGS);
  assert.deepEqual(await harness.callRpc(LIST_USAGE_RESOURCES, {}), {
    resources: [],
  });
});
