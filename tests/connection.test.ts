import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  connectionUrl,
  DEFAULT_CONNECTION_SETTINGS,
} from "../src/connection-settings.ts";
import plugin from "../src/server.ts";
import { OpenCodeServer, sessions } from "./support/host-api.js";

async function fixture(t: TestContext) {
  const dir = await mkdtemp("/tmp/opencode/bb-connection-");
  const requests: { path: string; authorization?: string }[] = [];
  const reply = {
    status: 200,
    protectedStatus: 200,
    version: "2.0.32",
    redirect: false,
  };
  const http = createServer((request, response) => {
    requests.push({
      path: request.url!,
      authorization: request.headers.authorization,
    });
    if (reply.redirect) {
      response.writeHead(302, { location: "/elsewhere" }).end();
      return;
    }
    response
      .writeHead(
        request.url === "/api/session/active"
          ? reply.protectedStatus
          : reply.status,
        { "content-type": "application/json" },
      )
      .end(
        JSON.stringify({
          version: reply.version,
          pid: 123,
          detail: "example-password",
        }),
      );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const server = new OpenCodeServer();
  server.setDataDir(dir);
  let cliCalls = 0;
  Object.assign(server, {
    cli: async () => {
      cliCalls++;
      throw new Error("Local CLI must not be called");
    },
    consumeEvents: async () => {},
  });
  t.after(async () => {
    await server.stop();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const config = {
    mode: "custom" as const,
    url,
    username: "opencode",
    password: "example-password",
  };
  await server.writeConnectionSettings(config);
  return {
    dir,
    server,
    requests,
    reply,
    url,
    config,
    cliCalls: () => cliCalls,
  };
}

test("validates local origins without credentials, paths, or redirects", () => {
  assert.equal(
    connectionUrl("http://127.0.0.1:4095/"),
    "http://127.0.0.1:4095",
  );
  assert.equal(
    connectionUrl("https://localhost:4095"),
    "https://localhost:4095",
  );
  for (const url of [
    "https://example.com",
    "http://user:password@localhost",
    "http://localhost/base",
    "http://localhost?password=x",
    "file:///tmp/x",
  ])
    assert.throws(() => connectionUrl(url));
});

test("custom connection uses Basic authentication and never starts or pairs a local service", async (t) => {
  const f = await fixture(t);
  const previous = process.env.OPENCODE_SERVER_PASSWORD;
  process.env.OPENCODE_SERVER_PASSWORD = "unrelated-auto-password";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = previous;
  });
  const info = await f.server.request("/api/info");
  assert.equal(info.pid, 123);
  assert.equal(f.cliCalls(), 0);
  assert.equal(await f.server.configuredServerVersion(), "2.0.32");
  assert.equal(f.server.connectionId(), `custom:${f.url}`);
  assert.ok(
    f.requests.every(
      (request) =>
        request.authorization ===
        `Basic ${Buffer.from("opencode:example-password").toString("base64")}`,
    ),
  );
  assert.deepEqual(await f.server.connectionStatus(), {
    connectionMode: "custom",
    serverUrl: f.url,
  });
});

test("serializes concurrent connection attempts", async (t) => {
  const f = await fixture(t);
  await Promise.all([f.server.start(), f.server.start(), f.server.start()]);
  assert.equal(f.requests.length, 2);
  assert.equal(f.cliCalls(), 0);
});

test("stores a private host copy with mode 0600, separate from ordinary model settings", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await stat(join(f.dir, "opencode2-connection-secret.json"))).mode & 0o777,
    0o600,
  );
  await f.server.writeModelSettings({
    providerEnabled: true,
    enabledModels: null,
    disableSubagents: true,
    hideBbToolsOutsideBb: true,
    reportGoUsage: false,
  });
  assert.ok(
    !(
      await readFile(join(f.dir, "opencode2-model-settings.json"), "utf8")
    ).includes(f.config.password),
  );
  assert.deepEqual(await f.server.readConnectionSettings(), f.config);
});

test("rejects missing credentials without falling back to automatic discovery", async (t) => {
  const f = await fixture(t);
  await f.server.writeConnectionSettings({ ...f.config, password: "" });
  await assert.rejects(f.server.start(), /requires a password/);
  assert.equal(f.cliCalls(), 0);
  assert.equal(f.requests.length, 0);
});

test("authentication errors do not include the password or response body", async (t) => {
  const f = await fixture(t);
  f.reply.status = 401;
  await assert.rejects(f.server.start(), (error: Error) => {
    assert.match(error.message, /rejected authentication/);
    assert.ok(!error.message.includes(f.config.password));
    return true;
  });
  assert.equal(f.cliCalls(), 0);
});

test("rejects incompatible servers and does not follow credential-bearing redirects", async (t) => {
  const f = await fixture(t);
  f.reply.version = "1.2.0";
  await assert.rejects(f.server.start(), /must run OpenCode v2/);
  f.reply.redirect = true;
  await assert.rejects(f.server.start(), /Cannot connect/);
  assert.equal(
    f.requests.some((request) => request.path === "/elsewhere"),
    false,
  );
  assert.equal(f.cliCalls(), 0);
});

test("does not expose malformed private configuration in parser errors", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.dir, "opencode2-connection-secret.json"),
    '{"password":"example-password"',
  );
  await assert.rejects(f.server.readConnectionSettings(), (error: Error) => {
    assert.ok(!error.message.includes(f.config.password));
    assert.match(error.message, /Invalid private/);
    return true;
  });
});

test("pins existing threads to their original connection across worker reloads", async (t) => {
  const f = await fixture(t);
  await f.server.rememberSessionRegistration("old-bb-thread", {
    providerThreadId: "old-session",
    cwd: "/repo",
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  });
  await assert.rejects(
    f.server.assertSessionConnection("old-bb-thread", "old-session"),
    /different OpenCode connection/,
  );
  await assert.rejects(
    f.server.assertSessionConnection("new-fork-thread", "old-session"),
    /different OpenCode connection/,
  );
  await f.server.rememberSessionRegistration("new-bb-thread", {
    providerThreadId: "new-session",
    cwd: "/repo",
    connectionId: `custom:${f.url}`,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  });
  await f.server.assertSessionConnection("new-bb-thread", "new-session");
});

test("does not change an active turn's connection and requires reload for idle sessions", async (t) => {
  const f = await fixture(t);
  await f.server.start();
  sessions.set("test-switch", { active: {} } as never);
  t.after(() => sessions.delete("test-switch"));
  await f.server.writeConnectionSettings(DEFAULT_CONNECTION_SETTINGS);
  await f.server.start();
  assert.equal(f.server.connectionId(), `custom:${f.url}`);
  sessions.set("test-switch", {} as never);
  await assert.rejects(f.server.start(), /Reload the plugin/);
  assert.equal(f.cliCalls(), 0);
});

test("keeps session teardown on the original server after connection settings change", async (t) => {
  const f = await fixture(t);
  await f.server.start();
  await f.server.rememberSessionRegistration("teardown-thread", {
    providerThreadId: "teardown-session",
    cwd: "/repo",
    connectionId: f.server.connectionId(),
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  });
  // shutdownSessions clears the live session map before removing its MCP proxy.
  await f.server.writeConnectionSettings(DEFAULT_CONNECTION_SETTINGS);
  await f.server.request("/api/info");
  assert.equal(f.server.connectionId(), `custom:${f.url}`);
  assert.equal(f.cliCalls(), 0);
});

test("declares a BB secret and keeps it out of frontend RPC and provider options", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    experimental_hostEntry: true,
    settings: { connectionMode: "custom", serverPassword: "example-password" },
  });
  await plugin(bb);
  assert.equal(
    "secret" in
      harness.inspection.registrations.settingsDescriptors.serverPassword &&
      harness.inspection.registrations.settingsDescriptors.serverPassword
        .secret,
    true,
  );
  assert.ok(
    !JSON.stringify(await harness.callRpc("getSettings", null)).includes(
      "example-password",
    ),
  );
  const provider = harness.inspection.registrations.providerRegistrations[0];
  const options = provider.deriveProviderOptions!({
    threadId: "thread",
    projectId: "project",
    model: "openai/test",
    permissionMode: "auto",
    settings: {},
  });
  assert.ok(!JSON.stringify(options).includes("example-password"));
  const manual = provider.deriveProviderOptions!({
    threadId: "thread",
    projectId: "project",
    model: "openai/test",
    permissionMode: "auto",
    settings: { connectionMode: "custom", serverUrl: "http://127.0.0.1:4095" },
  });
  assert.equal(manual?.connectionId, "custom:http://127.0.0.1:4095");
  assert.ok(!JSON.stringify(manual).includes("example-password"));
});

test("syncs manual credentials only to the BB server machine", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    experimental_hostEntry: true,
    settings: { connectionMode: "custom", serverPassword: "example-password" },
    sdk: {
      hosts: {
        list: async () => [
          { id: "local", status: "connected", machineProviderId: null },
          { id: "remote", status: "connected", machineProviderId: "manual" },
        ],
      },
    },
    experimental_callHostRpc: async () => ({ ok: true }),
  });
  await plugin(bb);
  const service = harness.runService("sync-model-settings");
  await new Promise((resolve) => setImmediate(resolve));
  service.controller.abort();
  await service.done;
  const calls = harness.experimental_hostRpcCalls.filter(
    (call) => call.method === "configureConnection",
  );
  assert.equal(calls.length, 2);
  assert.equal(
    (
      calls.find((call) => call.hostId === "local")!.input as Record<
        string,
        unknown
      >
    ).password,
    "example-password",
  );
  assert.equal(
    (
      calls.find((call) => call.hostId === "remote")!.input as Record<
        string,
        unknown
      >
    ).password,
    "",
  );
  assert.ok(
    calls.every(
      (call) => (call.input as Record<string, unknown>).mode === "custom",
    ),
  );
});

test("rejects an unsynced manual command before any automatic service start", async (t) => {
  const f = await fixture(t);
  await rm(join(f.dir, "opencode2-connection-secret.json"));
  await assert.rejects(
    f.server.assertConfiguredConnection(`custom:${f.url}`),
    /no automatic fallback/,
  );
  assert.equal(f.cliCalls(), 0);
  assert.equal(f.requests.length, 0);
});

test("allows steering an active turn on its pinned connection after settings edits", async (t) => {
  const f = await fixture(t);
  await f.server.start();
  sessions.set("steer-old-connection", { active: {} } as never);
  t.after(() => sessions.delete("steer-old-connection"));
  await f.server.writeConnectionSettings(DEFAULT_CONNECTION_SETTINGS);
  await f.server.assertConfiguredConnection("auto", "steer-old-connection");
  assert.equal(f.server.connectionId(), `custom:${f.url}`);
  assert.equal(f.cliCalls(), 0);
});

test("verifies a protected route even if server info is public", async (t) => {
  const f = await fixture(t);
  f.reply.protectedStatus = 401;
  await assert.rejects(f.server.start(), /rejected authentication/);
  assert.equal(f.requests.length, 2);
  assert.equal(f.cliCalls(), 0);
});
