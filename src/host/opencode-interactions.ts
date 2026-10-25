import {
  experimental_presentationDetail as presentationDetail,
  experimental_presentationTitle as presentationTitle,
} from "@get-bb/plugin-sdk/provider-bridge";
import { emit, requestRuntime } from "./bridge-runtime.ts";
import {
  approvalPermissionReply,
  automaticPermissionReply,
  permissionReplyBody,
} from "./prompt.ts";
import { itemKey } from "./timeline.ts";
import {
  errorMessage,
  inputRecord,
  stringValue,
  type ActiveTurn,
  type OpenCodePermissionReply,
  type OpenCodeRecord,
  type SessionState,
} from "./types.ts";

type RecordValue = OpenCodeRecord;
type RequestOpenCode = (
  path: string,
  init?: RequestInit,
) => Promise<RecordValue>;

export class OpenCodeInteractions {
  constructor(
    private readonly request: RequestOpenCode,
    private readonly emitTimeline: typeof emit = emit,
    private readonly requestInteraction: (
      method: string,
      params: RecordValue,
      options?: { signal?: AbortSignal },
    ) => Promise<RecordValue> = requestRuntime,
  ) {}

  /**
   * Never rejects: a reply can 404 when the request was already answered
   * elsewhere (another client, or OpenCode cancelled it), and an unhandled
   * rejection would take the whole bridge process down.
   */
  async handlePermission(session: SessionState, data: RecordValue) {
    try {
      await this.resolvePermission(session, data);
    } catch (error) {
      process.stderr.write(
        `[opencode2] Could not answer an OpenCode permission request: ${errorMessage(error)}\n`,
      );
    }
  }

  private async resolvePermission(session: SessionState, data: RecordValue) {
    const active = session.active;
    if (!active) return;
    const sessionId = stringValue(data.sessionID);
    const requestId = stringValue(data.id);
    if (!sessionId || !requestId) return;
    const action = stringValue(data.action) ?? "";
    const automaticReply = automaticPermissionReply(
      session.permissionMode,
      session.disableSubagents,
      action,
    );
    if (automaticReply) {
      await this.replyPermission(sessionId, requestId, automaticReply);
      return;
    }
    const tool = action || "OpenCode permission";
    const message = stringValue(data.message);
    const source = inputRecord(data.source);
    const payload = {
      kind: "approval",
      subject: {
        kind: "tool_use",
        itemId: stringValue(source.id) ?? requestId,
        tool,
        presentation: {
          label: {
            pending: "Requesting permission",
            completed: "Permission handled",
          },
          icon: { glyph: "Shield" },
          ...(presentationTitle(tool)
            ? { title: presentationTitle(tool) }
            : {}),
          ...(message ? { detail: presentationDetail(message) } : {}),
        },
      },
      reason: message ?? null,
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    };
    try {
      const result = await this.requestInteraction(
        "interaction/request",
        {
          providerThreadId: session.providerThreadId,
          threadId: session.bbThreadId,
          turnId: null,
          providerNativeIds: true,
          payload,
        },
        { signal: active.abortController.signal },
      );
      const decision = result?.decision;
      const reply =
        session.active === active
          ? approvalPermissionReply(decision)
          : "reject";
      await this.replyPermission(sessionId, requestId, reply);
    } catch (error) {
      await this.replyPermission(sessionId, requestId, "reject").catch(
        () => {},
      );
      throw error;
    }
  }

  private async replyPermission(
    sessionId: string,
    requestId: string,
    decision: OpenCodePermissionReply,
  ) {
    await this.request(
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify(permissionReplyBody(decision)),
      },
    );
  }

  private async questionForm(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
  ): Promise<RecordValue | undefined> {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (session.active !== active || !active.opened.has(callId))
        return undefined;
      const result = await this.request(
        `/api/session/${encodeURIComponent(session.providerThreadId)}/form`,
      ).catch(() => undefined);
      const forms = (Array.isArray(result?.data) ? result.data : []).map(
        inputRecord,
      );
      const match = forms.find((form) => {
        const metadata = inputRecord(form.metadata);
        const tool = inputRecord(metadata.tool);
        return tool.id === callId;
      });
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return undefined;
  }

  async cancelQuestionForm(session: SessionState, formId: string) {
    await this.request(
      `/api/session/${encodeURIComponent(session.providerThreadId)}/form/${encodeURIComponent(formId)}`,
      { method: "DELETE" },
    ).catch(() => {});
  }

  private closeQuestion(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
    status: "completed" | "failed",
    text: string,
  ) {
    if (session.active !== active) return;
    const item = active.opened.get(callId) ?? {
      type: "tool",
      tool: "question",
      args: {},
    };
    if (status === "completed") item.result = text;
    else item.error = text;
    active.opened.delete(callId);
    active.openQuestions.delete(callId);
    active.settledTools.add(callId);
    this.emitTimeline(session.bbThreadId, [
      {
        kind: "item.close",
        key: itemKey(callId, "tool"),
        status,
        ...(status === "completed" ? { resultText: text } : {}),
        item,
        providerTurnId: active.providerTurnId,
      },
    ]);
  }

  async handleQuestion(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
  ) {
    const form = await this.questionForm(session, active, callId);
    if (session.active !== active || !active.opened.has(callId)) return;
    if (!form) {
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        "OpenCode question went unanswered (no prompt received)",
      );
      return;
    }
    const formId = stringValue(form.id);
    if (!formId) {
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        "OpenCode question did not include a form ID",
      );
      return;
    }
    active.openQuestions.set(callId, formId);
    const fields = (Array.isArray(form.fields) ? form.fields : [])
      .slice(0, 4)
      .map(inputRecord);
    if (!fields.length) {
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        "OpenCode question had no prompts",
      );
      return;
    }
    const questions = fields.map((field) => {
      const key = String(field.key ?? field.title ?? "q");
      const fieldType = stringValue(field.type);
      const options = Array.isArray(field.options)
        ? field.options.slice(0, 4).map((value: unknown) => {
            const option = inputRecord(value);
            return {
              label: stringValue(option.label) ?? String(option.value ?? ""),
              value: String(option.value ?? option.label ?? ""),
              ...(stringValue(option.description)
                ? { description: stringValue(option.description) }
                : {}),
            };
          })
        : undefined;
      return {
        id: key,
        prompt:
          stringValue(field.description) ??
          stringValue(field.title) ??
          "Question",
        ...(stringValue(field.title)
          ? { shortLabel: stringValue(field.title) }
          : {}),
        multiSelect: fieldType === "multiselect",
        allowFreeText: field.custom !== false,
        ...(options?.length ? { options } : {}),
      };
    });
    let resolution: RecordValue | undefined;
    try {
      resolution = await this.requestInteraction(
        "interaction/request",
        {
          providerThreadId: session.providerThreadId,
          threadId: session.bbThreadId,
          turnId: null,
          providerNativeIds: true,
          payload: { kind: "user_question", questions },
        },
        { signal: active.abortController.signal },
      );
    } catch (error) {
      if (session.active !== active || !active.opened.has(callId)) return;
      await this.cancelQuestionForm(session, formId);
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        `Could not request an answer from BB: ${errorMessage(error)}`,
      );
      return;
    }
    if (session.active !== active || !active.opened.has(callId)) return;
    const answers: RecordValue | undefined =
      resolution?.kind === "user_answer" ? resolution.answers : undefined;
    if (!answers) {
      await this.cancelQuestionForm(session, formId);
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        "Question dismissed",
      );
      return;
    }
    const answer: RecordValue = {};
    const summary: string[] = [];
    for (const field of fields) {
      const key = String(field.key ?? field.title ?? "q");
      const fieldType = stringValue(field.type);
      const entry: RecordValue = answers[key] ?? {};
      const selected: unknown[] = Array.isArray(entry.selected)
        ? entry.selected
        : [];
      const freeText = stringValue(entry.freeText);
      if (fieldType === "multiselect") {
        const values = [
          ...(freeText ? [freeText] : []),
          ...selected.map(String).filter((value) => value.length > 0),
        ];
        if (!values.length) {
          await this.cancelQuestionForm(session, formId);
          this.closeQuestion(
            session,
            active,
            callId,
            "failed",
            "Question dismissed",
          );
          return;
        }
        answer[key] = values;
        summary.push(values.join(", "));
        continue;
      }
      if (fieldType === "boolean") {
        const raw = (freeText ?? (selected.length ? String(selected[0]) : ""))
          .trim()
          .toLowerCase();
        if (!raw) {
          await this.cancelQuestionForm(session, formId);
          this.closeQuestion(
            session,
            active,
            callId,
            "failed",
            "Question dismissed",
          );
          return;
        }
        const value =
          raw === "true" || raw === "yes" || raw === "y" || raw === "1";
        answer[key] = value;
        summary.push(String(value));
        continue;
      }
      if (fieldType === "number" || fieldType === "integer") {
        const raw = (
          freeText ?? (selected.length ? String(selected[0]) : "")
        ).trim();
        if (!raw) {
          await this.cancelQuestionForm(session, formId);
          this.closeQuestion(
            session,
            active,
            callId,
            "failed",
            "Question dismissed",
          );
          return;
        }
        const numeric = Number(raw);
        answer[key] = Number.isFinite(numeric) ? numeric : raw;
        summary.push(raw);
        continue;
      }
      const value = freeText ?? (selected.length ? String(selected[0]) : "");
      if (!value) {
        await this.cancelQuestionForm(session, formId);
        this.closeQuestion(
          session,
          active,
          callId,
          "failed",
          "Question dismissed",
        );
        return;
      }
      answer[key] = value;
      summary.push(value);
    }
    try {
      await this.request(
        `/api/session/${encodeURIComponent(session.providerThreadId)}/form/${encodeURIComponent(formId)}/reply`,
        { method: "POST", body: JSON.stringify({ answer }) },
      );
    } catch (error) {
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        errorMessage(error),
      );
      return;
    }
    this.closeQuestion(
      session,
      active,
      callId,
      "completed",
      summary.join("\n"),
    );
  }
}
