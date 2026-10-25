import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODEL_SETTINGS,
  normalizeModelSettings,
} from "../src/model-settings.ts";

test("normalizes legacy and malformed model settings", () => {
  assert.deepEqual(normalizeModelSettings(undefined), DEFAULT_MODEL_SETTINGS);
  assert.deepEqual(
    normalizeModelSettings({
      providerEnabled: false,
      enabledModels: ["openai/gpt-5", "openai/gpt-5", ""],
    }),
    {
      providerEnabled: false,
      enabledModels: ["openai/gpt-5"],
      disableSubagents: true,
      hideBbToolsOutsideBb: true,
      reportGoUsage: false,
    },
  );
});

test("Go usage is opt-in even when malformed legacy settings need recovery", () => {
  assert.equal(DEFAULT_MODEL_SETTINGS.reportGoUsage, false);
  assert.equal(
    normalizeModelSettings({ reportGoUsage: "true" }).reportGoUsage,
    false,
  );
  assert.equal(
    normalizeModelSettings({ reportGoUsage: true }).reportGoUsage,
    true,
  );
});
