import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../src/server.ts";

test("registers OpenCode v2 as an installed checkpoint-capable provider with every BB permission mode", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    experimental_hostEntry: true,
  });

  await plugin(bb);

  const provider = harness.inspection.registrations.providerRegistrations.find(
    (registration) => registration.id === "opencode2",
  );
  assert.ok(provider);
  assert.equal(provider.displayName, "OpenCode v2");
  assert.equal(provider.experimental_visibility, "installed");
  assert.equal(provider.capabilities.fork, "checkpoint");
  assert.equal(provider.capabilities.supportsManualCompaction, true);
  assert.equal(provider.capabilities.supportsThreadRename, true);
  assert.deepEqual(provider.capabilities.permissionModes, [
    "accept-edits",
    "auto",
    "full",
  ]);
  assert.deepEqual(harness.experimental_hostRpcCalls, []);
  assert.deepEqual(provider.capabilities.reasoningLevels, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
});

test("aborts a pending settings sync when the background service stops", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    experimental_hostEntry: true,
    sdk: {
      hosts: {
        list: async () => [{ id: "host-a", status: "connected" }],
      },
    },
    experimental_callHostRpc: async () => new Promise(() => {}),
  });
  await plugin(bb);

  const service = harness.runService("sync-model-settings");
  await new Promise((resolve) => setImmediate(resolve));
  service.controller.abort();
  await Promise.race([
    service.done,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("settings sync did not abort")), 100),
    ),
  ]);
});

test("synchronizes settings when each host connects", async () => {
  let connected = [{ id: "host-a", status: "connected" }];
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    experimental_hostEntry: true,
    sdk: {
      hosts: {
        list: async () => connected,
      },
    },
    experimental_callHostRpc: async () => ({ ok: true }),
  });
  await plugin(bb);

  const firstRun = harness.runService("sync-model-settings");
  await new Promise((resolve) => setImmediate(resolve));
  firstRun.controller.abort();
  await firstRun.done;
  assert.deepEqual(
    harness.experimental_hostRpcCalls
      .filter((call) => call.method === "setModelSettings")
      .map((call) => call.hostId),
    ["host-a"],
  );

  connected = [
    { id: "host-a", status: "connected" },
    { id: "host-b", status: "connected" },
  ];
  const secondRun = harness.runService("sync-model-settings");
  await new Promise((resolve) => setImmediate(resolve));
  secondRun.controller.abort();
  await secondRun.done;
  assert.deepEqual(
    harness.experimental_hostRpcCalls
      .filter((call) => call.method === "setModelSettings")
      .map((call) => call.hostId),
    ["host-a", "host-b"],
  );
});

test("hands a new-thread composer's agent pick to the thread it creates, once", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    experimental_hostEntry: true,
  });
  await plugin(bb);
  const provider = harness.inspection.registrations.providerRegistrations.find(
    (registration) => registration.id === "opencode2",
  );
  const derive = (threadId: string) =>
    provider!.deriveProviderOptions!({
      threadId,
      projectId: "proj_1",
      model: "openai/gpt-5",
      permissionMode: "auto",
      settings: {},
    }) as { agent?: string };
  const create = (id: string, providerId = "opencode2") =>
    harness.emitThreadEvent("thread.created", {
      thread: makeThreadResponse({ id, projectId: "proj_1", providerId }),
    });

  await harness.callRpc("setNewThreadAgent", {
    projectId: "proj_1",
    agent: "orch",
  });
  assert.deepEqual(
    await harness.callRpc("getNewThreadAgent", { projectId: "proj_1" }),
    { agent: "orch" },
  );

  // A thread this plugin never saw created, or another provider's, gets nothing.
  assert.equal(derive("thr_old").agent, undefined);
  await create("thr_other", "claude-code");
  assert.equal(derive("thr_other").agent, undefined);

  await create("thr_new");
  assert.equal(derive("thr_new").agent, "orch");
  assert.equal(derive("thr_new").agent, undefined);
  assert.deepEqual(
    await harness.callRpc("getNewThreadAgent", { projectId: "proj_1" }),
    { agent: null },
  );

  // A thread created without a pick keeps a later pick for the next thread.
  await create("thr_plain");
  assert.equal(derive("thr_plain").agent, undefined);
  await harness.callRpc("setNewThreadAgent", {
    projectId: "proj_1",
    agent: "orch",
  });
  assert.equal(derive("thr_plain").agent, undefined);
  await create("thr_next");
  assert.equal(derive("thr_next").agent, "orch");
});

test("overwrites a stale native agent selection on a thread that took the composer pick", async () => {
  const updates: unknown[] = [];
  let reported = false;
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    experimental_hostEntry: true,
    sdk: {
      threads: {
        // The host has not reported the option yet, then reports `reviewer`
        // with the stale draft choice `plan` still pending.
        timeline: async () => ({
          sessionOptions: reported
            ? [
                {
                  id: "agent",
                  value: "reviewer",
                  pendingValue: updates.length > 0 ? null : "plan",
                },
              ]
            : [],
        }),
        update: async (args: unknown) => {
          updates.push(args);
          return {};
        },
      },
    } as never,
  });
  await plugin(bb);
  const provider = harness.inspection.registrations.providerRegistrations.find(
    (registration) => registration.id === "opencode2",
  );
  await harness.callRpc("setNewThreadAgent", {
    projectId: "proj_1",
    agent: "reviewer",
  });
  await harness.emitThreadEvent("thread.created", {
    thread: makeThreadResponse({
      id: "thr_new",
      projectId: "proj_1",
      providerId: "opencode2",
    }),
  });
  provider!.deriveProviderOptions!({
    threadId: "thr_new",
    projectId: "proj_1",
    model: "openai/gpt-5",
    permissionMode: "auto",
    settings: {},
  });

  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(updates, []);
  reported = true;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(updates, [
    { threadId: "thr_new", sessionOptions: { agent: "reviewer" } },
  ]);
});
