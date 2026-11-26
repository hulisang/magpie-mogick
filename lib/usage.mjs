import {
  BALANCE_URL,
  DAILY_REWARD_TIMEOUT_MS,
  SERVICE_USER_AGENT,
  USAGE_TIMEOUT_MS,
} from "./constants.mjs";
import { OAuthError } from "./oauth.mjs";

export function parseBalanceNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === "string") {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function formatCredits(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return Number(n.toFixed(4)).toString();
}

export function utcDateString(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function nextUtcMidnightIso(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0)).toISOString();
}

export async function fetchBalance(accessToken, {
  url = BALANCE_URL,
  fetchFn = fetch,
  signal,
  timeoutMs = USAGE_TIMEOUT_MS,
} = {}) {
  if (!accessToken) {
    throw Object.assign(new OAuthError("缺少访问令牌", { code: "unauthorized", signIn: "expired" }));
  }

  const signals = [];
  if (signal) signals.push(signal);
  if (timeoutMs > 0 && typeof AbortSignal.timeout === "function") {
    signals.push(AbortSignal.timeout(timeoutMs));
  }
  const combinedSignal = signals.length > 1 && typeof AbortSignal.any === "function"
    ? AbortSignal.any(signals)
    : signals[0];

  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": SERVICE_USER_AGENT,
      authorization: `Bearer ${accessToken}`,
    },
    signal: combinedSignal,
  });

  if (res.status === 401) {
    throw new OAuthError("访问令牌已失效 (HTTP 401)", { code: "unauthorized", signIn: "expired" });
  }
  if (!res.ok) {
    throw new Error(`余额查询失败 (HTTP ${res.status})`);
  }

  const envelope = await res.json();
  if (!envelope || typeof envelope !== "object" || envelope.code !== 0 || !envelope.data || typeof envelope.data !== "object") {
    throw new Error(`余额服务返回异常业务码 ${envelope?.code ?? "unknown"}`);
  }

  const d = envelope.data;
  return {
    raw: envelope,
    userId: typeof d.user_id === "string" ? d.user_id : "",
    available: parseBalanceNumber(d.available_amount),
    total: parseBalanceNumber(d.total_balance),
    plan: parseBalanceNumber(d.plan_balance),
    free: parseBalanceNumber(d.free_balance),
    hold: parseBalanceNumber(d.active_hold_amount),
    frozen: parseBalanceNumber(d.frozen),
    creditLimit: parseBalanceNumber(d.credit_limit),
    posted: parseBalanceNumber(d.posted_balance),
    cash: parseBalanceNumber(d.balance),
  };
}

export function formatUsageResult(balanceData, { auth, signIn = "kept" } = {}) {
  const user = auth?.accountId || balanceData.userId || "";
  const windows = [
    {
      name: "可用额度",
      balance: Math.max(0, balanceData.available),
      unit: "credits",
      display: `${formatCredits(balanceData.available)} credits`,
    },
    {
      name: "套餐余额",
      balance: Math.max(0, balanceData.plan),
      unit: "credits",
      display: `${formatCredits(balanceData.plan)} credits`,
      aside: true,
    },
    {
      name: "赠送余额",
      balance: Math.max(0, balanceData.free),
      unit: "credits",
      display: `${formatCredits(balanceData.free)} credits`,
      aside: true,
    },
  ];

  if (balanceData.hold > 0) {
    windows.push({
      name: "在途冻结",
      balance: Math.max(0, balanceData.hold),
      unit: "credits",
      display: `${formatCredits(balanceData.hold)} credits`,
      aside: true,
    });
  }

  return {
    user,
    balance: `${formatCredits(balanceData.available)} credits`,
    signIn,
    windows,
  };
}

export const DAILY_REWARD_CAPACITY = 256;

export function normalizeRewardKey(raw) {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

export class DailyRewardTracker {
  constructor({ capacity = DAILY_REWARD_CAPACITY, nowFn = Date.now } = {}) {
    this.capacity = capacity;
    this.nowFn = nowFn;
    this.entries = new Map();
  }

  reserve(rawKey, today = utcDateString(this.nowFn())) {
    const key = normalizeRewardKey(rawKey);
    if (!key) return false;

    const existing = this.entries.get(key);
    if (existing && existing.date === today) {
      return false;
    }

    if (!existing && this.entries.size >= this.capacity) {
      for (const [k, v] of this.entries.entries()) {
        if (v.date !== today) this.entries.delete(k);
      }
      if (this.entries.size >= this.capacity) {
        for (const [k, v] of this.entries.entries()) {
          if (!v.inflight) {
            this.entries.delete(k);
            break;
          }
        }
      }
    }

    this.entries.set(key, { date: today, inflight: true, settled: false });
    return true;
  }

  settle(rawKey, today = utcDateString(this.nowFn()), ok = true) {
    const key = normalizeRewardKey(rawKey);
    const existing = this.entries.get(key);
    if (!existing || existing.date !== today) return;
    this.entries.set(key, { date: today, inflight: false, settled: ok });
  }

  hasClaimed(rawKey, today = utcDateString(this.nowFn())) {
    const key = normalizeRewardKey(rawKey);
    const existing = this.entries.get(key);
    return Boolean(existing && existing.date === today);
  }

  clear() {
    this.entries.clear();
  }
}

export async function claimDailyRewardOnce(accountKey, accessToken, tracker, {
  url = BALANCE_URL,
  fetchFn = fetch,
  nowFn = Date.now,
  logFn,
} = {}) {
  if (!tracker || !accountKey || !accessToken) return { skipped: true };
  const today = utcDateString(nowFn());
  if (!tracker.reserve(accountKey, today)) {
    return { skipped: true };
  }

  let ok = false;
  try {
    const data = await fetchBalance(accessToken, {
      url,
      fetchFn,
      timeoutMs: DAILY_REWARD_TIMEOUT_MS,
    });
    ok = true;
    await logFn?.("info", `每日登录奖励已触发结算 (赠送 ${formatCredits(data.free)} / 可用 ${formatCredits(data.available)} credits)`);
    return { skipped: false, ok: true, data };
  } catch (err) {
    await logFn?.("warn", `每日登录奖励触发失败，当日不再重试: ${err?.message || String(err)}`);
    return { skipped: false, ok: false, error: err };
  } finally {
    tracker.settle(accountKey, today, ok);
  }
}

export async function runCheckin(accountKey, accessToken, tracker, {
  url = BALANCE_URL,
  fetchFn = fetch,
  signal,
  nowFn = Date.now,
} = {}) {
  const now = nowFn();
  const today = utcDateString(now);
  const until = nextUtcMidnightIso(now);
  const alreadyRecorded = tracker ? tracker.hasClaimed(accountKey, today) : false;

  try {
    const data = await fetchBalance(accessToken, {
      url,
      fetchFn,
      signal,
      timeoutMs: USAGE_TIMEOUT_MS,
    });
    if (tracker) {
      tracker.reserve(accountKey, today);
      tracker.settle(accountKey, today, true);
    }
    const summary = `赠送 ${formatCredits(data.free)} / 可用 ${formatCredits(data.available)} credits`;
    if (alreadyRecorded) {
      return {
        outcome: "done",
        message: `今日已触发过结算（${summary}）`,
        until,
      };
    }
    return {
      outcome: "claimed",
      credit: 2,
      message: `已触发每日奖励查询（${summary}）`,
      until,
    };
  } catch (err) {
    return {
      outcome: "failed",
      message: err?.message || String(err),
      until,
    };
  }
}
