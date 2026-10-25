import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeInteractions } from "./support/host-api.js";
import type { ActiveTurn, SessionState } from "../src/host/types.ts";

function fixture() {
  const active: ActiveTurn = {
    providerTurnId: "native-turn-1",
    startedAt: Date.now(),
    abortController: new AbortController(),
    opened: new Map([
      ["question-1", { type: "tool", tool: "question", args: {} }],
    ]),
    pendingTools: new Map(),
    pendingInput: new Map(),
    touchedFiles: new Map(),
    openQuestions: new Map(),
    settledTools: new Set(),
  };
  const session: SessionState = {
    bbThreadId: "bb-thread",
    providerThreadId: "oc-session",
    cwd: process.cwd(),
    permissionMode: "accept-edits",
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
  const requests: { path: string; init?: RequestInit }[] = [];
  const deltas: Record<string, any>[] = [];
  const interactions: Record<string, any>[] = [];
  const form = {
    id: "form-1",
    metadata: { tool: { id: "question-1" } },
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Choice",
        description: "Choose an option",
        options: [{ label: "First", value: "first" }],
        custom: true,
      },
    ],
  };
  const create = (resolution: Record<string, any> | Error) =>
    new OpenCodeInteractions(
      async (path: string, init?: RequestInit) => {
        requests.push({ path, init });
        return { data: [form] };
      },
      (_threadId: string, emitted: Record<string, any>[]) =>
        deltas.push(...emitted),
      async (_method: string, params: Record<string, any>) => {
        interactions.push(params);
        if (resolution instanceof Error) throw resolution;
        return resolution;
      },
    );
  return { active, session, requests, deltas, interactions, create };
}

const userAnswer = {
  kind: "user_answer",
  answers: { q0: { selected: ["first"] } },
};

test("forwards a direct BB user_answer to OpenCode instead of dismissing it", async () => {
  const f = fixture();
  await f.create(userAnswer).handleQuestion(f.session, f.active, "question-1");

  const reply = f.requests.find((request) => request.path.endsWith("/reply"));
  assert.ok(reply, "the answer must reach OpenCode");
  assert.deepEqual(JSON.parse(String(reply.init?.body)), {
    answer: { q0: "first" },
  });
  assert.equal(f.deltas.at(-1)?.status, "completed");
  assert.equal(
    f.requests.some((request) => request.init?.method === "DELETE"),
    false,
  );
});

test("attaches questions to BB's current turn without a synthetic native turn ID", async () => {
  const f = fixture();
  await f.create(userAnswer).handleQuestion(f.session, f.active, "question-1");

  assert.equal(f.interactions[0]?.turnId, null);
  assert.equal(f.interactions[0]?.providerNativeIds, true);
});

test("preserves the runtime failure instead of reporting a user dismissal", async () => {
  const f = fixture();
  await f
    .create(new Error("turn_start_not_ready"))
    .handleQuestion(f.session, f.active, "question-1");

  assert.match(f.deltas.at(-1)?.item.error, /turn_start_not_ready/);
  assert.equal(f.deltas.at(-1)?.status, "failed");
  assert.ok(f.requests.some((request) => request.init?.method === "DELETE"));
});

test("still cancels a question when BB returns no answer", async () => {
  const f = fixture();
  await f.create({}).handleQuestion(f.session, f.active, "question-1");

  assert.equal(f.deltas.at(-1)?.item.error, "Question dismissed");
  assert.ok(f.requests.some((request) => request.init?.method === "DELETE"));
});

test("accepts direct BB approval decisions and translates native IDs", async () => {
  const f = fixture();
  await f.create({ decision: "allow_once" }).handlePermission(f.session, {
    sessionID: f.session.providerThreadId,
    id: "permission-1",
    action: "shell",
    source: { id: "native-tool-1" },
  });

  assert.equal(f.interactions[0]?.providerNativeIds, true);
  assert.equal(f.interactions[0]?.turnId, null);
  const reply = f.requests.find((request) => request.path.endsWith("/reply"));
  assert.ok(reply);
  assert.deepEqual(JSON.parse(String(reply.init?.body)), { decision: "once" });
});

test("a late form reply cannot close a question in the next BB-managed turn", async () => {
  const f = fixture();
  const interactions = new OpenCodeInteractions(
    async (path) => {
      if (path.endsWith("/reply")) {
        f.session.active = fixture().active;
        return {};
      }
      return {
        data: [
          {
            id: "form-1",
            metadata: { tool: { id: "question-1" } },
            fields: [{ key: "q0", type: "string", title: "Choice" }],
          },
        ],
      };
    },
    (_threadId, deltas) => f.deltas.push(...deltas),
    async () => userAnswer,
  );
  await interactions.handleQuestion(f.session, f.active, "question-1");
  assert.equal(f.deltas.length, 0);
  assert.ok(f.session.active?.opened.has("question-1"));
});
