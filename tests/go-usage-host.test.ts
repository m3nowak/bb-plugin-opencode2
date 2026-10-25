import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { DEFAULT_MODEL_SETTINGS } from "../src/model-settings.ts";
import hostEntry from "./support/host-api.js";

test("host RPC gates collection and reads the configured local API without touching provider keys", async (t) => {
  const dir = await mkdtemp("/tmp/opencode/go-usage-host-");
  const requests: { path: string; authorization?: string }[] = [];
  let usageStatus = 200;
  let data: unknown = {
    workspace: { id: "ws-local", name: "Personal" },
    go: {
      rolling: { percent: 25, limited: false, resetsAt: 1_800_000_000_000 },
      weekly: { percent: 50, limited: false, resetsAt: 1_800_000_000_000 },
      monthly: { percent: 75, limited: false, resetsAt: 1_800_000_000_000 },
    },
  };
  const http = createServer((request, response) => {
    const path = request.url!;
    requests.push({ path, authorization: request.headers.authorization });
    if (path === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": keepalive\n\n");
      return;
    }
    response.writeHead(
      path === "/api/experimental/usage/limits" ? usageStatus : 200,
      { "content-type": "application/json" },
    );
    response.end(
      JSON.stringify(
        path === "/api/info"
          ? { version: "2.1.4" }
          : path === "/api/experimental/usage/limits"
            ? { location: {}, data, detail: "private-response-body" }
            : {},
      ),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const harness = experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: { dataDir: dir, tempDir: dir },
  });
  t.after(async () => {
    await harness.experimental_dispose();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  await harness.experimental_call("configureConnection", {
    mode: "custom",
    url: `http://127.0.0.1:${address.port}`,
    username: "opencode",
    password: "local-service-password",
  });
  await assert.rejects(harness.experimental_call("getGoUsage", {}), /disabled/);
  assert.equal(requests.length, 0);

  const settingsFile = join(dir, "opencode2-model-settings.json");
  await writeFile(
    settingsFile,
    JSON.stringify({ ...DEFAULT_MODEL_SETTINGS, reportGoUsage: true }),
  );
  const result = await harness.experimental_call("getGoUsage", {});
  assert.equal(result.measurement.accountKey, "opencode.ai:workspace:ws-local");
  assert.equal(result.measurement.usage.status, "ok");
  assert.ok(
    requests.some(
      (request) => request.path === "/api/experimental/usage/limits",
    ),
  );
  assert.ok(
    requests.every(
      (request) =>
        request.authorization ===
        `Basic ${Buffer.from("opencode:local-service-password").toString("base64")}`,
    ),
  );

  usageStatus = 404;
  const unsupported = await harness.experimental_call("getGoUsage", {});
  assert.equal(unsupported.measurement.usage.status, "error");
  assert.match(JSON.stringify(unsupported), /Update OpenCode/);
  assert.ok(!JSON.stringify(unsupported).includes("private-response-body"));
  usageStatus = 200;
  data = null;
  assert.equal(
    (await harness.experimental_call("getGoUsage", {})).measurement.usage
      .status,
    "unauthenticated",
  );

  await writeFile(settingsFile, JSON.stringify(DEFAULT_MODEL_SETTINGS));
  const before = requests.length;
  await assert.rejects(harness.experimental_call("getGoUsage", {}), /disabled/);
  assert.equal(requests.length, before);

  // Syncing valid settings must remain able to replace a malformed private file.
  await writeFile(join(dir, "opencode2-connection-secret.json"), "not-json");
  await harness.experimental_call("configureConnection", {
    mode: "custom",
    url: `http://127.0.0.1:${address.port}`,
    username: "opencode",
    password: "local-service-password",
  });
});
