import {
  experimental_COMPACTION_PRESENTATION as compactionPresentation,
  isStandaloneBuiltinCompactCommand,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { OpenCodeRecord } from "./types.ts";

type RecordValue = OpenCodeRecord;

// Timeline events are persisted and rendered by BB. Keep every individual
// provider delta comfortably below the host's event-size limit, even when an
// OpenCode tool returns a file, a command dump, or structured provider data.
export const MAX_TIMELINE_DELTA_BYTES = 64 * 1024;
const INITIAL_TIMELINE_STRING_BYTES = 16 * 1024;
const FALLBACK_TIMELINE_STRING_BYTES = 512;
const MAX_TIMELINE_VALUE_DEPTH = 6;
const MAX_TIMELINE_VALUE_NODES = 64;
const MAX_TIMELINE_VALUE_ENTRIES = 16;
const MAX_TIMELINE_VALUE_ENTRIES_TOTAL = 64;
const MAX_TIMELINE_KEY_BYTES = 128;
function utf8Prefix(value: string, maxBytes: number) {
  let end = 0;
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return value.slice(0, end);
}

function utf8Suffix(value: string, maxBytes: number) {
  let start = value.length;
  let bytes = 0;
  while (start > 0) {
    let charStart = start - 1;
    const code = value.charCodeAt(charStart);
    if (code >= 0xdc00 && code <= 0xdfff && charStart > 0) {
      const previous = value.charCodeAt(charStart - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) charStart -= 1;
    }
    const char = value.slice(charStart, start);
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    start = charStart;
  }
  return value.slice(start);
}

function truncationMarker(omittedBytes: number) {
  return `[BB truncated ${omittedBytes.toLocaleString("en-US")} UTF-8 bytes]`;
}

export function boundedTimelineText(value: string, maxBytes: number) {
  const totalBytes = Buffer.byteLength(value);
  if (totalBytes <= maxBytes) return value;

  let marker = truncationMarker(totalBytes);
  const wrapperBytes = Buffer.byteLength("\n… ") + Buffer.byteLength(" …\n");
  let retained = Math.max(
    0,
    maxBytes - Buffer.byteLength(marker) - wrapperBytes,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = utf8Prefix(value, Math.floor(retained / 2));
    const tail = utf8Suffix(value, retained - Buffer.byteLength(head));
    marker = truncationMarker(
      totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail),
    );
    retained = Math.max(0, maxBytes - Buffer.byteLength(marker) - wrapperBytes);
  }
  const head = utf8Prefix(value, Math.floor(retained / 2));
  const tail = utf8Suffix(value, retained - Buffer.byteLength(head));
  return `${head}\n… ${truncationMarker(totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail))} …\n${tail}`;
}

type TimelineValueState = {
  nodes: number;
  entries: number;
  stringBytes: number;
};

function boundedTimelineValue(
  value: unknown,
  state: TimelineValueState,
  depth = 0,
): unknown {
  if (typeof value === "string")
    return boundedTimelineText(value, state.stringBytes);
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return value;
  if (value === undefined) return undefined;
  if (typeof value !== "object")
    return boundedTimelineText(String(value), state.stringBytes);
  if (
    depth >= MAX_TIMELINE_VALUE_DEPTH ||
    state.nodes >= MAX_TIMELINE_VALUE_NODES
  ) {
    return "[BB truncated nested provider data]";
  }
  state.nodes += 1;

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const entry of value.slice(0, MAX_TIMELINE_VALUE_ENTRIES)) {
      if (state.entries >= MAX_TIMELINE_VALUE_ENTRIES_TOTAL) break;
      state.entries += 1;
      result.push(boundedTimelineValue(entry, state, depth + 1));
    }
    if (value.length > result.length)
      result.push(
        `[BB truncated ${value.length - result.length} array entries]`,
      );
    return result;
  }

  const result: RecordValue = {};
  let retainedEntries = 0;
  let omittedProperties = false;
  for (const rawKey in value) {
    if (!Object.hasOwn(value, rawKey)) continue;
    if (
      retainedEntries >= MAX_TIMELINE_VALUE_ENTRIES ||
      state.entries >= MAX_TIMELINE_VALUE_ENTRIES_TOTAL
    ) {
      omittedProperties = true;
      break;
    }
    state.entries += 1;
    const baseKey = boundedTimelineText(rawKey, MAX_TIMELINE_KEY_BYTES);
    const key = Object.hasOwn(result, baseKey)
      ? `${baseKey}#${retainedEntries + 1}`
      : baseKey;
    result[key] = boundedTimelineValue(
      (value as RecordValue)[rawKey],
      state,
      depth + 1,
    );
    retainedEntries += 1;
  }
  if (omittedProperties) {
    result.__bb_truncated__ = "[BB truncated additional object properties]";
  }
  return result;
}

function serializedBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

export function boundedTimelineDelta(delta: RecordValue): RecordValue {
  const firstPass = boundedTimelineValue(delta, {
    nodes: 0,
    entries: 0,
    stringBytes: INITIAL_TIMELINE_STRING_BYTES,
  }) as RecordValue;
  if (serializedBytes(firstPass) <= MAX_TIMELINE_DELTA_BYTES) return firstPass;

  // A tool input can contain many independently large fields. Retain a short
  // preview of each field rather than dropping the tool result wholesale.
  return boundedTimelineValue(delta, {
    nodes: 0,
    entries: 0,
    stringBytes: FALLBACK_TIMELINE_STRING_BYTES,
  }) as RecordValue;
}

export function timelineDeltasForEmission(values: RecordValue[]) {
  return values.map((value) => {
    // OpenCode has no native turn IDs. Let BB own the current turn, as the
    // Claude bridge does. Explicit providerTurnId deltas bypass that current
    // turn in BB's assembler, so turn.mainRun would otherwise be ignored.
    const { providerTurnId: _providerTurnId, ...delta } = value;
    return boundedTimelineDelta(delta);
  });
}

export function itemKey(providerItemId: string, channel?: string) {
  return { providerItemId, ...(channel ? { channel } : {}) };
}

export function itemKeyForOpenItem(
  providerItemId: string,
  item: OpenCodeRecord,
) {
  const channel =
    item.type === "agentMessage"
      ? "agentMessage"
      : item.type === "reasoning"
        ? "reasoningText"
        : item.type === "compaction"
          ? "compaction"
          : "tool";
  return itemKey(providerItemId, channel);
}

export function isManualCompactionTurn(input: RecordValue[]) {
  return isStandaloneBuiltinCompactCommand(input as never);
}

export function manualCompactionRequest(sessionId: string, messageId: string) {
  return {
    path: `/api/session/${encodeURIComponent(sessionId)}/compact`,
    body: { id: messageId, delivery: "steer" as const },
  };
}

export function manualCompactionStartDeltas(
  clientRequestId: string,
  providerTurnId: string,
  messageId: string,
): RecordValue[] {
  const item = { type: "compaction" };
  return [
    { kind: "turn.open", providerTurnId },
    // turn.open first: see turn/start, BB drops input.accepted for turns it
    // hasn't started yet.
    { kind: "input.accepted", clientRequestId, providerTurnId },
    {
      kind: "item.open",
      key: itemKey(messageId, "compaction"),
      item,
      presentation: compactionPresentation,
      providerTurnId,
    },
  ];
}

export function manualCompactionOutcomeDeltas(input: {
  providerTurnId: string;
  messageId: string;
  status: "completed" | "failed" | "interrupted";
  error?: string;
}): RecordValue[] {
  const item = { type: "compaction" };
  return [
    {
      kind: "item.close",
      key: itemKey(input.messageId, "compaction"),
      status: input.status,
      item,
      presentation: compactionPresentation,
      providerTurnId: input.providerTurnId,
    },
    ...(input.status === "completed"
      ? [{ kind: "context.compacted", providerTurnId: input.providerTurnId }]
      : []),
    {
      kind: "turn.boundary",
      status: input.status,
      ...(input.error ? { error: { message: input.error } } : {}),
      providerTurnId: input.providerTurnId,
    },
  ];
}

export function providerFailureDeltas(input: {
  providerTurnId: string;
  error: string;
  providerCheckpointId?: string;
}): RecordValue[] {
  return [
    {
      kind: "provider.error",
      message: input.error,
      providerTurnId: input.providerTurnId,
    },
    {
      kind: "turn.boundary",
      status: "failed",
      error: { message: input.error },
      ...(input.providerCheckpointId
        ? { providerCheckpointId: input.providerCheckpointId }
        : {}),
      providerTurnId: input.providerTurnId,
    },
  ];
}
