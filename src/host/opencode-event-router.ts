import { experimental_COMPACTION_PRESENTATION as compactionPresentation } from "@get-bb/plugin-sdk/provider-bridge";
import { dynamicToolCallRouter, emit } from "./bridge-runtime.ts";
import {
  closeBackgroundActivity,
  openBackgroundActivity,
} from "./background-activity.ts";
import { OpenCodeInteractions } from "./opencode-interactions.ts";
import { toolFailureError } from "./prompt.ts";
import { dynamicMcpServerName, locationQuery } from "./opencode-requests.ts";
import {
  boundedTimelineText,
  itemKey,
  itemKeyForOpenItem,
  manualCompactionOutcomeDeltas,
  providerFailureDeltas,
} from "./timeline.ts";
import {
  contentText,
  dynamicToolRow,
  gitDiff,
  gitDiffNewFile,
  metadataFileChanges,
  toolRow,
  touchedPaths,
  workspacePath,
} from "./tool-mapping.ts";
import {
  inputRecord,
  parseInputText,
  sessionsByProviderId,
  stringValue,
  type ActiveTurn,
  type BackgroundNotification,
  type BackgroundTask,
  type OpenCodeRecord,
  type SessionState,
} from "./types.ts";

type RecordValue = OpenCodeRecord;

const SHELL_OUTPUT_POLL_MS = 400;
const SHELL_OUTPUT_CHUNK_BYTES = 32 * 1024;

type RequestOpenCode = (
  path: string,
  init?: RequestInit,
) => Promise<RecordValue>;

/**
 * OpenCode v2 reports a shell tool's exit status as `metadata.exit` on
 * `session.tool.success` (a non-zero exit is still a "success" event) and
 * appends "Exited with code N" to the content.
 */
export function shellExitCode(data: RecordValue): number | undefined {
  const candidates = [inputRecord(data.metadata).exit, data.exitCode];
  for (const value of candidates)
    if (typeof value === "number" && Number.isInteger(value)) return value;
  const match = contentText(data.content).match(/Exited with code (-?\d+)/);
  return match ? Number(match[1]) : undefined;
}

function sessionToolRow(session: SessionState, name: string, input: unknown) {
  return (
    (session.dynamicTools.length > 0
      ? dynamicToolRow(
          dynamicMcpServerName(session.providerThreadId),
          session.dynamicTools,
          name,
          input,
        )
      : undefined) ?? toolRow(name, input, session.cwd)
  );
}

function tokenCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function tokenBreakdown(raw: unknown) {
  const tokens = inputRecord(raw);
  const cache = inputRecord(tokens.cache);
  const breakdown = {
    inputTokens: tokenCount(tokens.input),
    outputTokens: tokenCount(tokens.output),
    reasoningOutputTokens: tokenCount(tokens.reasoning),
    cachedInputTokens: tokenCount(cache.read),
  };
  const cacheWrite = tokenCount(cache.write);
  return {
    breakdown: {
      ...breakdown,
      totalTokens:
        breakdown.inputTokens +
        breakdown.outputTokens +
        breakdown.reasoningOutputTokens +
        breakdown.cachedInputTokens +
        cacheWrite,
    },
    cacheWrite,
  };
}

/**
 * `session.usage.updated` carries OpenCode's cumulative session totals, so it
 * stays correct across resumes and workers. The latest step's tokens are the
 * last request's usage and approximate the live context size.
 */
export function usageDeltas(
  session: SessionState,
  active: ActiveTurn,
  totals: unknown,
): RecordValue[] {
  const total = tokenBreakdown(totals);
  const last = tokenBreakdown(active.lastStepTokens ?? {});
  session.usage = {
    input: total.breakdown.inputTokens,
    output: total.breakdown.outputTokens,
    reasoning: total.breakdown.reasoningOutputTokens,
    cacheRead: total.breakdown.cachedInputTokens,
    cacheWrite: total.cacheWrite,
  };
  const size = session.contextWindow ?? null;
  const used = active.lastStepTokens ? last.breakdown.totalTokens : null;
  return [
    {
      kind: "usage",
      total: total.breakdown,
      last: last.breakdown,
      modelContextWindow: size,
      providerTurnId: active.providerTurnId,
    },
    ...(used !== null
      ? [
          {
            kind: "contextWindow",
            used,
            size,
            estimated: false,
            attach: "currentOrLast",
            providerTurnId: active.providerTurnId,
          },
        ]
      : []),
  ];
}

function retryErrorCategory(error: RecordValue) {
  const text =
    `${stringValue(error.type) ?? ""} ${stringValue(error.message) ?? ""}`.toLowerCase();
  if (/rate.?limit|429|too many requests/.test(text)) return "rate-limit";
  if (/overload|529|503|unavailable/.test(text)) return "overloaded";
  if (/timeout|connection|network|econn|socket/.test(text))
    return "connection-failed";
  return undefined;
}

const CHILD_EVENT_PATTERN =
  /^(permission\.asked|session\.(?:(text|reasoning|tool)\.|inbox\.(enqueued|delivered)|synthetic$))/;

function backgroundKey(
  task: Pick<BackgroundTask, "sessionId" | "source" | "resourceId">,
) {
  return JSON.stringify([task.sessionId, task.source, task.resourceId]);
}

/** A successful execution may have handed work to a background job. */
export function hasPendingWork(active: ActiveTurn): boolean {
  return (
    (active.backgroundTasks?.size ?? 0) > 0 ||
    [...(active.backgroundNotifications?.values() ?? [])].some(
      (notification) => notification.matched && !notification.delivered,
    ) ||
    (active.pendingTools?.size ?? 0) > 0 ||
    [...(active.opened?.values() ?? [])].some(
      (item) =>
        !["agentMessage", "reasoning", "compaction"].includes(item.type),
    )
  );
}

/** The subagent's final report, without OpenCode's wrapper tag. */
export function subagentSummary(text: string): string {
  return text
    .replace(/^\s*<subagent\b[^>]*>\s*/, "")
    .replace(/\s*<\/subagent>\s*$/, "")
    .trim();
}

export class OpenCodeEventRouter {
  private readonly interactions: OpenCodeInteractions;
  private readonly emitTimeline: typeof emit;
  private readonly sessionLookup: ReadonlyMap<string, SessionState>;
  private readonly request: RequestOpenCode;
  /** Native subagent sessions, routed into their parent BB turn. */
  private readonly childSessions = new Map<
    string,
    { parent: SessionState; callId: string }
  >();
  /** Provider item ID -> the delegation call it is nested under. */
  private readonly parentRefs = new Map<string, string>();
  /** Set while handling a child-session event. */
  private childParentRef?: string;

  constructor(
    request: RequestOpenCode,
    emitTimeline: typeof emit = emit,
    sessionLookup: ReadonlyMap<string, SessionState> = sessionsByProviderId,
  ) {
    this.request = request;
    this.emitTimeline = emitTimeline;
    this.interactions = new OpenCodeInteractions(request, this.emit);
    this.sessionLookup = sessionLookup;
  }

  /**
   * Emit deltas, nesting items that belong to a native subagent under its
   * delegation row. An item first opened while handling a child-session
   * event records its parent; later deltas for it (output, close, turn-end
   * cleanup) reuse that parent wherever they are emitted from.
   */
  private readonly emit = (threadId: string, deltas: RecordValue[]) => {
    this.emitTimeline(
      threadId,
      deltas.map((delta) => {
        const key = inputRecord(delta.key);
        const id = stringValue(key.providerItemId);
        if (!id) return delta;
        if (
          delta.kind === "item.open" &&
          !key.parentRef &&
          this.childParentRef &&
          !this.parentRefs.has(id)
        )
          this.parentRefs.set(id, this.childParentRef);
        const parentRef = stringValue(key.parentRef) ?? this.parentRefs.get(id);
        return parentRef ? { ...delta, key: { ...key, parentRef } } : delta;
      }),
    );
  };

  async handleEvent(event: RecordValue): Promise<void> {
    const data = inputRecord(event.data);
    const sessionId = stringValue(data.sessionID);
    if (!sessionId) return;
    const session = this.sessionLookup.get(sessionId);
    if (session) return this.handleSessionEvent(session, event, data);
    const child = this.childSessions.get(sessionId);
    const type = stringValue(event.type) ?? "";
    const active = child?.parent.active;
    if (active && type === "session.execution.started") {
      (active.runningChildren ??= new Set()).add(sessionId);
      active.executionVersion = (active.executionVersion ?? 0) + 1;
      return;
    }
    if (
      active &&
      /^session\.execution\.(succeeded|failed|interrupted)$/.test(type)
    ) {
      active.runningChildren?.delete(sessionId);
      return;
    }
    // A subagent's own lifecycle, usage, and compaction belong to the child
    // session; only its visible work joins the parent turn.
    if (!child || !CHILD_EVENT_PATTERN.test(type)) return;
    this.childParentRef = child.callId;
    try {
      await this.handleSessionEvent(child.parent, event, data);
    } finally {
      this.childParentRef = undefined;
    }
  }

  private async handleSessionEvent(
    session: SessionState,
    event: RecordValue,
    data: RecordValue,
  ): Promise<void> {
    const active = session.active;
    if (event.type === "permission.asked") {
      void this.interactions.handlePermission(session, data);
      return;
    }
    if (!active) return;
    const createdAt =
      typeof event.created === "number" ? event.created : Date.now();
    const ownerSessionId =
      stringValue(data.sessionID) ?? session.providerThreadId;
    if (
      ownerSessionId === session.providerThreadId &&
      /^(session\.execution\.started|session\.(text|reasoning)\.|session\.tool\.(input\.|called))/.test(
        event.type,
      )
    )
      this.setMainRunState(session, "running");
    if (event.type === "session.inbox.enqueued") {
      const item = inputRecord(data.item);
      if (item.type === "synthetic")
        await this.backgroundNotification(
          session,
          active,
          ownerSessionId,
          inputRecord(item.payload),
          stringValue(data.inboxID),
          false,
          createdAt,
        );
      return;
    }
    if (event.type === "session.inbox.delivered") {
      for (const notification of active.backgroundNotifications?.values() ?? [])
        if (
          notification.sessionId === ownerSessionId &&
          notification.inboxId === data.inboxID
        )
          notification.delivered = true;
    }
    if (event.type === "session.synthetic") {
      await this.backgroundNotification(
        session,
        active,
        ownerSessionId,
        data,
        undefined,
        true,
        createdAt,
      );
      return;
    }
    const eventId = stringValue(data.id) ?? "";
    const eventType = stringValue(event.type) ?? "";
    if (eventType.startsWith("session.tool.") && !eventId) return;
    if (this.handleCompactionEvent(session, active, event.type, data)) return;
    const assistantMessageId = stringValue(data.assistantMessageID);
    const ordinal =
      typeof data.ordinal === "number" && Number.isSafeInteger(data.ordinal)
        ? data.ordinal
        : undefined;
    const textPartId =
      assistantMessageId && ordinal !== undefined
        ? `text:${assistantMessageId}:${ordinal}`
        : undefined;
    if (event.type === "session.text.started" && textPartId) {
      const item = { type: "agentMessage", text: "" };
      active.opened.set(textPartId, item);
      this.emit(session.bbThreadId, [
        {
          kind: "item.open",
          key: itemKey(textPartId, "agentMessage"),
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.text.delta" &&
      textPartId &&
      typeof data.delta === "string"
    ) {
      this.emit(session.bbThreadId, [
        {
          kind: "item.textDelta",
          key: itemKey(textPartId, "agentMessage"),
          channel: "agentMessage",
          text: data.delta,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.text.ended" &&
      textPartId &&
      typeof data.text === "string"
    ) {
      const item = active.opened.get(textPartId) ?? {
        type: "agentMessage",
        text: data.text,
      };
      item.text = data.text;
      active.opened.delete(textPartId);
      this.emit(session.bbThreadId, [
        {
          kind: "item.textClose",
          key: itemKey(textPartId, "agentMessage"),
          channel: "agentMessage",
          text: data.text,
          providerTurnId: active.providerTurnId,
        },
        {
          kind: "item.close",
          key: itemKey(textPartId, "agentMessage"),
          status: "completed",
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    const reasoningPartId =
      assistantMessageId && ordinal !== undefined
        ? `reasoning:${assistantMessageId}:${ordinal}`
        : undefined;
    if (event.type === "session.reasoning.started" && reasoningPartId) {
      const item = { type: "reasoning", summary: [], content: [] };
      active.opened.set(reasoningPartId, item);
      this.emit(session.bbThreadId, [
        {
          kind: "item.open",
          key: itemKey(reasoningPartId, "reasoningText"),
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.reasoning.delta" &&
      reasoningPartId &&
      typeof data.delta === "string"
    ) {
      this.emit(session.bbThreadId, [
        {
          kind: "item.textDelta",
          key: itemKey(reasoningPartId, "reasoningText"),
          channel: "reasoningText",
          text: data.delta,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.reasoning.ended" &&
      reasoningPartId &&
      typeof data.text === "string"
    ) {
      const item = active.opened.get(reasoningPartId) ?? {
        type: "reasoning",
        summary: [],
        content: [],
      };
      item.content = [data.text];
      active.opened.delete(reasoningPartId);
      this.emit(session.bbThreadId, [
        {
          kind: "item.textClose",
          key: itemKey(reasoningPartId, "reasoningText"),
          channel: "reasoningText",
          text: data.text,
          providerTurnId: active.providerTurnId,
        },
        {
          kind: "item.close",
          key: itemKey(reasoningPartId, "reasoningText"),
          status: "completed",
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (event.type === "session.tool.input.started") {
      const toolName = stringValue(data.name);
      if (eventId && toolName) active.pendingTools.set(eventId, toolName);
    }
    if (event.type === "session.tool.input.ended") {
      if (eventId && typeof data.text === "string")
        active.pendingInput.set(eventId, data.text);
    }
    if (event.type === "session.tool.called") {
      const name = active.pendingTools.get(eventId);
      if (name) {
        (active.toolStartedAt ??= new Map()).set(eventId, createdAt);
        const input = inputRecord(
          data.input ?? parseInputText(active.pendingInput.get(eventId)),
        );
        const row = sessionToolRow(session, name, input);
        const description = stringValue(input.description);
        if (description)
          (active.toolDescriptions ??= new Map()).set(eventId, description);
        if (row.item.type === "delegation")
          (row.item as RecordValue).childRef = eventId;
        active.opened.set(eventId, row.item);
        const touched = touchedPaths(name, input);
        if (touched.length) active.touchedFiles.set(eventId, touched);
        active.pendingTools.delete(eventId);
        active.pendingInput.delete(eventId);
        this.emit(session.bbThreadId, [
          {
            kind: "item.open",
            key: itemKey(eventId, "tool"),
            item: row.item,
            presentation: row.presentation,
            providerTurnId: active.providerTurnId,
          },
        ]);
        // OpenCode's question tool blocks forever waiting on an interactive
        // form that no TUI will answer in a BB thread. Relay it to BB's
        // native question UI instead (see handleQuestion).
        if (name.toLowerCase() === "question") {
          void this.interactions
            .handleQuestion(session, active, eventId)
            .catch(() => {});
        }
      } else {
        const item = active.opened.get(eventId);
        if (item) item.args = data.input;
      }
    }
    if (event.type === "session.tool.progress") {
      const childId = stringValue(inputRecord(data.metadata).sessionID);
      const opened = active.opened.get(eventId);
      if (childId && opened?.type === "delegation") {
        opened.childRef = childId;
        this.childSessions.set(childId, { parent: session, callId: eventId });
      }
      const shellId = stringValue(inputRecord(data.metadata).shellID);
      if (shellId && active.opened.get(eventId)?.type === "command")
        this.streamShellOutput(session, active, eventId, shellId);
    }
    if (
      event.type === "session.tool.success" ||
      event.type === "session.tool.failed"
    ) {
      active.finishedTools ??= new Set();
      if (active.finishedTools.has(eventId)) return;
      // handleQuestion may already have closed + answered this call.
      if (active.settledTools.has(eventId)) {
        this.stopShellOutput(active, eventId);
        active.finishedTools.add(eventId);
        active.toolStartedAt?.delete(eventId);
        active.settledTools.delete(eventId);
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
        active.pendingTools.delete(eventId);
        return;
      }
      const name =
        active.pendingTools.get(eventId) ??
        stringValue(data.name) ??
        "OpenCode tool";
      const input = inputRecord(
        data.input ?? parseInputText(active.pendingInput.get(eventId)),
      );
      let item = active.opened.get(eventId);
      if (!item) {
        const row = sessionToolRow(session, name, input);
        if (row.item.type === "delegation")
          (row.item as RecordValue).childRef = eventId;
        item = row.item;
        active.opened.set(eventId, item);
        const touched = touchedPaths(name, input);
        if (touched.length) active.touchedFiles.set(eventId, touched);
        active.pendingTools.delete(eventId);
        active.pendingInput.delete(eventId);
        this.emit(session.bbThreadId, [
          {
            kind: "item.open",
            key: itemKey(eventId, "tool"),
            item,
            presentation: row.presentation,
            providerTurnId: active.providerTurnId,
          },
        ]);
      }
      const metadata = inputRecord(data.metadata);
      const resourceId =
        item.type === "command"
          ? stringValue(metadata.shellID)
          : item.type === "delegation"
            ? stringValue(metadata.sessionID)
            : undefined;
      if (
        event.type === "session.tool.success" &&
        metadata.status === "running" &&
        resourceId
      ) {
        const task: BackgroundTask = {
          sessionId: ownerSessionId,
          source: item.type === "command" ? "shell" : "subagent",
          resourceId,
          startedAt: active.toolStartedAt?.get(eventId) ?? active.startedAt,
        };
        (active.backgroundTasks ??= new Map()).set(eventId, task);
        this.emit(
          session.bbThreadId,
          openBackgroundActivity(active, eventId, task, item, input),
        );
        if (task.source === "subagent") {
          item.background = true;
          item.childRef = resourceId;
          this.childSessions.set(resourceId, {
            parent: session,
            callId: eventId,
          });
        }
        const notification = active.backgroundNotifications?.get(
          backgroundKey(task),
        );
        if (notification && notification.startedAt >= task.startedAt)
          await this.completeBackgroundTask(
            session,
            active,
            eventId,
            task,
            notification,
          );
        return;
      }
      this.stopShellOutput(active, eventId);
      active.finishedTools.add(eventId);
      active.toolStartedAt?.delete(eventId);
      active.backgroundTasks?.delete(eventId);
      const output = contentText(data.content);
      const failed =
        event.type === "session.tool.failed" ||
        (item.type === "command" && (shellExitCode(data) ?? 0) !== 0);
      this.emit(
        session.bbThreadId,
        closeBackgroundActivity(
          active,
          eventId,
          inputRecord(data.metadata).state === "cancelled"
            ? "interrupted"
            : failed
              ? "failed"
              : "completed",
          output || stringValue(inputRecord(data.error).message),
        ),
      );
      active.toolDescriptions?.delete(eventId);
      if (item.type === "delegation") {
        item.summary =
          event.type === "session.tool.success"
            ? subagentSummary(output)
            : toolFailureError(
                name,
                session.disableSubagents,
                stringValue(inputRecord(data.error).message),
              );
        if (!item.summary) delete item.summary;
        const childId = stringValue(inputRecord(data.metadata).sessionID);
        if (childId) item.childRef = childId;
      } else if (item.type === "tool") {
        if (event.type === "session.tool.success") item.result = output;
        else {
          const error = inputRecord(data.error);
          item.error = toolFailureError(
            name,
            session.disableSubagents,
            stringValue(error.message),
          );
        }
      } else if (item.type === "command") {
        const error = inputRecord(data.error);
        item.aggregatedOutput =
          event.type === "session.tool.success"
            ? output
            : (stringValue(error.message) ?? "OpenCode tool failed");
        const exitCode = shellExitCode(data);
        item.exitCode =
          event.type === "session.tool.success"
            ? (exitCode ?? 0)
            : (exitCode ?? 1);
      }
      active.opened.delete(eventId);
      this.emit(session.bbThreadId, [
        {
          kind: "item.close",
          key: itemKey(eventId, "tool"),
          status:
            event.type.endsWith("failed") ||
            (item.type === "command" && item.exitCode !== 0)
              ? "failed"
              : "completed",
          ...(item.type === "tool" && item.result
            ? { resultText: item.result }
            : {}),
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
      if (event.type === "session.tool.success") {
        const touched =
          active.touchedFiles.get(eventId) ?? touchedPaths(name, input);
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
        const patched = metadataFileChanges(data.metadata, session.cwd);
        if (patched.length) {
          this.emitFileChangeRow(session, active, `files:${eventId}`, patched);
        } else if (touched.length) {
          await this.emitFileChanges(
            session,
            active,
            `files:${eventId}`,
            touched,
          );
        }
      } else {
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
      }
    }
    if (
      event.type === "session.step.ended" ||
      event.type === "session.step.failed"
    ) {
      if (data.tokens !== undefined)
        active.lastStepTokens = inputRecord(data.tokens);
    }
    if (event.type === "session.usage.updated") {
      this.emit(session.bbThreadId, usageDeltas(session, active, data.tokens));
    }
    if (event.type === "session.retry.scheduled") {
      const error = inputRecord(data.error);
      const attempt =
        typeof data.attempt === "number" ? ` (attempt ${data.attempt})` : "";
      const category = retryErrorCategory(error);
      this.emit(session.bbThreadId, [
        {
          kind: "provider.error",
          message: `${stringValue(error.message) ?? "OpenCode model request failed"}. Retrying${attempt}.`,
          willRetry: true,
          ...(category ? { category } : {}),
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.inbox.delivered" &&
      active.promptIds?.has(stringValue(data.inboxID) ?? "")
    )
      active.inputDelivered = true;
    if (
      eventType.startsWith("session.execution.") &&
      active.promptIds?.size &&
      !active.inputDelivered
    )
      return;
    if (event.type === "session.execution.started")
      active.executionVersion = (active.executionVersion ?? 0) + 1;
    if (event.type === "session.execution.succeeded") {
      if (!hasPendingWork(active) && !active.runningChildren?.size)
        this.finish(session, "completed");
      else this.setMainRunState(session, "idle");
    }
    if (event.type === "session.execution.interrupted")
      this.finish(session, "interrupted");
    if (event.type === "session.execution.failed") {
      const error = inputRecord(data.error);
      this.finish(
        session,
        "failed",
        stringValue(error.message) ?? "OpenCode execution failed",
      );
    }
  }

  setMainRunState(session: SessionState, state: "idle" | "running") {
    const active = session.active;
    const idle = state === "idle";
    if (!active || (active.mainRunIdle ?? false) === idle) return;
    active.mainRunIdle = idle;
    this.emit(session.bbThreadId, [{ kind: "turn.mainRun", state }]);
  }

  private async backgroundNotification(
    session: SessionState,
    active: ActiveTurn,
    sessionId: string,
    payload: RecordValue,
    inboxId: string | undefined,
    delivered: boolean,
    createdAt = Date.now(),
  ) {
    const metadata = inputRecord(payload.metadata);
    const source = metadata.source;
    const resourceId =
      source === "shell"
        ? stringValue(metadata.shellID)
        : source === "subagent"
          ? stringValue(metadata.childID)
          : undefined;
    if (
      !resourceId ||
      !["completed", "error", "cancelled"].includes(metadata.state)
    )
      return;
    const notification: BackgroundNotification = {
      sessionId,
      source,
      resourceId,
      startedAt: createdAt,
      payload,
      inboxId,
      delivered,
    };
    const key = backgroundKey(notification);
    const previous = active.backgroundNotifications?.get(key);
    // A repeated child session can have several background runs in one turn.
    if (
      previous &&
      previous.startedAt > createdAt &&
      previous.inboxId !== inboxId
    )
      return;
    if (previous?.inboxId === inboxId || inboxId === undefined) {
      notification.delivered ||= previous?.delivered ?? false;
      notification.inboxId ??= previous?.inboxId;
      notification.matched = previous?.matched;
    }
    (active.backgroundNotifications ??= new Map()).set(key, notification);
    for (const [callId, task] of active.backgroundTasks ?? []) {
      if (session.active !== active) return;
      if (backgroundKey(task) === key && createdAt >= task.startedAt)
        await this.completeBackgroundTask(
          session,
          active,
          callId,
          task,
          notification,
        );
    }
  }

  private async completeBackgroundTask(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
    task: BackgroundTask,
    notification: BackgroundNotification,
  ) {
    if (session.active !== active) return;
    notification.matched = true;
    const metadata = inputRecord(notification.payload.metadata);
    const failed = metadata.state !== "completed";
    const text =
      stringValue(notification.payload.text) ?? "Background task finished";
    const event = {
      type: failed ? "session.tool.failed" : "session.tool.success",
      created: notification.startedAt,
      data: {
        sessionID: task.sessionId,
        id: callId,
        name: task.source,
        content: [{ type: "text", text }],
        ...(failed ? { error: { message: text } } : {}),
        metadata: {
          ...metadata,
          status: metadata.state,
          ...(task.source === "subagent" ? { sessionID: task.resourceId } : {}),
        },
      },
    };
    // The original row already carries its parentRef. Do not re-enter the
    // child-session dispatcher (which would reset an outer child context).
    await this.handleSessionEvent(session, event, event.data);
  }

  hasRunningExecution(session: SessionState, running: RecordValue): boolean {
    return (
      session.providerThreadId in running ||
      [...this.childSessions].some(
        ([id, child]) => child.parent === session && id in running,
      )
    );
  }

  async backgroundNotificationsSettled(
    session: SessionState,
    parentIdle: unknown,
    settleBefore: number,
  ): Promise<boolean> {
    const active = session.active;
    if (!active) return false;
    const latestByOwner = new Map<string, number>();
    for (const notification of active.backgroundNotifications?.values() ?? []) {
      if (!notification.matched) continue;
      latestByOwner.set(
        notification.sessionId,
        Math.max(
          latestByOwner.get(notification.sessionId) ?? 0,
          notification.startedAt,
        ),
      );
    }
    for (const [owner, createdAt] of latestByOwner) {
      let idle = parentIdle;
      if (owner !== session.providerThreadId) {
        try {
          const result = await this.request(
            `/api/session/${encodeURIComponent(owner)}`,
          );
          idle = inputRecord(inputRecord(result.data).time).idle;
        } catch (error) {
          if (/OpenCode API 404:/.test(String(error))) continue;
          throw error;
        }
      }
      if (
        session.active !== active ||
        typeof idle !== "number" ||
        idle < createdAt ||
        idle > settleBefore
      )
        return false;
    }
    return true;
  }

  /** Recover durable completion notifications missed by the live-only stream. */
  async reconcileBackgroundWork(session: SessionState): Promise<void> {
    const active = session.active;
    if (!active || !hasPendingWork(active)) return;
    const owners = new Set([
      session.providerThreadId,
      ...[...this.childSessions]
        .filter(([, child]) => child.parent === session)
        .map(([id]) => id),
      ...[...(active.backgroundTasks?.values() ?? [])].map(
        (task) => task.sessionId,
      ),
      ...[...(active.backgroundNotifications?.values() ?? [])].map(
        (notification) => notification.sessionId,
      ),
    ]);
    for (const sessionId of owners) {
      try {
        const path = `/api/session/${encodeURIComponent(sessionId)}`;
        const inbox = await this.request(`${path}/inbox`);
        if (session.active !== active) return;
        for (const raw of Array.isArray(inbox.data) ? inbox.data : []) {
          const entry = inputRecord(raw);
          if (entry.type !== "synthetic") continue;
          await this.backgroundNotification(
            session,
            active,
            sessionId,
            inputRecord(entry.payload),
            stringValue(entry.id),
            false,
            typeof inputRecord(entry.time).created === "number"
              ? entry.time.created
              : Date.now(),
          );
        }
        let cursor: string | undefined;
        while (session.active === active) {
          const query = new URLSearchParams({ limit: "100" });
          if (cursor) query.set("cursor", cursor);
          else query.set("order", "desc");
          const result = await this.request(`${path}/message?${query}`);
          if (session.active !== active) return;
          const messages = (Array.isArray(result.data) ? result.data : []).map(
            inputRecord,
          );
          if (!messages.length) break;
          for (const message of messages) {
            const createdAt = inputRecord(message.time).created;
            if (typeof createdAt !== "number" || createdAt < active.startedAt)
              continue;
            if (message.type === "assistant") {
              for (const raw of Array.isArray(message.content)
                ? message.content
                : []) {
                const tool = inputRecord(raw);
                const state = inputRecord(tool.state);
                if (
                  tool.type !== "tool" ||
                  !active.opened.has(tool.id) ||
                  !["completed", "error"].includes(state.status)
                )
                  continue;
                await this.handleEvent({
                  type:
                    state.status === "completed"
                      ? "session.tool.success"
                      : "session.tool.failed",
                  data: {
                    sessionID: sessionId,
                    id: tool.id,
                    name: tool.name,
                    ...state,
                  },
                });
              }
            }
            if (message.type !== "synthetic") continue;
            await this.backgroundNotification(
              session,
              active,
              sessionId,
              message,
              stringValue(message.id),
              true,
              createdAt,
            );
          }
          // The first page is newest first; do not scan earlier turns.
          if (
            messages.some(
              (message) => inputRecord(message.time).created < active.startedAt,
            )
          )
            break;
          const next = stringValue(inputRecord(result.cursor).next);
          if (!next || next === cursor) break;
          cursor = next;
        }
      } catch (error) {
        // A removed child must not prevent recovery of the parent or other
        // threads. Keep unresolved work pending until its parent reports it.
        if (
          sessionId === session.providerThreadId ||
          !/OpenCode API 404:/.test(String(error))
        )
          throw error;
      }
    }
  }

  private handleCompactionEvent(
    session: SessionState,
    active: ActiveTurn,
    type: unknown,
    data: RecordValue,
  ) {
    const eventType = stringValue(type);
    if (!eventType) return false;
    const message = inputRecord(data.message ?? data.info);
    const messageId = stringValue(
      data.messageID ?? data.messageId ?? data.id ?? message.id,
    );
    const reason = stringValue(data.reason ?? message.reason);
    const status = stringValue(data.status ?? message.status);
    const itemId = messageId ?? active.manualCompaction?.itemId;
    const isStarted =
      eventType === "session.next.compaction.started" ||
      eventType === "session.compaction.started" ||
      (eventType === "session.message.updated" &&
        status === "running" &&
        message.type === "compaction");
    const isCompleted =
      eventType === "session.next.compaction.ended" ||
      eventType === "session.compaction.ended" ||
      eventType === "session.compacted" ||
      (eventType === "session.message.updated" &&
        status === "completed" &&
        message.type === "compaction");
    const isFailed =
      eventType === "session.compaction.failed" ||
      (eventType === "session.message.updated" &&
        status === "failed" &&
        message.type === "compaction");
    if (!isStarted && !isCompleted && !isFailed) return false;

    if (isStarted) {
      if (itemId && !active.opened.has(itemId)) {
        const item = { type: "compaction" };
        active.opened.set(itemId, item);
        this.emit(session.bbThreadId, [
          {
            kind: "item.open",
            key: itemKey(itemId, "compaction"),
            item,
            presentation: compactionPresentation,
            providerTurnId: active.providerTurnId,
          },
        ]);
      }
      return true;
    }

    const error =
      stringValue(
        data.error?.message ??
          data.error ??
          message.error?.message ??
          message.error,
      ) ?? "OpenCode context compaction failed";
    const manualCompaction = active.manualCompaction;
    const manual =
      manualCompaction !== undefined &&
      (itemId === manualCompaction.itemId ||
        reason === "manual" ||
        eventType === "session.compacted");
    if (manual && manualCompaction) {
      active.opened.delete(manualCompaction.itemId);
      this.emit(
        session.bbThreadId,
        manualCompactionOutcomeDeltas({
          providerTurnId: active.providerTurnId,
          messageId: manualCompaction.itemId,
          status: isCompleted ? "completed" : "failed",
          ...(isFailed ? { error } : {}),
        }),
      );
      active.openQuestions.clear();
      active.settledTools.clear();
      active.pendingTools.clear();
      active.pendingInput.clear();
      active.touchedFiles.clear();
      active.abortController.abort();
      session.active = undefined;
      return true;
    }

    if (itemId) {
      const item = active.opened.get(itemId);
      if (item) {
        active.opened.delete(itemId);
        this.emit(session.bbThreadId, [
          {
            kind: "item.close",
            key: itemKey(itemId, "compaction"),
            status: isCompleted ? "completed" : "failed",
            item,
            presentation: compactionPresentation,
            providerTurnId: active.providerTurnId,
          },
        ]);
      }
    }
    if (isCompleted)
      this.emit(session.bbThreadId, [
        { kind: "context.compacted", providerTurnId: active.providerTurnId },
      ]);
    return true;
  }

  /**
   * OpenCode v2 runs shell tools as background shells and only reports their
   * output when the tool finishes. Poll the shell's byte-cursor output API so
   * BB's command row streams like a local terminal.
   */
  private streamShellOutput(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
    shellId: string,
  ) {
    active.shellPolls ??= new Map();
    if (active.shellPolls.has(callId)) return;
    const poll = { stopped: false };
    active.shellPolls.set(callId, poll);
    void (async () => {
      let cursor = 0;
      while (!poll.stopped && session.active === active) {
        try {
          const result = await this.request(
            `/api/shell/${encodeURIComponent(shellId)}/output?${locationQuery(session.cwd)}&cursor=${cursor}`,
            { signal: active.abortController.signal },
          );
          const output = inputRecord(result.data);
          if (
            !poll.stopped &&
            session.active === active &&
            typeof output.output === "string" &&
            output.output.length > 0
          ) {
            this.emit(session.bbThreadId, [
              {
                kind: "item.outputDelta",
                key: itemKey(callId, "tool"),
                channel: "command",
                text: boundedTimelineText(
                  output.output,
                  SHELL_OUTPUT_CHUNK_BYTES,
                ),
                providerTurnId: active.providerTurnId,
              },
            ]);
          }
          if (typeof output.cursor === "number") cursor = output.cursor;
        } catch {
          // The shell is gone (finished and cleaned up) or the turn ended.
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, SHELL_OUTPUT_POLL_MS),
        );
      }
    })();
  }

  private stopShellOutput(active: ActiveTurn, callId: string) {
    const poll = active.shellPolls?.get(callId);
    if (!poll) return;
    poll.stopped = true;
    active.shellPolls?.delete(callId);
  }

  private async emitFileChanges(
    session: SessionState,
    active: ActiveTurn,
    key: string,
    paths: string[],
  ): Promise<void> {
    // OpenCode's step.ended carries no file list, and write/edit rows are
    // suppressed, so render the change from the tool input recorded at call
    // time. The event reader awaits this method to preserve delta ordering.
    const changes = await Promise.all(
      paths.map(async (touched) => {
        const file = workspacePath(session.cwd, touched);
        const diff = await gitDiff(session.cwd, file);
        if (diff) return { path: file, kind: "update", diff };
        // An untracked new file has no `git diff`; show its whole content.
        const added = await gitDiffNewFile(session.cwd, file);
        return added
          ? { path: file, kind: "add", diff: added }
          : { path: file, kind: "update" };
      }),
    );
    this.emitFileChangeRow(session, active, key, changes);
  }

  private emitFileChangeRow(
    session: SessionState,
    active: ActiveTurn,
    key: string,
    changes: RecordValue[],
  ) {
    if (session.active !== active) return;
    for (const change of changes)
      if (typeof change.diff === "string" && change.diff)
        (active.turnPatches ??= []).push(change.diff);
    const item = { type: "fileChange", changes };
    this.emit(session.bbThreadId, [
      {
        kind: "item.open",
        key: itemKey(key, "fileChange"),
        item,
        providerTurnId: active.providerTurnId,
      },
      {
        kind: "item.close",
        key: itemKey(key, "fileChange"),
        status: "completed",
        item,
        providerTurnId: active.providerTurnId,
      },
    ]);
  }

  finish(
    session: SessionState,
    status: "completed" | "interrupted" | "failed",
    error?: string,
  ) {
    const active = session.active;
    if (!active) return;
    active.abortController.abort();
    if (active.manualCompaction) {
      this.emit(
        session.bbThreadId,
        manualCompactionOutcomeDeltas({
          providerTurnId: active.providerTurnId,
          messageId: active.manualCompaction.itemId,
          status,
          ...(error ? { error } : {}),
        }),
      );
      session.active = undefined;
      return;
    }
    for (const [childId, child] of this.childSessions)
      if (child.parent === session) this.childSessions.delete(childId);
    for (const poll of active.shellPolls?.values() ?? []) poll.stopped = true;
    active.shellPolls?.clear();
    dynamicToolCallRouter.resolve(
      session.dynamicToolScope,
      "OpenCode turn ended before the BB tool returned",
    );
    for (const [, formId] of active.openQuestions)
      void this.interactions.cancelQuestionForm(session, formId);
    for (const callId of active.backgroundItems?.keys() ?? [])
      this.emit(
        session.bbThreadId,
        closeBackgroundActivity(active, callId, status, error),
      );
    for (const [id, item] of active.opened) {
      this.emit(session.bbThreadId, [
        {
          kind: "item.close",
          key: itemKeyForOpenItem(id, item),
          status,
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    for (const id of active.opened.keys()) this.parentRefs.delete(id);
    active.opened.clear();
    active.openQuestions.clear();
    active.settledTools.clear();
    active.pendingTools.clear();
    active.pendingInput.clear();
    active.toolStartedAt?.clear();
    active.toolDescriptions?.clear();
    active.backgroundTasks?.clear();
    active.backgroundNotifications?.clear();
    active.runningChildren?.clear();
    active.touchedFiles.clear();
    // OpenCode's session diff endpoint needs snapshots that are often off,
    // so the turn diff is the sequence of patches its edit tools reported.
    if (active.turnPatches?.length)
      this.emit(session.bbThreadId, [
        {
          kind: "turn.diff",
          diff: active.turnPatches
            .map((patch) => (patch.endsWith("\n") ? patch : `${patch}\n`))
            .join(""),
          providerTurnId: active.providerTurnId,
        },
      ]);
    if (status === "failed") {
      this.emit(
        session.bbThreadId,
        providerFailureDeltas({
          providerTurnId: active.providerTurnId,
          error: error ?? "OpenCode execution failed",
          ...(active.checkpointId
            ? { providerCheckpointId: active.checkpointId }
            : {}),
        }),
      );
    } else {
      this.emit(session.bbThreadId, [
        {
          kind: "turn.boundary",
          status,
          ...(active.checkpointId
            ? { providerCheckpointId: active.checkpointId }
            : {}),
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    session.active = undefined;
  }
}
