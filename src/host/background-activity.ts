import {
  LOCAL_BASH_TASK_TYPE,
  experimental_presentationTitle as presentationTitle,
  type DeltaBackgroundTaskShape,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  stringValue,
  type ActiveTurn,
  type BackgroundTask,
  type OpenCodeRecord,
} from "./types.ts";

function taskKey(callId: string) {
  return { providerItemId: `background:${callId}`, parentRef: callId };
}

/** Feed BB's shared activity icons and composer task panel, not custom UI. */
export function openBackgroundActivity(
  active: ActiveTurn,
  callId: string,
  task: BackgroundTask,
  original: OpenCodeRecord,
  input: OpenCodeRecord,
): ThreadDelta[] {
  if (active.backgroundItems?.has(callId)) return [];
  const item: DeltaBackgroundTaskShape = {
    type: "backgroundTask",
    familyId: task.resourceId,
    taskType: task.source === "shell" ? LOCAL_BASH_TASK_TYPE : "local_subagent",
    description:
      stringValue(input.description) ??
      active.toolDescriptions?.get(callId) ??
      stringValue(original.label) ??
      stringValue(original.command) ??
      "OpenCode background task",
    status: "pending",
    taskStatus: "running",
    skipTranscript: false,
    foreground: false,
  };
  (active.backgroundItems ??= new Map()).set(callId, item);
  const command = task.source === "shell";
  const title = presentationTitle(item.description);
  return [
    {
      kind: "item.open",
      key: taskKey(callId),
      item,
      presentation: {
        icon: { glyph: command ? "Terminal" : "UserRound" },
        label: {
          pending: command
            ? "Running background command"
            : "Running background agent",
          completed: command
            ? "Background command finished"
            : "Background agent finished",
        },
        ...(title ? { title } : {}),
      },
      providerTurnId: active.providerTurnId,
    },
  ];
}

export function closeBackgroundActivity(
  active: ActiveTurn,
  callId: string,
  status: "completed" | "failed" | "interrupted",
  summary?: string,
): ThreadDelta[] {
  const previous = active.backgroundItems?.get(callId);
  if (!previous) return [];
  active.backgroundItems?.delete(callId);
  const item: DeltaBackgroundTaskShape = {
    ...previous,
    status,
    taskStatus: status === "interrupted" ? "stopped" : status,
    ...(summary ? { summary } : {}),
    ...(status === "failed" && summary ? { error: summary } : {}),
  };
  return [
    {
      kind: "item.close",
      key: taskKey(callId),
      status,
      item,
      providerTurnId: active.providerTurnId,
    },
  ];
}
