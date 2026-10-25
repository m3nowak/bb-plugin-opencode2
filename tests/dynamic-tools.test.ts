import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import type { BridgeToolCallRequest } from "@get-bb/plugin-sdk/provider-bridge";
import { fileURLToPath } from "node:url";
import {
  createDynamicToolCallRouter,
  DYNAMIC_TOOLS_MCP_ARG,
  dynamicMcpRegistrationRequest,
  enabledDynamicTools,
  handleDynamicToolsMcpRequest,
  isSensitiveEnvironmentKey,
  parseOpenCodeServiceUrl,
  sameDynamicTools,
  sessionEnvironmentRequest,
  sessionEnvironmentVariables,
  sessionFromParams,
  sessionInstructionsRequest,
  startDynamicToolsMcpProxy,
} from "./support/host-api.js";

const TOOLS = [
  {
    name: "lookup_weather",
    description: "Looks up the weather",
    inputSchema: { type: "object" },
  },
  {
    name: "hidden_tool",
    description: "Should not be exposed",
    inputSchema: { type: "object" },
  },
];

test("accepts only loopback OpenCode service URLs", () => {
  assert.equal(
    parseOpenCodeServiceUrl("http://127.0.0.1:4096 ready"),
    "http://127.0.0.1:4096",
  );
  assert.throws(
    () => parseOpenCodeServiceUrl("https://example.com"),
    /HTTP loopback/,
  );
  assert.throws(
    () => parseOpenCodeServiceUrl("http://user:password@localhost:4096"),
    /must not contain credentials/,
  );
});

test("filters disallowed BB dynamic tools", () => {
  const tools = enabledDynamicTools(TOOLS, new Set(["hidden_tool"]));
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["lookup_weather"],
  );
});

test("registers the local MCP bridge on OpenCode v2's experimental route", () => {
  const config = {
    type: "local",
    command: ["node", "bridge.mjs"],
    codemode: false,
  };
  assert.deepEqual(
    dynamicMcpRegistrationRequest(
      "bb opencode2/test",
      "/repo with spaces",
      config,
    ),
    {
      path: "/api/experimental/mcp/bb%20opencode2%2Ftest?location[directory]=%2Frepo%20with%20spaces",
      init: { method: "PUT", body: JSON.stringify({ config }) },
    },
  );
});

test("reads session instructions from bridge execution options", () => {
  const session = sessionFromParams(
    {
      threadId: "thread_1",
      cwd: "/repo",
      options: {
        permissionMode: "auto",
        instructions: "Use the repository conventions.",
      },
    },
    "session_1",
    {
      providerEnabled: true,
      enabledModels: null,
      disableSubagents: true,
      hideBbToolsOutsideBb: true,
      reportGoUsage: false,
    },
  );

  assert.equal(session.instructions, "Use the repository conventions.");
});

test("uses the documented session-instructions entry instead of unsupported prompt fields", () => {
  assert.deepEqual(
    sessionInstructionsRequest("ses_123", "Use the repository conventions."),
    {
      path: "/api/experimental/session/ses_123/instructions/entries/bb.provider.instructions",
      init: {
        method: "PUT",
        body: JSON.stringify({ value: "Use the repository conventions." }),
      },
    },
  );
  // Empty instructions remove a stale entry instead of leaving it behind.
  assert.deepEqual(sessionInstructionsRequest("ses_123", ""), {
    path: "/api/experimental/session/ses_123/instructions/entries/bb.provider.instructions",
    init: { method: "DELETE" },
  });
});

test("builds a codex-style session environment with bb on PATH", () => {
  const variables = sessionEnvironmentVariables({
    hostEnv: {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/e",
      BB_SECRET: "x",
      NODE_ENV: "production",
    },
    bridgeEnvVars: { EXTRA: "1", PATH: "/custom/bin:/usr/bin" },
    bbBinDir: "/Applications/bb.app/dist",
  });
  assert.equal(variables.HOME, "/Users/e");
  assert.equal(variables.EXTRA, "1");
  assert.equal(variables.BB_SECRET, undefined);
  assert.equal(variables.NODE_ENV, undefined);
  assert.equal(
    variables.PATH,
    "/Applications/bb.app/dist:/custom/bin:/usr/bin",
  );
});

test("removes incidental credentials from the OpenCode shell environment", () => {
  const variables = sessionEnvironmentVariables({
    hostEnv: {
      PATH: "/usr/bin",
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      GH_TOKEN: "github",
      OPENCODE_SERVER_PASSWORD: "password",
      SAFE_VALUE: "kept",
    },
    bridgeEnvVars: { EXPLICIT_API_KEY: "intentional" },
  });

  assert.equal(variables.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(variables.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(variables.GH_TOKEN, undefined);
  assert.equal(variables.OPENCODE_SERVER_PASSWORD, undefined);
  assert.equal(variables.SAFE_VALUE, "kept");
  assert.equal(variables.EXPLICIT_API_KEY, "intentional");
  assert.equal(isSensitiveEnvironmentKey("DATABASE_PASSWORD"), true);
  assert.equal(isSensitiveEnvironmentKey("PATH"), false);
});

test("does not duplicate the bb directory already on PATH", () => {
  const variables = sessionEnvironmentVariables({
    hostEnv: { PATH: "/bb/dist:/usr/bin" },
    bbBinDir: "/bb/dist",
  });
  assert.equal(variables.PATH, "/bb/dist:/usr/bin");
});

test("uses the session environment endpoint with the full variable map", () => {
  assert.deepEqual(
    sessionEnvironmentRequest("ses_123", {
      PATH: "/bb:/usr/bin",
      HOME: "/Users/e",
    }),
    {
      path: "/api/session/ses_123/environment",
      init: {
        method: "PUT",
        body: JSON.stringify({
          variables: { PATH: "/bb:/usr/bin", HOME: "/Users/e" },
        }),
      },
    },
  );
});

test("detects unchanged dynamic tool catalogs regardless of order", () => {
  const a = [
    { name: "b_tool", description: "B", inputSchema: { type: "object" } },
    {
      name: "a_tool",
      description: "A",
      inputSchema: { type: "object", properties: { x: {} } },
    },
  ];
  const same = [
    {
      name: "a_tool",
      description: "A",
      inputSchema: { type: "object", properties: { x: {} } },
    },
    { name: "b_tool", description: "B", inputSchema: { type: "object" } },
  ];
  assert.equal(sameDynamicTools(a, same), true);
  assert.equal(
    sameDynamicTools(a, [
      ...same,
      { name: "c_tool", description: "C", inputSchema: {} },
    ]),
    false,
  );
  assert.equal(
    sameDynamicTools(a, [{ ...same[0], description: "changed" }, same[1]]),
    false,
  );
  assert.equal(sameDynamicTools([], []), true);
});

test("maps an OpenCode MCP tools/call request to the BB tool-call protocol and returns its result", async () => {
  const requests: BridgeToolCallRequest[] = [];
  const router = createDynamicToolCallRouter((request) =>
    requests.push(request),
  );
  const scope = {};
  const pending = router.forward({
    arguments: { city: "Oslo" },
    providerThreadId: "oc_session_1",
    scope,
    threadId: "bb_thread_1",
    toolName: "lookup_weather",
  });

  assert.deepEqual(requests, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "item/tool/call",
      params: {
        threadId: "bb_thread_1",
        providerThreadId: "oc_session_1",
        turnId: null,
        callId: "call-1",
        tool: "lookup_weather",
        arguments: { city: "Oslo" },
      },
    },
  ]);

  assert.equal(
    router.handleRuntimeResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        success: true,
        contentItems: [{ type: "inputText", text: "Rain, 8C" }],
      },
    }),
    true,
  );
  assert.deepEqual(await pending, {
    content: "Rain, 8C",
    contentBlocks: [{ type: "text", text: "Rain, 8C" }],
    images: [],
    isError: false,
  });
});

test("MCP exposes only configured tools, requires OpenCode's session metadata, and returns BB errors", async () => {
  const writes: Array<Record<string, unknown>> = [];
  const calls: Array<Record<string, unknown>> = [];
  const runtime = {
    tools: TOOLS.slice(0, 1),
    sessionId: "oc_session_1",
    callTool: async (call: Record<string, unknown>) => {
      calls.push(call);
      return { content: "Rain, 8C", isError: true };
    },
  };
  const write = (message: unknown) =>
    writes.push(message as Record<string, unknown>);

  await assert.doesNotReject(
    handleDynamicToolsMcpRequest(runtime, null, write),
  );
  await assert.doesNotReject(handleDynamicToolsMcpRequest(runtime, [], write));
  assert.equal(writes.length, 0);

  await handleDynamicToolsMcpRequest(
    runtime,
    { id: 1, method: "tools/list" },
    write,
  );
  assert.deepEqual(
    (writes[0]?.result as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    ),
    ["lookup_weather"],
  );

  await handleDynamicToolsMcpRequest(
    runtime,
    {
      id: 2,
      method: "tools/call",
      params: {
        name: "lookup_weather",
        arguments: { city: "Oslo" },
        _meta: { "ai.opencode/sessionID": "oc_session_1" },
      },
    },
    write,
  );
  assert.deepEqual(calls, [
    {
      sessionId: "oc_session_1",
      toolName: "lookup_weather",
      arguments: { city: "Oslo" },
    },
  ]);
  assert.deepEqual(writes[1]?.result, {
    content: [{ type: "text", text: "Rain, 8C" }],
    isError: true,
  });

  await handleDynamicToolsMcpRequest(
    runtime,
    {
      id: 3,
      method: "tools/call",
      params: { name: "lookup_weather", arguments: {} },
    },
    write,
  );
  assert.deepEqual(writes[2]?.result, {
    content: [
      {
        type: "text",
        text: "This BB tool is not available in this OpenCode session.",
      },
    ],
    isError: true,
  });
});

test("the stdio MCP child round trips a tool call through the loopback bridge", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const proxy = await startDynamicToolsMcpProxy({
    serverName: "bb_opencode2_test",
    sessionId: "oc_session_1",
    tools: TOOLS.slice(0, 1),
    entryPath: fileURLToPath(new URL("../dist/host.js", import.meta.url)),
    callTool: async (call: Record<string, unknown>) => {
      calls.push(call);
      return { content: "Rain, 8C" };
    },
  });
  const environment = (proxy.config.environment ?? {}) as Record<
    string,
    string
  >;
  // Mcp.LocalConfig requires a timeout object whose named values are positive.
  assert.deepEqual(proxy.config.timeout, { execution: 600_000 });
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/host.js", import.meta.url)),
      DYNAMIC_TOOLS_MCP_ARG,
    ],
    {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });

  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "lookup_weather",
          arguments: { city: "Oslo" },
          _meta: { sessionID: "oc_session_1" },
        },
      })}\n`,
    );
    const response = await waitForJsonLine(() => output);
    assert.deepEqual(calls, [
      {
        sessionId: "oc_session_1",
        toolName: "lookup_weather",
        arguments: { city: "Oslo" },
      },
    ]);
    assert.deepEqual(response.result, {
      content: [{ type: "text", text: "Rain, 8C" }],
    });
  } finally {
    child.kill();
    proxy.close();
  }
});

async function waitForJsonLine(
  read: () => string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const newline = read().indexOf("\n");
    if (newline !== -1)
      return JSON.parse(read().slice(0, newline)) as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("MCP child did not return a response");
}
