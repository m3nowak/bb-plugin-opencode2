import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenCodeEventRouter,
  OpenCodeServer,
  sessions,
} from "./support/host-api.js";
import type {
  ActiveTurn,
  OpenCodeRecord,
  SessionState,
} from "../src/host/types.ts";

function fixture() {
  const active: ActiveTurn = {
    providerTurnId: "turn-1",
    startedAt: Date.now() - 60_000,
    promptDelivered: true,
    promptIds: new Set(["prompt-1"]),
    inputDelivered: true,
    abortController: new AbortController(),
    opened: new Map(),
    pendingTools: new Map(),
    pendingInput: new Map(),
    touchedFiles: new Map(),
    openQuestions: new Map(),
    settledTools: new Set(),
  };
  const session: SessionState = {
    bbThreadId: "bb-background-test",
    providerThreadId: "oc-parent",
    cwd: process.cwd(),
    disableSubagents: false,
    dynamicTools: [],
    disallowedTools: new Set(),
    enabledModels: null,
    instructions: "",
    bridgeEnvVars: {},
    dynamicToolScope: {},
    active,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const emitted: OpenCodeRecord[] = [];
  const replies = new Map<string, OpenCodeRecord>();
  const request = async (path: string) => {
    const reply = replies.get(path);
    if (reply) return reply;
    if (path === "/api/session/active") return { data: {} };
    if (path === "/api/session/oc-parent")
      return {
        data: { outcome: "succeeded", time: { idle: Date.now() - 20_000 } },
      };
    return replies.get(path) ?? { data: [] };
  };
  const router = new OpenCodeEventRouter(
    request,
    (_threadId, deltas) => emitted.push(...deltas),
    new Map([[session.providerThreadId, session]]),
  );
  const event = (
    type: string,
    data: OpenCodeRecord = {},
    sessionID = "oc-parent",
  ) => router.handleEvent({ type, data: { sessionID, ...data } });
  const call = async (id: string, name: string, input: OpenCodeRecord = {}) => {
    await event("session.tool.input.started", { id, name });
    await event("session.tool.called", { id, input });
  };
  const success = (id: string, metadata: OpenCodeRecord) =>
    event("session.tool.success", {
      id,
      metadata,
      content: [{ type: "text", text: "Working in the background" }],
    });
  const notification = (source: string, id: string, state = "completed") => ({
    type: "synthetic",
    payload: {
      text: "Background result",
      metadata: {
        source,
        ...(source === "shell" ? { shellID: id, exit: 0 } : { childID: id }),
        state,
      },
    },
    delivery: "steer",
  });
  const boundaries = () =>
    emitted.filter((delta) => delta.kind === "turn.boundary");
  return {
    active,
    session,
    emitted,
    replies,
    request,
    router,
    event,
    call,
    success,
    notification,
    boundaries,
  };
}

test("keeps a background shell and its resumed response in one running BB turn", async () => {
  const f = fixture();
  await f.call("call-shell", "shell", { command: "test", background: true });
  await f.success("call-shell", { shellID: "shell-1", status: "running" });
  assert.ok(
    f.active.opened.has("call-shell"),
    "background success is not command completion",
  );
  await f.event("session.execution.succeeded");
  assert.equal(f.session.active, f.active);
  assert.equal(f.active.abortController.signal.aborted, false);
  assert.equal(f.boundaries().length, 0);

  await f.event("session.inbox.enqueued", {
    inboxID: "notification-1",
    item: f.notification("shell", "shell-1"),
  });
  assert.equal(f.active.opened.has("call-shell"), false);
  // Notification admission alone does not mean the parent has processed it.
  await f.event("session.execution.succeeded");
  assert.equal(f.session.active, f.active);
  await f.event("session.execution.started");
  await f.event("session.inbox.delivered", { inboxID: "notification-1" });
  await f.event("session.text.started", {
    assistantMessageID: "resumed",
    ordinal: 0,
  });
  await f.event("session.text.ended", {
    assistantMessageID: "resumed",
    ordinal: 0,
    text: "Done",
  });
  await f.event("session.execution.succeeded");
  assert.equal(f.session.active, undefined);
  assert.equal(f.boundaries().length, 1);
  assert.ok(
    f.emitted.some((delta) => delta.key?.providerItemId === "text:resumed:0"),
  );
});

test("retains background subagent routing while its parent is idle", async () => {
  const f = fixture();
  await f.call("call-agent", "subagent", {
    agent: "explore",
    background: true,
  });
  await f.event("session.tool.progress", {
    id: "call-agent",
    metadata: { sessionID: "oc-child", status: "running" },
  });
  await f.success("call-agent", { sessionID: "oc-child", status: "running" });
  await f.event("session.execution.succeeded");
  await f.event(
    "session.text.started",
    { assistantMessageID: "child-report", ordinal: 0 },
    "oc-child",
  );
  assert.equal(f.session.active, f.active);
  assert.ok(f.emitted.some((delta) => delta.key?.parentRef === "call-agent"));
  await f.event("session.inbox.enqueued", {
    inboxID: "child-notification",
    item: f.notification("subagent", "oc-child"),
  });
  const close = f.emitted.find(
    (delta) =>
      delta.kind === "item.close" && delta.key?.providerItemId === "call-agent",
  );
  assert.equal(close?.item.background, true);
  assert.equal(close?.item.summary, "Background result");
  await f.event("session.execution.started");
  await f.event("session.inbox.delivered", { inboxID: "child-notification" });
  await f.event("session.execution.succeeded");
  assert.equal(f.boundaries().length, 1);
});

test("a parent's success does not end a still-running child execution", async () => {
  const f = fixture();
  await f.call("call-agent", "subagent", {
    agent: "explore",
    background: true,
  });
  await f.success("call-agent", { sessionID: "oc-child", status: "running" });
  await f.event("session.inbox.enqueued", {
    inboxID: "agent-result",
    item: f.notification("subagent", "oc-child"),
  });
  await f.event("session.inbox.delivered", { inboxID: "agent-result" });
  await f.event("session.execution.started", {}, "oc-child");
  await f.event("session.execution.succeeded");
  assert.equal(f.session.active, f.active);
  await f.event("session.execution.succeeded", {}, "oc-child");
  assert.equal(f.session.active, f.active);
  await f.event("session.execution.succeeded");
  assert.equal(f.session.active, undefined);
});

test("handles a fast background notification arriving before tool.success", async () => {
  const f = fixture();
  await f.call("call-shell", "shell", { command: "test", background: true });
  await f.event("session.inbox.enqueued", {
    inboxID: "fast",
    item: f.notification("shell", "shell-fast"),
  });
  await f.event("session.inbox.delivered", { inboxID: "fast" });
  await f.success("call-shell", { shellID: "shell-fast", status: "running" });
  await f.event("session.execution.succeeded");
  assert.equal(f.session.active, undefined);
  const closes = f.emitted.filter(
    (delta) =>
      delta.kind === "item.close" && delta.key?.providerItemId === "call-shell",
  );
  assert.equal(closes.length, 1);
  assert.equal(closes[0].item.aggregatedOutput, "Background result");
});

test("waits for every background task, including failed task notifications", async () => {
  const f = fixture();
  for (const id of ["one", "two"]) {
    await f.call(id, "shell", { command: id, background: true });
    await f.success(id, { shellID: id, status: "running" });
  }
  await f.event("session.execution.succeeded");
  await f.event("session.inbox.enqueued", {
    inboxID: "first",
    item: f.notification("shell", "one", "error"),
  });
  await f.event("session.inbox.delivered", { inboxID: "first" });
  await f.event("session.execution.succeeded");
  assert.equal(f.session.active, f.active);
  assert.equal(f.boundaries().length, 0);
  assert.ok(
    f.emitted.some(
      (delta) =>
        delta.kind === "item.close" &&
        delta.key?.providerItemId === "one" &&
        delta.status === "failed",
    ),
  );
  f.router.finish(f.session, "interrupted");
});

for (const status of ["interrupted", "failed"] as const) {
  test(`does not keep a ${status} turn alive because of background work`, async () => {
    const f = fixture();
    await f.call("call-shell", "shell", { command: "test", background: true });
    await f.success("call-shell", { shellID: "shell-1", status: "running" });
    await f.event(`session.execution.${status}`, {
      error: { message: "Stopped" },
    });
    assert.equal(f.session.active, undefined);
    assert.equal(f.active.abortController.signal.aborted, true);
    assert.equal(f.boundaries().length, 1);
  });
}

test("watchdog preserves a pending background turn and recovers a missed completion", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() - 30_000 });
  const f = fixture();
  const server = new OpenCodeServer();
  Object.assign(server, { request: f.request, eventRouter: f.router });
  await f.call("call-shell", "shell", { command: "test", background: true });
  await f.success("call-shell", { shellID: "shell-1", status: "running" });
  t.mock.timers.tick(30_000);
  sessions.set(f.session.bbThreadId, f.session);
  try {
    await server.reconcileActiveTurns();
    assert.equal(
      f.session.active,
      f.active,
      "idle parent does not mean background work finished",
    );
    f.replies.set("/api/session/oc-parent/message?limit=100&order=desc", {
      data: [
        {
          id: "missed-notification",
          ...f.notification("shell", "shell-1").payload,
          type: "synthetic",
          time: { created: Date.now() - 25_000 },
        },
      ],
    });
    await server.reconcileActiveTurns();
    assert.equal(f.session.active, undefined);
    assert.equal(f.boundaries().length, 1);
    assert.ok(
      f.emitted.some(
        (delta) =>
          delta.kind === "item.close" &&
          delta.item.aggregatedOutput === "Background result",
      ),
    );
  } finally {
    sessions.delete(f.session.bbThreadId);
  }
});

test("does not wait for unrelated user-shell notifications", async () => {
  const f = fixture();
  await f.event("session.inbox.enqueued", {
    inboxID: "unrelated",
    item: f.notification("shell", "not-an-agent-tool"),
  });
  await f.event("session.execution.succeeded");
  assert.equal(f.session.active, undefined);
});

test("watchdog waits until a queued background result is actually delivered", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() - 30_000 });
  const f = fixture();
  const server = new OpenCodeServer();
  Object.assign(server, { request: f.request, eventRouter: f.router });
  await f.call("call-shell", "shell", { command: "test", background: true });
  await f.success("call-shell", { shellID: "shell-1", status: "running" });
  t.mock.timers.tick(30_000);
  const entry = {
    id: "queued",
    ...f.notification("shell", "shell-1"),
    time: { created: Date.now() - 25_000 },
  };
  f.replies.set("/api/session/oc-parent/inbox", { data: [entry] });
  sessions.set(f.session.bbThreadId, f.session);
  try {
    await server.reconcileActiveTurns();
    assert.equal(f.session.active, f.active);
    assert.equal(f.active.opened.has("call-shell"), false);
    f.replies.set("/api/session/oc-parent/inbox", { data: [] });
    f.replies.set("/api/session/oc-parent/message?limit=100&order=desc", {
      data: [
        { ...entry.payload, id: entry.id, type: "synthetic", time: entry.time },
      ],
    });
    await server.reconcileActiveTurns();
    assert.equal(f.session.active, undefined);
  } finally {
    sessions.delete(f.session.bbThreadId);
  }
});

test("watchdog recovers a missed background tool return before its notification", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() - 30_000 });
  const f = fixture();
  const server = new OpenCodeServer();
  Object.assign(server, { request: f.request, eventRouter: f.router });
  await f.call("call-shell", "shell", { command: "test", background: true });
  t.mock.timers.tick(30_000);
  f.replies.set("/api/session/oc-parent/message?limit=100&order=desc", {
    data: [
      {
        id: "missed",
        type: "synthetic",
        ...f.notification("shell", "shell-1").payload,
        time: { created: Date.now() - 25_000 },
      },
      {
        type: "assistant",
        time: { created: Date.now() - 30_000 },
        content: [
          {
            type: "tool",
            id: "call-shell",
            name: "shell",
            state: {
              status: "completed",
              metadata: { shellID: "shell-1", status: "running" },
              content: [{ type: "text", text: "Backgrounded" }],
            },
          },
        ],
      },
    ],
  });
  sessions.set(f.session.bbThreadId, f.session);
  try {
    await server.reconcileActiveTurns();
    assert.equal(f.session.active, undefined);
    assert.ok(
      f.emitted.some(
        (delta) => delta.item?.aggregatedOutput === "Background result",
      ),
    );
  } finally {
    sessions.delete(f.session.bbThreadId);
  }
});

test("watchdog does not finish when a new execution starts during its snapshot", async () => {
  const f = fixture();
  const server = new OpenCodeServer();
  Object.assign(server, {
    eventRouter: f.router,
    request: async (path: string) => {
      if (path === "/api/session/oc-parent")
        await f.event("session.execution.started");
      return f.request(path);
    },
  });
  sessions.set(f.session.bbThreadId, f.session);
  try {
    await server.reconcileActiveTurns();
    assert.equal(f.session.active, f.active);
    assert.equal(f.boundaries().length, 0);
  } finally {
    f.router.finish(f.session, "interrupted");
    sessions.delete(f.session.bbThreadId);
  }
});

for (const outcome of ["failed", "interrupted"]) {
  test(`watchdog recovers a missed ${outcome} event despite pending background work`, async () => {
    const f = fixture();
    const server = new OpenCodeServer();
    Object.assign(server, { request: f.request, eventRouter: f.router });
    await f.call("call-shell", "shell", { command: "test", background: true });
    await f.success("call-shell", { shellID: "shell-1", status: "running" });
    f.replies.set("/api/session/oc-parent", {
      data: { outcome, time: { idle: Date.now() - 20_000 } },
    });
    sessions.set(f.session.bbThreadId, f.session);
    try {
      await server.reconcileActiveTurns();
      assert.equal(f.session.active, undefined);
      assert.equal(f.boundaries().at(-1)?.status, outcome);
    } finally {
      sessions.delete(f.session.bbThreadId);
    }
  });
}

test("routes a nested child's background completion without losing its parentRef", async () => {
  const f = fixture();
  await f.call("call-agent", "subagent", {
    agent: "explore",
    background: true,
  });
  await f.success("call-agent", { sessionID: "oc-child", status: "running" });
  await f.event(
    "session.tool.input.started",
    { id: "nested-shell", name: "shell" },
    "oc-child",
  );
  await f.event(
    "session.tool.called",
    { id: "nested-shell", input: { command: "test", background: true } },
    "oc-child",
  );
  await f.event(
    "session.tool.success",
    {
      id: "nested-shell",
      metadata: { shellID: "child-shell", status: "running" },
      content: [{ type: "text", text: "Backgrounded" }],
    },
    "oc-child",
  );
  await f.event("session.execution.succeeded");
  await f.event(
    "session.inbox.enqueued",
    { inboxID: "nested-result", item: f.notification("shell", "child-shell") },
    "oc-child",
  );
  const close = f.emitted.find(
    (delta) =>
      delta.kind === "item.close" &&
      delta.key?.providerItemId === "nested-shell",
  );
  assert.equal(close?.key.parentRef, "call-agent");
  assert.equal(close?.item.aggregatedOutput, "Background result");
  await f.event(
    "session.inbox.delivered",
    { inboxID: "nested-result" },
    "oc-child",
  );
  await f.event("session.inbox.enqueued", {
    inboxID: "agent-result",
    item: f.notification("subagent", "oc-child"),
  });
  await f.event("session.inbox.delivered", { inboxID: "agent-result" });
  await f.event("session.execution.succeeded");
  assert.equal(f.session.active, undefined);
  assert.equal(f.boundaries().length, 1);
});

test("watchdog waits for a notification newer than the parent's idle state", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() - 30_000 });
  const f = fixture();
  const server = new OpenCodeServer();
  Object.assign(server, { request: f.request, eventRouter: f.router });
  await f.call("call-shell", "shell", { command: "test", background: true });
  await f.success("call-shell", { shellID: "shell-1", status: "running" });
  t.mock.timers.tick(30_000);
  f.replies.set("/api/session/oc-parent/message?limit=100&order=desc", {
    data: [
      {
        id: "late-result",
        type: "synthetic",
        ...f.notification("shell", "shell-1").payload,
        time: { created: Date.now() - 10_000 },
      },
    ],
  });
  sessions.set(f.session.bbThreadId, f.session);
  try {
    await server.reconcileActiveTurns();
    assert.equal(f.session.active, f.active);
    t.mock.timers.tick(20_000);
    f.replies.set("/api/session/oc-parent", {
      data: { outcome: "succeeded", time: { idle: Date.now() - 10_000 } },
    });
    await server.reconcileActiveTurns();
    assert.equal(f.session.active, undefined);
  } finally {
    sessions.delete(f.session.bbThreadId);
  }
});

test("watchdog refreshes activity after recovery even when the parent is running", async () => {
  const f = fixture();
  const server = new OpenCodeServer();
  let recovered = false;
  Object.assign(f.router, {
    reconcileBackgroundWork: async () => {
      recovered = true;
    },
  });
  Object.assign(server, {
    eventRouter: f.router,
    request: async (path: string) => {
      if (path === "/api/session/active") {
        assert.equal(recovered, true);
        return { data: { "oc-parent": { type: "running" } } };
      }
      return f.request(path);
    },
  });
  sessions.set(f.session.bbThreadId, f.session);
  try {
    await server.reconcileActiveTurns();
    assert.equal(f.session.active, f.active);
    assert.equal(recovered, true);
  } finally {
    f.router.finish(f.session, "interrupted");
    sessions.delete(f.session.bbThreadId);
  }
});

test("watchdog preserves a resumed child even when the parent is idle", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() - 30_000 });
  const f = fixture();
  const server = new OpenCodeServer();
  Object.assign(server, { request: f.request, eventRouter: f.router });
  await f.call("call-agent", "subagent", {
    agent: "explore",
    background: true,
  });
  await f.success("call-agent", { sessionID: "oc-child", status: "running" });
  await f.event("session.inbox.enqueued", {
    inboxID: "agent-result",
    item: f.notification("subagent", "oc-child"),
  });
  await f.event("session.inbox.delivered", { inboxID: "agent-result" });
  t.mock.timers.tick(30_000);
  f.replies.set("/api/session/active", {
    data: { "oc-child": { type: "running" } },
  });
  sessions.set(f.session.bbThreadId, f.session);
  try {
    await server.reconcileActiveTurns();
    assert.equal(f.session.active, f.active);
    f.replies.set("/api/session/active", { data: {} });
    await server.reconcileActiveTurns();
    assert.equal(f.session.active, undefined);
  } finally {
    sessions.delete(f.session.bbThreadId);
  }
});

test("a deleted child does not block watchdog recovery of the parent", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() - 30_000 });
  const f = fixture();
  const server = new OpenCodeServer();
  let childReads = 0;
  Object.assign(server, { request: f.request, eventRouter: f.router });
  Object.assign(f.router, {
    request: async (path: string) => {
      if (path.startsWith("/api/session/oc-child/")) {
        childReads++;
        throw new Error('OpenCode API 404: {"_tag":"SessionNotFoundError"}');
      }
      return f.request(path);
    },
  });
  await f.call("call-agent", "subagent", {
    agent: "explore",
    background: true,
  });
  await f.success("call-agent", { sessionID: "oc-child", status: "running" });
  f.replies.set("/api/session/oc-parent/message?limit=100&order=desc", {
    data: [
      {
        id: "agent-result",
        type: "synthetic",
        ...f.notification("subagent", "oc-child").payload,
        time: { created: Date.now() + 1_000 },
      },
    ],
  });
  t.mock.timers.tick(30_000);
  sessions.set(f.session.bbThreadId, f.session);
  try {
    await server.reconcileActiveTurns();
    assert.ok(childReads > 0);
    assert.equal(f.session.active, undefined);
  } finally {
    sessions.delete(f.session.bbThreadId);
  }
});

test("uses native event timestamps when stream delivery is delayed", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const f = fixture();
  await f.event("session.tool.input.started", { id: "delayed", name: "shell" });
  await f.router.handleEvent({
    type: "session.tool.called",
    created: now - 20_000,
    data: {
      sessionID: "oc-parent",
      id: "delayed",
      input: { command: "test", background: true },
    },
  });
  await f.success("delayed", { shellID: "shell-1", status: "running" });
  await f.router.handleEvent({
    type: "session.inbox.enqueued",
    created: now - 10_000,
    data: {
      sessionID: "oc-parent",
      inboxID: "delayed-result",
      item: f.notification("shell", "shell-1"),
    },
  });
  assert.equal(f.active.opened.has("delayed"), false);
  await f.event("session.inbox.delivered", { inboxID: "delayed-result" });
  await f.event("session.execution.succeeded");
  assert.equal(f.session.active, undefined);
});

test("watchdog compares a nested notification with its own session's idle time", async (t) => {
  const start = Date.now() - 50_000;
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = fixture();
  const server = new OpenCodeServer();
  Object.assign(server, { request: f.request, eventRouter: f.router });
  await f.call("call-agent", "subagent", {
    agent: "explore",
    background: true,
  });
  await f.success("call-agent", { sessionID: "oc-child", status: "running" });
  await f.event(
    "session.tool.input.started",
    { id: "nested-shell", name: "shell" },
    "oc-child",
  );
  await f.event(
    "session.tool.called",
    { id: "nested-shell", input: { command: "test", background: true } },
    "oc-child",
  );
  await f.event(
    "session.tool.success",
    {
      id: "nested-shell",
      metadata: { shellID: "child-shell", status: "running" },
      content: [{ type: "text", text: "Backgrounded" }],
    },
    "oc-child",
  );
  t.mock.timers.tick(1_000);
  await f.event("session.inbox.enqueued", {
    inboxID: "agent-result",
    item: f.notification("subagent", "oc-child"),
  });
  await f.event("session.inbox.delivered", { inboxID: "agent-result" });
  await f.event("session.execution.succeeded");
  t.mock.timers.tick(19_000);
  await f.event(
    "session.inbox.enqueued",
    { inboxID: "child-result", item: f.notification("shell", "child-shell") },
    "oc-child",
  );
  await f.event(
    "session.inbox.delivered",
    { inboxID: "child-result" },
    "oc-child",
  );
  t.mock.timers.tick(30_000);
  f.replies.set("/api/session/oc-parent", {
    data: { outcome: "succeeded", time: { idle: start + 10_000 } },
  });
  f.replies.set("/api/session/oc-child", {
    data: { outcome: "succeeded", time: { idle: start + 25_000 } },
  });
  sessions.set(f.session.bbThreadId, f.session);
  try {
    await server.reconcileActiveTurns();
    assert.equal(f.session.active, undefined);
    assert.equal(f.boundaries().length, 1);
  } finally {
    sessions.delete(f.session.bbThreadId);
  }
});
