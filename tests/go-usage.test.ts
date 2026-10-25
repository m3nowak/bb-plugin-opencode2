import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { GoUsageReader, mapGoUsage } from "../src/host/go-usage.ts";
import { DEFAULT_MODEL_SETTINGS } from "../src/model-settings.ts";
import plugin from "../src/server.ts";
import {
  GET_USAGE_RESOURCE,
  LIST_USAGE_RESOURCES,
  unavailableGoUsage,
  usageMeasurementSchema,
  usageSourceContract,
  type GoUsageSnapshot,
} from "../src/usage-contract.ts";
import { registerGoUsageSource } from "../src/usage-source.ts";

function limits(workspace = "ws-a", percent = 25) {
  const meter = { percent, limited: false, resetsAt: 1_800_000_000_000 };
  return {
    location: { directory: "/home/example" },
    data: {
      workspace: {
        id: workspace,
        name: "Personal",
        usageURL: "https://opencode.ai/console",
      },
      go: {
        rolling: meter,
        weekly: { ...meter, percent: 60 },
        monthly: { ...meter, percent: 90 },
      },
      budgets: [{ limit: 100, spent: 10 }],
    },
  };
}

test("maps the published Go meters without inferring budget, balance, or plan tier", () => {
  const result = mapGoUsage(limits(), 1234);
  const measurement = usageMeasurementSchema.parse(result.measurement);
  assert.equal(measurement.accountKey, "opencode.ai:workspace:ws-a");
  assert.equal(measurement.observedAt, 1234);
  assert.equal(measurement.usage.status, "ok");
  if (measurement.usage.status !== "ok") return;
  assert.equal(measurement.usage.plan, null);
  assert.deepEqual(
    measurement.usage.windows.map((window) => [
      window.id,
      window.kind,
      window.usedPercent,
    ]),
    [
      ["rolling", "five-hour", 25],
      ["weekly", "weekly", 60],
      ["monthly", "custom", 90],
    ],
  );
  assert.ok(
    measurement.usage.windows.every(
      (window) =>
        window.resetsAt === "2027-01-15T08:00:00.000Z" && window.cost === null,
    ),
  );
});

test("no login, no subscription and invalid data never become zero usage", () => {
  assert.equal(
    mapGoUsage({ data: null }).measurement.usage.status,
    "unauthenticated",
  );
  const noGo = limits();
  const noSubscription = mapGoUsage({
    data: { workspace: noGo.data.workspace, budgets: noGo.data.budgets },
  });
  assert.equal(noSubscription.measurement.usage.status, "error");
  assert.equal(
    noSubscription.measurement.accountKey,
    "opencode.ai:workspace:ws-a",
  );
  for (const value of [
    {},
    { data: {} },
    limits("ws-a", -1),
    limits("ws-a", 101),
    {
      data: {
        ...noGo.data,
        go: {
          ...noGo.data.go,
          rolling: { percent: 10, limited: false, resetsAt: 1e20 },
        },
      },
    },
  ]) {
    const result = mapGoUsage(value).measurement;
    assert.equal(result.usage.status, "error");
    assert.equal(result.observedAt, null);
    assert.ok(!("windows" in result.usage));
  }
});

test("reader uses only the configured OpenCode API and sanitizes errors", async () => {
  const reader = new GoUsageReader();
  const good = await reader.read(async (path, init) => {
    assert.equal(path, "/api/experimental/usage/limits");
    assert.ok(init.signal);
    assert.equal(init.headers, undefined);
    return limits();
  });
  assert.equal(good.measurement.usage.status, "ok");
  for (const message of [
    "OpenCode API 404: secret-body",
    "OpenCode API 503: secret-body",
    "secret-body",
  ]) {
    const result = await reader.read(async () => {
      throw new Error(message);
    });
    assert.equal(result.measurement.usage.status, "error");
    assert.ok(!JSON.stringify(result).includes("secret-body"));
    if (message.includes("404"))
      assert.match(JSON.stringify(result), /Update OpenCode/);
  }
});

test("clearing the reader aborts in-flight work and rejects late successful data", async () => {
  const reader = new GoUsageReader();
  let resolve!: (value: unknown) => void;
  let signal!: AbortSignal;
  const request = reader.read(async (_path, init) => {
    signal = init.signal!;
    return new Promise((done) => {
      resolve = done;
    });
  });
  reader.clear();
  assert.equal(signal.aborted, true);
  resolve(limits());
  assert.equal((await request).measurement.usage.status, "error");
  assert.equal(
    (await reader.read(async () => limits())).measurement.usage.status,
    "ok",
  );
});

function sourceFixture() {
  let enabled = true;
  let hosts = [
    { id: "a", name: "Laptop", status: "connected" },
    { id: "b", name: "Desktop", status: "connected" },
    { id: "c", name: "Other", status: "connected" },
    { id: "offline", name: "Offline", status: "disconnected" },
  ];
  let loads = 0;
  let load: (
    hostId: string,
    signal: AbortSignal,
  ) => Promise<GoUsageSnapshot> = async (hostId) => {
    loads++;
    return mapGoUsage(limits(hostId === "c" ? "ws-b" : "ws-a"));
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    sdk: { hosts: { list: async () => hosts } },
  });
  const source = registerGoUsageSource(bb, {
    enabled: () => enabled,
    load: (id, signal) => load(id, signal),
  });
  return {
    harness,
    source,
    loads: () => loads,
    enable: (value: boolean) => {
      enabled = value;
    },
    setLoad: (fn: typeof load) => {
      load = fn;
    },
    disconnect: () => {
      hosts = hosts.map((host) => ({ ...host, status: "disconnected" }));
    },
    list: async () =>
      usageSourceContract[LIST_USAGE_RESOURCES].output.parse(
        await harness.callRpc(LIST_USAGE_RESOURCES, {}),
      ),
    get: async (id = "a", refresh = false) =>
      usageMeasurementSchema.parse(
        await harness.callRpc(GET_USAGE_RESOURCE, { resourceId: id, refresh }),
      ),
  };
}

test("inventory is metadata-only and shared account identities deduplicate across hosts", async () => {
  const f = sourceFixture();
  const initial = await f.list();
  assert.equal(initial.resources.length, 3);
  assert.equal(f.loads(), 0);
  assert.ok(
    initial.resources.every(
      (resource) =>
        resource.accountKey === null && resource.scope.kind === "shared",
    ),
  );
  assert.deepEqual(
    f.harness.inspection.registrations.experimental_publishedRpcMethods.map(
      (method) => method.method,
    ),
    [LIST_USAGE_RESOURCES, GET_USAGE_RESOURCE],
  );
  const measurements = await Promise.all(
    initial.resources.map((resource) => f.get(resource.id)),
  );
  // BB groups by display scope, then selects one resource per provider/accountKey.
  assert.equal(
    new Set(measurements.map((measurement) => measurement.accountKey)).size,
    2,
  );
  const known = await f.list();
  assert.equal(f.loads(), 3);
  assert.equal(known.resources[0].accountKey, known.resources[1].accountKey);
  assert.notEqual(known.resources[0].accountKey, known.resources[2].accountKey);
  assert.equal(known.resources[0].label, known.resources[2].label); // Same name is not identity.
});

test("cache lasts 60 seconds, manual refresh bypasses it, and changed workspaces replace identity", async (t) => {
  const f = sourceFixture();
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  await f.get();
  await f.get();
  assert.equal(f.loads(), 1);
  await f.get("a", true);
  assert.equal(f.loads(), 2);
  t.mock.method(Date, "now", () => now + 60_001);
  await f.get();
  assert.equal(f.loads(), 3);
  f.setLoad(async () => mapGoUsage(limits("new-workspace")));
  const changed = await f.get("a", true);
  assert.equal(changed.accountKey, "opencode.ai:workspace:new-workspace");
  assert.equal((await f.list()).resources[0].accountKey, changed.accountKey);
});

test("failed refresh reports a status, not stale percentages, and unknown accounts stay separate", async () => {
  const f = sourceFixture();
  await f.get();
  f.setLoad(async () => {
    throw new Error("private detail");
  });
  const result = await f.get("a", true);
  assert.equal(result.usage.status, "error");
  assert.equal(result.observedAt, null);
  assert.ok(!("windows" in result.usage));
  assert.ok(!JSON.stringify(result).includes("private detail"));
  assert.equal((await f.list()).resources[0].accountKey, null);
  f.setLoad(async () => unavailableGoUsage("Unavailable"));
  assert.equal((await f.get("b")).accountKey, null);
  assert.equal((await f.list()).resources.length, 3);
});

test("disabling hides inventory, clears cache and prevents late data from returning", async () => {
  const f = sourceFixture();
  await f.get();
  let resolve!: (snapshot: GoUsageSnapshot) => void;
  let started!: () => void;
  let signal!: AbortSignal;
  const ready = new Promise<void>((done) => {
    started = done;
  });
  f.setLoad(async (_hostId, callerSignal) => {
    signal = callerSignal;
    started();
    return new Promise((done) => {
      resolve = done;
    });
  });
  const loading = f.get("a", true);
  await ready;
  f.enable(false);
  f.source.clear();
  assert.equal(signal.aborted, true);
  assert.deepEqual(await f.list(), { resources: [] });
  await assert.rejects(f.get(), /disabled/);
  const rejected = assert.rejects(loading, /configuration changed/);
  resolve(mapGoUsage(limits()));
  await rejected;
  f.enable(true);
  assert.equal((await f.list()).resources[0].accountKey, null);
  f.setLoad(async () => mapGoUsage(limits("new")));
  assert.equal((await f.get()).accountKey, "opencode.ai:workspace:new");
});

test("a queued forced refresh cannot restart collection after disable and re-enable", async () => {
  const f = sourceFixture();
  let resolve!: (snapshot: GoUsageSnapshot) => void;
  let calls = 0;
  f.setLoad(async () => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const loading = f.get();
  const queued = f.get("a", true);
  await new Promise((done) => setImmediate(done));
  f.enable(false);
  f.source.clear();
  f.enable(true);
  const rejected = [
    assert.rejects(loading, /configuration changed/),
    assert.rejects(queued, /configuration changed/),
  ];
  resolve(mapGoUsage(limits()));
  await Promise.all(rejected);
  assert.equal(calls, 1);
  assert.equal((await f.list()).resources[0].accountKey, null);
});

test("host clock skew cannot extend the local cache beyond 60 seconds", async (t) => {
  const f = sourceFixture();
  const now = Date.now();
  let calls = 0;
  f.setLoad(async () => {
    calls++;
    return mapGoUsage(limits(), now + 86_400_000);
  });
  t.mock.method(Date, "now", () => now);
  await f.get();
  await f.get();
  assert.equal(calls, 1);
  t.mock.method(Date, "now", () => now + 60_001);
  await f.get();
  assert.equal(calls, 2);
});

test("concurrent reads coalesce, but a forced refresh waits for a cached attempt then reloads", async () => {
  const f = sourceFixture();
  let resolve!: (snapshot: GoUsageSnapshot) => void;
  let calls = 0;
  f.setLoad(async () => {
    calls++;
    if (calls === 1)
      return new Promise((done) => {
        resolve = done;
      });
    return mapGoUsage(limits("fresh"));
  });
  const first = f.get();
  const second = f.get();
  const forced = f.get("a", true);
  await new Promise((done) => setImmediate(done));
  assert.equal(calls, 1);
  resolve(mapGoUsage(limits("old")));
  assert.deepEqual(await first, await second);
  assert.equal((await forced).accountKey, "opencode.ai:workspace:fresh");
  assert.equal(calls, 2);
});

test("disconnected and invented resources cannot trigger a provider request", async () => {
  const f = sourceFixture();
  await assert.rejects(f.get("invented"), /no longer exists/);
  f.disconnect();
  assert.equal((await f.list()).resources.length, 0);
  await assert.rejects(f.get(), /no longer exists/);
  assert.equal(f.loads(), 0);
});

test("plugin defaults to no collection, syncs opt-in to hosts, and forgets accounts when disabled", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    experimental_hostEntry: true,
    sdk: {
      hosts: {
        list: async () => [{ id: "a", name: "Laptop", status: "connected" }],
      },
    },
    experimental_callHostRpc: async ({ method }) =>
      method === "getGoUsage" ? mapGoUsage(limits()) : { ok: true },
  });
  await plugin(bb);
  assert.deepEqual(await harness.callRpc(LIST_USAGE_RESOURCES, {}), {
    resources: [],
  });
  await assert.rejects(
    harness.callRpc(GET_USAGE_RESOURCE, { resourceId: "a", refresh: true }),
    /disabled/,
  );
  assert.equal(harness.experimental_hostRpcCalls.length, 0);
  await harness.callRpc("saveSettings", {
    ...DEFAULT_MODEL_SETTINGS,
    reportGoUsage: true,
  });
  const result = usageMeasurementSchema.parse(
    await harness.callRpc(GET_USAGE_RESOURCE, {
      resourceId: "a",
      refresh: false,
    }),
  );
  assert.equal(result.usage.status, "ok");
  assert.deepEqual(
    harness.experimental_hostRpcCalls.map((call) => call.method),
    ["configureConnection", "setModelSettings", "getGoUsage"],
  );
  await harness.setSettings({ serverUrl: "http://127.0.0.1:4999" });
  assert.equal(
    usageSourceContract[LIST_USAGE_RESOURCES].output.parse(
      await harness.callRpc(LIST_USAGE_RESOURCES, {}),
    ).resources[0].accountKey,
    null,
  );
  await harness.callRpc("saveSettings", {
    ...DEFAULT_MODEL_SETTINGS,
    reportGoUsage: false,
  });
  assert.deepEqual(await harness.callRpc(LIST_USAGE_RESOURCES, {}), {
    resources: [],
  });
  assert.equal(
    harness.experimental_hostRpcCalls.filter(
      (call) => call.method === "getGoUsage",
    ).length,
    1,
  );
});
