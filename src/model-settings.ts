import {
  modelSettingsSchema,
  type ModelSettings,
} from "./settings-contract.ts";

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  providerEnabled: true,
  enabledModels: null,
  disableSubagents: true,
  hideBbToolsOutsideBb: true,
  reportGoUsage: false,
};

export function normalizeModelSettings(value: unknown): ModelSettings {
  const parsed = modelSettingsSchema.safeParse(value);
  if (parsed.success) {
    return {
      ...parsed.data,
      enabledModels:
        parsed.data.enabledModels === null
          ? null
          : [...new Set(parsed.data.enabledModels)],
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_MODEL_SETTINGS };
  }

  const candidate = value as Record<string, unknown>;
  const enabledModels = Array.isArray(candidate.enabledModels)
    ? candidate.enabledModels.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : null;

  return {
    providerEnabled: candidate.providerEnabled !== false,
    enabledModels: enabledModels === null ? null : [...new Set(enabledModels)],
    disableSubagents: candidate.disableSubagents !== false,
    hideBbToolsOutsideBb: candidate.hideBbToolsOutsideBb !== false,
    reportGoUsage: candidate.reportGoUsage === true,
  };
}
