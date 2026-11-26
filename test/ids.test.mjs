import { describe, expect, test } from "bun:test";
import {
  PREFIX_CALL,
  PREFIX_RUN,
  PREFIX_SESSION,
  PREFIX_STEP,
  PREFIX_TURN,
  SessionGroupTracker,
  ULIDGenerator,
} from "../lib/ids.mjs";

describe("ids", () => {
  test("ULIDGenerator produces monotonic 26-char Crockford Base32 IDs within same ms", () => {
    const gen = new ULIDGenerator(() => 1700000000123);
    const list = [];
    for (let i = 0; i < 20; i++) {
      const id = gen.next(PREFIX_SESSION);
      expect(id.startsWith(PREFIX_SESSION)).toBe(true);
      expect(id.length).toBe(PREFIX_SESSION.length + 26);
      expect(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id.slice(PREFIX_SESSION.length))).toBe(true);
      list.push(id);
    }
    const sorted = [...list].sort();
    expect(list).toEqual(sorted);
    expect(new Set(list).size).toBe(20);
  });

  test("SessionGroupTracker reuses session (5m) and turn (60s) windows and rotates properly", () => {
    let now = 1_000_000;
    const tracker = new SessionGroupTracker({ nowFn: () => now, capacity: 2 });

    const first = tracker.acquire("mogick", "deepseek-v4-flash", "s1");
    expect(first.sessionId.startsWith(PREFIX_SESSION)).toBe(true);
    expect(first.runId.startsWith(PREFIX_RUN)).toBe(true);
    expect(first.turnId.startsWith(PREFIX_TURN)).toBe(true);
    expect(first.stepId.startsWith(PREFIX_STEP)).toBe(true);
    expect(first.callId.startsWith(PREFIX_CALL)).toBe(true);
    expect(first.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(first.chatId).toMatch(/^electron-\d+-[0-9a-f]{13}$/);

    // Within 60s: same session, trace, run, turn; new step & call
    now += 30_000;
    const second = tracker.acquire("mogick", "deepseek-v4-flash", "s1");
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.traceparent.slice(3, 35)).toBe(first.traceparent.slice(3, 35));
    expect(second.runId).toBe(first.runId);
    expect(second.turnId).toBe(first.turnId);
    expect(second.stepId).not.toBe(first.stepId);
    expect(second.callId).not.toBe(first.callId);

    // Beyond 60s, within 5m: same session & trace; new run & turn
    now += 61_000;
    const third = tracker.acquire("mogick", "deepseek-v4-flash", "s1");
    expect(third.sessionId).toBe(first.sessionId);
    expect(third.traceparent.slice(3, 35)).toBe(first.traceparent.slice(3, 35));
    expect(third.runId).not.toBe(first.runId);
    expect(third.turnId).not.toBe(first.turnId);

    // Beyond 5m: full rotation
    now += 5 * 60_000 + 1;
    const fourth = tracker.acquire("mogick", "deepseek-v4-flash", "s1");
    expect(fourth.sessionId).not.toBe(first.sessionId);
  });
});
