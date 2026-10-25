import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import {
  modelSettingsSchema,
  opencodeSettingsRpcContract,
  type HostStatus,
  type ModelSettings,
  type ModelSummary,
  type OpenCodeStatus,
} from "../settings-contract.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

function groupByProvider(models: ModelSummary[]) {
  const map = new Map<string, ModelSummary[]>();
  for (const model of models) {
    const list = map.get(model.providerId) ?? [];
    list.push(model);
    map.set(model.providerId, list);
  }
  return [...map.entries()]
    .map(([providerId, items]) => ({
      providerId,
      items: items.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }))
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function SettingRow({
  title,
  description,
  checked,
  disabled,
  label,
  onCheckedChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm">{title}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
      <Switch
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

const STATUS_LABELS: Record<OpenCodeStatus["status"], string> = {
  ready: "Ready",
  not_installed: "Not installed",
  unsupported_version: "Update required",
  unauthenticated: "No model provider connected",
  unknown: "Service unreachable",
};

function statusDetail(status: OpenCodeStatus) {
  if (status.status === "not_installed")
    return "Install OpenCode v2 from the provider settings, or run `npm install -g @opencode/cli`.";
  if (status.statusMessage) return status.statusMessage;
  if (status.status === "unauthenticated")
    return `Run \`${status.loginCommand}\` on this machine to connect a model provider.`;
  const parts = [`${status.modelCount} models available`];
  if (
    status.latestVersion &&
    status.installedVersion &&
    status.latestVersion !== status.installedVersion
  )
    parts.push(
      `OpenCode ${status.latestVersion} is available (run \`opencode2 upgrade\`)`,
    );
  return parts.join(" · ");
}

function HostStatusRow({
  host,
  showName,
}: {
  host: HostStatus;
  showName: boolean;
}) {
  const status = host.status;
  const ready = status?.status === "ready";
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm">
          {showName ? `${host.hostName} · ` : ""}
          {status
            ? `${STATUS_LABELS[status.status]}${status.installedVersion ? ` · OpenCode ${status.installedVersion}` : ""}`
            : "Status unavailable"}
        </div>
        <div className="text-sm text-muted-foreground">
          {status ? statusDetail(status) : host.error}
        </div>
        {status?.serverUrl ? (
          <div className="text-xs text-muted-foreground">
            {status.connectionMode === "custom"
              ? "Existing instance"
              : "Automatic service"}
            : {status.serverUrl}
          </div>
        ) : null}
      </div>
      <span
        aria-hidden
        className={`mt-1.5 size-2 shrink-0 rounded-full ${ready ? "bg-emerald-500" : "bg-amber-500"}`}
      />
    </div>
  );
}

export function SettingsSection() {
  const rpc = useRpc<typeof opencodeSettingsRpcContract>();
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [hosts, setHosts] = useState<HostStatus[] | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const operationId = useRef(0);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  useRealtime("settings-changed", (payload) => {
    const parsed = modelSettingsSchema.safeParse(payload);
    if (parsed.success) setSettings(parsed.data);
  });

  const load = useCallback(async () => {
    const id = ++operationId.current;
    setIsLoading(true);
    setError(null);
    // The status probe can be slow; it never blocks the model list.
    void rpcRef.current
      .call("getStatus", {})
      .then((result) => {
        if (id === operationId.current) setHosts(result.hosts);
      })
      .catch(() => {
        if (id === operationId.current) setHosts([]);
      });
    try {
      const [nextSettings, nextModels] = await Promise.all([
        rpcRef.current.call("getSettings", null),
        rpcRef.current.call("listModels", {}),
      ]);
      if (id !== operationId.current) return;
      setSettings(nextSettings);
      setModels(nextModels.models);
    } catch (cause) {
      if (id === operationId.current) setError(errorText(cause));
    } finally {
      if (id === operationId.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      operationId.current += 1;
    };
  }, [load]);

  async function save(next: ModelSettings) {
    if (!settings || isSaving) return;
    const previous = settings;
    const id = ++operationId.current;
    setSettings(next);
    setIsSaving(true);
    setError(null);
    try {
      const saved = await rpcRef.current.call("saveSettings", next);
      if (id === operationId.current) setSettings(saved);
    } catch (cause) {
      if (id === operationId.current) {
        setSettings(previous);
        setError(errorText(cause));
      }
    } finally {
      if (id === operationId.current) setIsSaving(false);
    }
  }

  const isEnabled = (model: ModelSummary): boolean =>
    settings !== null &&
    (settings.enabledModels === null ||
      settings.enabledModels.includes(model.id));

  const providers = useMemo(() => groupByProvider(models), [models]);
  const searching = query.trim().length > 0;

  const visibleProviders = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    return providers
      .map((group) => ({
        ...group,
        items: group.items.filter((model) =>
          `${model.displayName} ${model.providerId} ${model.id}`
            .toLowerCase()
            .includes(q),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [providers, query]);

  const enabledCount = models.filter(isEnabled).length;

  function enabledSet() {
    return settings?.enabledModels === null || !settings
      ? new Set(models.map((item) => item.id))
      : new Set(settings.enabledModels);
  }

  function setModelsEnabled(ids: string[], nextEnabled: boolean) {
    if (!settings) return;
    const current = enabledSet();
    for (const id of ids) {
      if (nextEnabled) current.add(id);
      else current.delete(id);
    }
    // Every model on: store null so newly connected models appear too.
    const allOn = models.every((model) => current.has(model.id));
    void save({
      ...settings,
      enabledModels: allOn ? null : [...current].sort(),
    });
  }

  function toggleExpanded(providerId: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  }

  const busy = settings === null || isSaving;

  return (
    <div className="opencode-settings">
      <div className="text-xs text-muted-foreground">
        Configure the server URL and password in Extensions → Plugins → OpenCode
        v2. After changing servers, reload the plugin and start new threads.
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm font-medium">OpenCode</div>
        <Button
          variant="outline"
          size="sm"
          disabled={isLoading || isSaving}
          onClick={() => void load()}
        >
          Test connection
        </Button>
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="flex flex-col gap-3">
          {hosts === null ? (
            <div className="text-sm text-muted-foreground" role="status">
              Checking OpenCode…
            </div>
          ) : hosts.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No connected hosts. Connect a host to check OpenCode.
            </div>
          ) : (
            hosts.map((host) => (
              <HostStatusRow
                key={host.hostId}
                host={host}
                showName={hosts.length > 1}
              />
            ))
          )}
        </div>
      </div>

      <div className="text-sm font-medium">Behavior</div>
      <div className="rounded-lg border border-border p-4">
        <div className="flex flex-col gap-4">
          <SettingRow
            title="Report OpenCode Go usage"
            description="Show Go subscription limits and reset times in BB's usage panel, grouped by machine. Reads the OpenCode Console sign-in on each host and asks opencode.ai directly. No prepaid balance is reported. Off by default."
            checked={settings?.reportGoUsage === true}
            disabled={busy}
            label="Report OpenCode Go usage"
            onCheckedChange={(next) => {
              if (settings) void save({ ...settings, reportGoUsage: next });
            }}
          />
          <SettingRow
            title="Show in the provider picker"
            description="Offer OpenCode v2 for new threads. Existing threads keep their provider."
            checked={settings?.providerEnabled ?? false}
            disabled={busy}
            label="Enable OpenCode v2 provider"
            onCheckedChange={(next) => {
              if (settings) void save({ ...settings, providerEnabled: next });
            }}
          />
          <SettingRow
            title="Allow OpenCode subagents"
            description="Let OpenCode delegate to its own subagents (shown as delegation rows). When off, OpenCode hides its subagent tool and agents delegate through BB instead."
            checked={settings?.disableSubagents === false}
            disabled={busy}
            label="Allow OpenCode subagents"
            onCheckedChange={(next) => {
              if (settings) void save({ ...settings, disableSubagents: !next });
            }}
          />
          <SettingRow
            title="Keep BB tools inside BB"
            description="OpenCode shares MCP servers across a directory, so its own sessions (TUI, web) would list BB threads' tools. Adds one deny rule for bb_opencode2_* to your global OpenCode config; turning this off removes it."
            checked={settings?.hideBbToolsOutsideBb !== false}
            disabled={busy}
            label="Keep BB tools inside BB"
            onCheckedChange={(next) => {
              if (settings)
                void save({ ...settings, hideBbToolsOutsideBb: next });
            }}
          />
        </div>
      </div>

      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-sm font-medium">Models</div>
          <div className="text-sm text-muted-foreground">
            {models.length > 0
              ? `${enabledCount} of ${models.length} models appear in the OpenCode v2 picker.`
              : "Only enabled models appear in the OpenCode v2 picker."}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || models.length === 0}
            onClick={() => void save({ ...settings!, enabledModels: null })}
          >
            Enable all
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || models.length === 0}
            onClick={() => void save({ ...settings!, enabledModels: [] })}
          >
            Disable all
          </Button>
        </div>
      </div>

      <Input
        aria-label="Search OpenCode models"
        placeholder="Search models"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {isLoading ? (
        <div className="text-sm text-muted-foreground" role="status">
          Loading models…
        </div>
      ) : null}
      {error ? (
        <div className="text-sm text-destructive" role="alert">
          {error}
        </div>
      ) : null}
      {!isLoading && models.length === 0 && !error ? (
        <div className="text-sm text-muted-foreground">
          No OpenCode models were found on a connected host.
        </div>
      ) : null}
      {!isLoading && models.length > 0 && visibleProviders.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No models match your search.
        </div>
      ) : null}

      {!isLoading && !error && visibleProviders.length > 0 ? (
        <div className="rounded-lg border border-border">
          {visibleProviders.map((group) => {
            const groupEnabled = group.items.filter(isEnabled).length;
            const allOn = groupEnabled === group.items.length;
            const open = searching || expanded.has(group.providerId);
            return (
              <div
                key={group.providerId}
                className="border-b border-border last:border-b-0"
              >
                <div className="flex items-center justify-between gap-4 p-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                    aria-expanded={open}
                    onClick={() => toggleExpanded(group.providerId)}
                  >
                    <span aria-hidden className="text-muted-foreground">
                      {open ? "▾" : "▸"}
                    </span>
                    <span className="truncate">{group.providerId}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {groupEnabled}/{group.items.length}
                    </span>
                  </button>
                  <Switch
                    aria-label={`Enable all ${group.providerId} models`}
                    checked={allOn}
                    disabled={busy}
                    onCheckedChange={(next) =>
                      setModelsEnabled(
                        group.items.map((model) => model.id),
                        next,
                      )
                    }
                  />
                </div>
                {open
                  ? group.items.map((model) => (
                      <div
                        key={model.id}
                        className="flex items-center justify-between gap-4 border-t border-border py-2 pr-3 pl-8"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm">
                            {model.displayName}
                            {model.isDefault ? (
                              <span className="ml-2 text-xs text-muted-foreground">
                                OpenCode default
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {model.id}
                          </div>
                        </div>
                        <Switch
                          aria-label={`Enable ${model.displayName} from ${model.providerId}`}
                          checked={isEnabled(model)}
                          disabled={busy}
                          onCheckedChange={(next) =>
                            setModelsEnabled([model.id], next)
                          }
                        />
                      </div>
                    ))
                  : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="text-xs text-muted-foreground">
        {isSaving
          ? "Saving…"
          : "Settings apply from the next turn. The model picker updates when BB refreshes its model list."}
      </div>
    </div>
  );
}
