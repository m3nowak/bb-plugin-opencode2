// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  modelSettingsSchema,
  opencodeSettingsRpcContract,
} from "../src/settings-contract.ts";

const mountedSlots: Array<{ lifecycle: { unmount(): void } }> = [];

afterEach(() => {
  for (const slot of mountedSlots.splice(0)) slot.lifecycle.unmount();
});

describe("OpenCode settings", () => {
  it("shows the selected instance and tests the connection without reading a password", async () => {
    const app = await loadPluginApp(() => import("../src/app.tsx"));
    const getStatus = vi.fn(async () => ({
      hosts: [
        {
          hostId: "local",
          hostName: "laptop",
          status: {
            status: "ready" as const,
            statusMessage: null,
            installedVersion: "2.0.32",
            latestVersion: null,
            minimumSupportedVersion: "2.0.26",
            loginCommand: "opencode2 auth login",
            modelCount: 1,
            connectionMode: "custom" as const,
            serverUrl: "http://127.0.0.1:4095",
          },
        },
      ],
    }));
    const slot = renderSlot<{}, typeof opencodeSettingsRpcContract>(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          getSettings: async () => ({
            providerEnabled: true,
            enabledModels: null,
            disableSubagents: true,
            hideBbToolsOutsideBb: true,
            reportGoUsage: false,
          }),
          listModels: async () => ({ models: [] }),
          getNewThreadAgent: async () => ({ agent: null }),
          setNewThreadAgent: async ({ agent }) => ({ agent }),
          saveSettings: async (settings) => modelSettingsSchema.parse(settings),
          getStatus,
        },
      },
    );
    mountedSlots.push(slot);
    expect(
      await slot.findByText("Existing instance: http://127.0.0.1:4095"),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
  });

  it("loads models and persists provider changes", async () => {
    const app = await loadPluginApp(() => import("../src/app.tsx"));
    const registration = app.settingsSections[0];
    expect(registration?.id).toBe("models");

    const saveSettings = vi.fn(async (settings) => settings);
    const slot = renderSlot<{}, typeof opencodeSettingsRpcContract>(
      registration!,
      {},
      {
        rpc: {
          getSettings: async () => ({
            providerEnabled: true,
            enabledModels: null,
            disableSubagents: true,
            hideBbToolsOutsideBb: true,
            reportGoUsage: false,
          }),
          listModels: async () => ({
            models: [
              {
                id: "openai/gpt-5",
                providerId: "openai",
                displayName: "GPT-5",
              },
            ],
          }),
          getNewThreadAgent: async () => ({ agent: null }),
          setNewThreadAgent: async ({ agent }) => ({ agent }),
          saveSettings,
          getStatus: async () => ({
            hosts: [
              {
                hostId: "host_1",
                hostName: "laptop",
                status: {
                  status: "ready" as const,
                  statusMessage: null,
                  installedVersion: "2.0.27",
                  latestVersion: "2.0.28",
                  minimumSupportedVersion: "2.0.26",
                  loginCommand: "opencode2 auth login",
                  modelCount: 1,
                },
              },
            ],
          }),
        },
      },
    );
    mountedSlots.push(slot);

    expect(await slot.findByText(/Ready · OpenCode 2\.0\.27/)).toBeTruthy();
    expect(slot.getByText(/OpenCode 2\.0\.28 is available/)).toBeTruthy();

    // Provider groups start collapsed; expanding shows the models.
    const group = await slot.findByRole("button", { name: /openai/ });
    expect(slot.queryByText("GPT-5")).toBeNull();
    fireEvent.click(group);
    expect(await slot.findByText("GPT-5")).toBeTruthy();

    fireEvent.click(
      slot.getByRole("switch", { name: "Allow OpenCode subagents" }),
    );
    await waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith({
        providerEnabled: true,
        enabledModels: null,
        disableSubagents: false,
        hideBbToolsOutsideBb: true,
        reportGoUsage: false,
      });
    });

    fireEvent.click(
      slot.getByRole("switch", { name: "Enable OpenCode v2 provider" }),
    );

    await waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith({
        providerEnabled: false,
        enabledModels: null,
        disableSubagents: false,
        hideBbToolsOutsideBb: true,
        reportGoUsage: false,
      });
    });

    const usageToggle = slot.getByRole("switch", {
      name: "Report OpenCode Go usage",
    });
    expect(usageToggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(usageToggle);
    await waitFor(() => {
      expect(saveSettings).toHaveBeenLastCalledWith({
        providerEnabled: false,
        enabledModels: null,
        disableSubagents: false,
        hideBbToolsOutsideBb: true,
        reportGoUsage: true,
      });
    });
  });
});

describe("OpenCode agent picker", () => {
  const values = [
    { id: "build", label: "build", description: "Default" },
    { id: "plan", label: "plan" },
    {
      id: "orchestrator",
      label: "orchestrator",
      description: "Breaks work up",
    },
  ];

  async function render(
    scope:
      | { kind: "thread"; threadId: string }
      | { kind: "new-thread"; projectId: string },
    { declared = true, reportedAfter = 0 } = {},
  ) {
    const app = await loadPluginApp(() => import("../src/app.tsx"));
    const action = app.composerCustomizations[0]?.actions?.[0];
    expect(action?.id).toBe("agent-picker");
    const option = {
      id: "agent",
      label: "Agent",
      description: null,
      category: null,
      type: "select" as const,
      value: "build",
      pendingValue: null,
      values,
    };
    const update = vi.fn(async () => ({}));
    let timelineCalls = 0;
    const setNewThreadAgent = vi.fn(async ({ agent }) => ({ agent }));
    const slot = renderSlot<{}, typeof opencodeSettingsRpcContract>(
      { component: action!.component },
      {},
      {
        composer: { scope, selection: { providerId: "opencode2" } },
        sdk: {
          threads: {
            timeline: async () => ({
              sessionOptions:
                declared && ++timelineCalls > reportedAfter ? [option] : [],
            }),
            update,
          },
          providers: {
            models: async () => ({
              models: [{ sessionOptions: declared ? [option] : [] }],
            }),
          },
        } as never,
        rpc: {
          getSettings: async () => {
            throw new Error("unused");
          },
          listModels: async () => ({ models: [] }),
          getNewThreadAgent: async () => ({ agent: null }),
          setNewThreadAgent,
          saveSettings: async () => ({
            providerEnabled: true,
            enabledModels: null,
            disableSubagents: true,
            hideBbToolsOutsideBb: true,
            reportGoUsage: false,
          }),
          getStatus: async () => ({ hosts: [] }),
        },
      },
    );
    mountedSlots.push(slot);
    return { slot, update, setNewThreadAgent };
  }

  // Testing Library's waitFor and text queries stall for seconds once Radix
  // portals the menu, so open it and read the DOM directly.
  function openAndPick(trigger: HTMLElement, name: string) {
    fireEvent.keyDown(trigger, { key: "Enter" });
    const items = Array.from(
      document.querySelectorAll('[role="menuitemradio"]'),
    );
    const item = items.find((node) => node.textContent?.includes(name));
    expect(item).toBeTruthy();
    // The portaled menu must carry the plugin scope or BB's scoped stylesheet
    // (hover and selected styles) never reaches it.
    expect(item!.closest("[data-bb-plugin]")).toBeTruthy();
    expect(
      items
        .filter((node) => node.getAttribute("aria-checked") === "true")
        .map((node) => node.textContent),
    ).toEqual([expect.stringContaining("build")]);
    fireEvent.click(item!);
  }

  it("stays hidden when the host declares no agent option", async () => {
    const { slot } = await render(
      { kind: "thread", threadId: "thr_1" },
      { declared: false },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.queryByRole("button", { name: "OpenCode agent" })).toBeNull();
  });

  it("appears once the host reports the option, without waiting for a reply", async () => {
    const { slot } = await render(
      { kind: "thread", threadId: "thr_1" },
      { reportedAfter: 1 },
    );
    expect(
      await slot.findByRole(
        "button",
        { name: "OpenCode agent" },
        { timeout: 3_000 },
      ),
    ).toBeTruthy();
  }, 10_000);

  it("changes an existing thread's agent through its session options", async () => {
    const { slot, update } = await render({
      kind: "thread",
      threadId: "thr_1",
    });
    const trigger = await slot.findByRole("button", { name: "OpenCode agent" });
    expect(trigger.textContent).toContain("build");
    openAndPick(trigger, "orchestrator");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(update).toHaveBeenCalledWith({
      threadId: "thr_1",
      sessionOptions: { agent: "orchestrator" },
    });
  }, 20_000);

  it("keeps a new-thread composer's pick in the plugin", async () => {
    const { slot, setNewThreadAgent, update } = await render({
      kind: "new-thread",
      projectId: "proj_1",
    });
    const trigger = await slot.findByRole("button", { name: "OpenCode agent" });
    openAndPick(trigger, "orchestrator");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(setNewThreadAgent).toHaveBeenCalledWith({
      projectId: "proj_1",
      agent: "orchestrator",
    });
    expect(update).not.toHaveBeenCalled();
  }, 20_000);
});
