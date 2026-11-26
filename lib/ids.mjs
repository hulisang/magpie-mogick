import crypto from "node:crypto";

export const PREFIX_SESSION = "ses_";
export const PREFIX_RUN = "run_";
export const PREFIX_TURN = "turn_";
export const PREFIX_STEP = "step_";
export const PREFIX_CALL = "mc_";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export class ULIDGenerator {
  constructor(nowFn = Date.now) {
    this.nowFn = nowFn;
    this.lastTime = -1;
    this.lastRandom = new Uint8Array(10);
  }

  next(prefix = "") {
    let now = Math.floor(this.nowFn());
    if (now < 0) now = 0;

    if (now === this.lastTime) {
      // Increment 80-bit random component monotonically within the same millisecond
      for (let i = 9; i >= 0; i--) {
        if (this.lastRandom[i] < 255) {
          this.lastRandom[i]++;
          break;
        }
        this.lastRandom[i] = 0;
      }
    } else {
      this.lastTime = now;
      crypto.randomFillSync(this.lastRandom);
    }

    const timeChars = new Array(10);
    let t = now;
    for (let i = 9; i >= 0; i--) {
      timeChars[i] = CROCKFORD[t % 32];
      t = Math.floor(t / 32);
    }

    // Encode 80-bit random (10 bytes) into 16 Crockford Base32 chars (16 * 5 = 80 bits)
    const randChars = new Array(16);
    let bitBuffer = 0;
    let bitCount = 0;
    let outIdx = 0;
    for (let i = 0; i < 10; i++) {
      bitBuffer = (bitBuffer << 8) | this.lastRandom[i];
      bitCount += 8;
      while (bitCount >= 5) {
        bitCount -= 5;
        randChars[outIdx++] = CROCKFORD[(bitBuffer >> bitCount) & 31];
      }
    }

    return prefix + timeChars.join("") + randChars.join("");
  }
}

export function randomHex(byteCount) {
  return crypto.randomBytes(byteCount).toString("hex");
}

export function generateChatId(nowMs = Date.now()) {
  const hex = crypto.randomBytes(7).toString("hex").slice(0, 13);
  return `electron-${Math.floor(nowMs)}-${hex}`;
}

export const SESSION_WINDOW_MS = 5 * 60 * 1000;
export const TURN_WINDOW_MS = 60 * 1000;
export const DEFAULT_SESSION_CAPACITY = 256;

export class SessionGroupTracker {
  constructor({ capacity = DEFAULT_SESSION_CAPACITY, nowFn = Date.now, idGen = new ULIDGenerator(nowFn) } = {}) {
    this.capacity = capacity;
    this.nowFn = nowFn;
    this.idGen = idGen;
    this.entries = new Map();
  }

  acquire(accountKey, model = "", magpieSessionId = "") {
    const now = this.nowFn();
    const key = `${accountKey || ""}\0${model || ""}\0${magpieSessionId || ""}`;
    const existing = this.entries.get(key);

    let entry;
    if (!existing || now - existing.lastUsed > SESSION_WINDOW_MS) {
      entry = {
        sessionId: this.idGen.next(PREFIX_SESSION),
        traceId: randomHex(16),
        runId: this.idGen.next(PREFIX_RUN),
        turnId: this.idGen.next(PREFIX_TURN),
        lastUsed: now,
      };
    } else {
      const turnExpired = now - existing.lastUsed > TURN_WINDOW_MS;
      entry = {
        sessionId: existing.sessionId,
        traceId: existing.traceId,
        runId: turnExpired ? this.idGen.next(PREFIX_RUN) : existing.runId,
        turnId: turnExpired ? this.idGen.next(PREFIX_TURN) : existing.turnId,
        lastUsed: now,
      };
    }

    if (!this.entries.has(key) && this.entries.size >= this.capacity) {
      for (const [k, v] of this.entries.entries()) {
        if (now - v.lastUsed > SESSION_WINDOW_MS) {
          this.entries.delete(k);
        }
      }
      if (this.entries.size >= this.capacity) {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [k, v] of this.entries.entries()) {
          if (v.lastUsed < oldestTime) {
            oldestTime = v.lastUsed;
            oldestKey = k;
          }
        }
        if (oldestKey !== null) this.entries.delete(oldestKey);
      }
    }

    this.entries.set(key, entry);

    const stepId = this.idGen.next(PREFIX_STEP);
    const callId = this.idGen.next(PREFIX_CALL);
    const spanId = randomHex(8);

    return {
      sessionId: entry.sessionId,
      runId: entry.runId,
      turnId: entry.turnId,
      stepId,
      callId,
      traceparent: `00-${entry.traceId}-${spanId}-01`,
      chatId: generateChatId(now),
    };
  }

  clear() {
    this.entries.clear();
  }
}
