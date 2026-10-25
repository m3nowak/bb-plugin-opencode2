import assert from "node:assert/strict";
import test from "node:test";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  manualCompactionOutcomeDeltas,
  manualCompactionStartDeltas,
  providerFailureDeltas,
  steerAcceptedDelta,
  timelineDeltasForEmission,
} from "./support/host-api.js";

function fixture() {
  const assembler = createDeltaAssembler({ providerId: "opencode2" });
  let nextRequest = 2;
  const assemble = (deltas: Record<string, any>[]) => {
    const wire = timelineDeltasForEmission(deltas);
    assert.ok(wire.every((delta) => !("providerTurnId" in delta)));
    return assembler.assemble({
      threadId: "bb-thread",
      deltas: wire.map((delta) => threadDeltaSchema.parse(delta)),
    });
  };
  const start = (id: string) =>
    assemble([
      { kind: "turn.open", providerTurnId: id },
      {
        kind: "input.accepted",
        clientRequestId: `creq_${String(nextRequest++).repeat(10)}`,
        providerTurnId: id,
      },
    ]);
  return { assembler, assemble, start };
}

test("keeps input acceptance, steering, and checkpoints on exactly one BB-managed turn", () => {
  const f = fixture();
  const first = f.start("one");
  const turnId = f.assembler.getOpenTurnId("bb-thread");
  assert.ok(turnId);
  const steered = f.assemble([steerAcceptedDelta("creq_4444444444", "one")]);
  const completed = f.assemble([
    {
      kind: "turn.boundary",
      status: "completed",
      providerTurnId: "one",
      providerCheckpointId: "msg-one",
    },
  ]);
  assert.equal(f.assembler.getOpenTurnId("bb-thread"), undefined);
  const firstEvents = [...first, ...steered, ...completed];
  assert.equal(
    firstEvents.filter((event) => event.type === "turn/started").length,
    1,
  );
  const inputs = firstEvents.filter(
    (event) => event.type === "turn/input/accepted",
  );
  assert.deepEqual(
    inputs.map((event) => event.clientRequestId),
    ["creq_2222222222", "creq_4444444444"],
  );
  assert.ok(
    inputs.every(
      (event) => event.scope.kind === "turn" && event.scope.turnId === turnId,
    ),
  );
  const boundary = completed.find((event) => event.type === "turn/completed");
  assert.equal(boundary?.providerCheckpointId, "msg-one");
  assert.deepEqual(boundary?.scope, { kind: "turn", turnId });

  const second = f.start("two");
  const secondTurn = f.assembler.getOpenTurnId("bb-thread");
  assert.ok(secondTurn && secondTurn !== turnId);
  assert.equal(
    second.filter((event) => event.type === "turn/input/accepted").length,
    1,
  );
  const resumed = f.assemble([{ kind: "turn.mainRun", state: "idle" }]);
  assert.deepEqual(resumed[0]?.scope, { kind: "turn", turnId: secondTurn });
});

test("a failed BB-managed turn settles once and retains its checkpoint", () => {
  const f = fixture();
  f.start("failed");
  const events = f.assemble(
    providerFailureDeltas({
      providerTurnId: "failed",
      error: "Failed request",
      providerCheckpointId: "msg-failed",
    }),
  );
  assert.equal(
    events.filter((event) => event.type === "provider/error").length,
    1,
  );
  const boundaries = events.filter((event) => event.type === "turn/completed");
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].status, "failed");
  assert.equal(boundaries[0].providerCheckpointId, "msg-failed");
  assert.equal(f.assembler.getOpenTurnId("bb-thread"), undefined);
  assert.equal(
    f.start("next").filter((event) => event.type === "turn/started").length,
    1,
  );
});

test("manual compaction finishes its BB-managed turn before the next input", () => {
  const f = fixture();
  const start = f.assemble(
    manualCompactionStartDeltas(
      "creq_5555555555",
      "compact",
      "compaction-item",
    ),
  );
  const compactTurn = f.assembler.getOpenTurnId("bb-thread");
  assert.ok(compactTurn);
  assert.equal(
    start.filter((event) => event.type === "turn/input/accepted").length,
    1,
  );
  const end = f.assemble(
    manualCompactionOutcomeDeltas({
      providerTurnId: "compact",
      messageId: "compaction-item",
      status: "completed",
    }),
  );
  assert.equal(
    end.filter((event) => event.type === "thread/compacted").length,
    1,
  );
  assert.equal(
    end.filter((event) => event.type === "turn/completed").length,
    1,
  );
  assert.equal(f.assembler.getOpenTurnId("bb-thread"), undefined);
  const next = f.start("after-compact");
  const nextTurn = f.assembler.getOpenTurnId("bb-thread");
  assert.notEqual(nextTurn, compactTurn);
  assert.ok(
    next.every(
      (event) => event.scope.kind === "turn" && event.scope.turnId === nextTurn,
    ),
  );
});
