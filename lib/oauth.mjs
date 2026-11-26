import {
  DEFAULT_SESSION_DURATION_SEC,
  OAUTH_BASE_URL,
  OAUTH_CLIENT_ID,
  OAUTH_SCOPE,
  SERVICE_USER_AGENT,
} from "./constants.mjs";

export class OAuthError extends Error {
  constructor(message, { code = "error", signIn = "" } = {}) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    if (signIn) this.signIn = signIn;
  }
}

export function parseJwtClaims(token) {
  if (typeof token !== "string") return {};
  const parts = token.trim().split(".");
  if (parts.length !== 3 || !parts[1]) return {};
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function extractAccountMeta(accessToken, expiresInSec = 0, nowMs = Date.now()) {
  const claims = parseJwtClaims(accessToken);
  const uid = typeof claims.sub === "string" ? claims.sub.trim() : "";
  const nickname = typeof claims.nickname === "string" ? claims.nickname.trim() : "";
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  const accountId = nickname || email || uid || "";

  let expires;
  if (typeof expiresInSec === "number" && Number.isFinite(expiresInSec) && expiresInSec > 0) {
    expires = nowMs + Math.round(expiresInSec * 1000);
  } else if (typeof claims.exp === "number" && Number.isFinite(claims.exp) && claims.exp > 0) {
    expires = Math.round(claims.exp * 1000);
  } else {
    expires = nowMs + DEFAULT_SESSION_DURATION_SEC * 1000;
  }

  return {
    accountId,
    uid,
    email,
    expires,
    claims,
  };
}

function truncateText(text, max = 300) {
  if (typeof text !== "string") return "";
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

async function postForm(url, params, { fetchFn = fetch, signal } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") body.set(k, String(v));
  }
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": SERVICE_USER_AGENT,
    },
    body: body.toString(),
    signal,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

export async function requestDeviceCode({
  base = OAUTH_BASE_URL,
  clientId = OAUTH_CLIENT_ID,
  scope = OAUTH_SCOPE,
  fetchFn = fetch,
  signal,
} = {}) {
  const root = base.replace(/\/+$/, "");
  const { status, text, json } = await postForm(
    `${root}/device/code`,
    { client_id: clientId, scope },
    { fetchFn, signal },
  );
  if (status < 200 || status >= 300) {
    throw new OAuthError(`请求设备码失败 (HTTP ${status}): ${truncateText(text)}`);
  }
  if (!json || typeof json !== "object" || !json.device_code || !json.user_code) {
    throw new OAuthError(`设备码响应缺少必要字段: ${truncateText(text)}`);
  }
  return {
    device_code: String(json.device_code),
    user_code: String(json.user_code),
    verification_uri: String(json.verification_uri || ""),
    verification_uri_complete: String(json.verification_uri_complete || ""),
    interval: Number(json.interval) > 0 ? Number(json.interval) : 5,
    expires_in: Number(json.expires_in) > 0 ? Number(json.expires_in) : 1800,
  };
}

function classifyErrorCode(code, desc = "") {
  switch (code) {
    case "authorization_pending":
      return new OAuthError("授权进行中", { code: "pending" });
    case "slow_down":
      return new OAuthError("轮询频率过快 (slow_down)", { code: "slow_down" });
    case "expired_token":
    case "authorization_pending_expired":
      return new OAuthError("授权码已过期，请重新登录", { code: "expired", signIn: "expired" });
    case "invalid_grant":
      return new OAuthError(`登录已失效 (${code}${desc ? `: ${desc}` : ""})`, {
        code: "invalid_grant",
        signIn: "expired",
      });
    default:
      return new OAuthError(`OAuth 请求失败: ${code}${desc ? ` (${desc})` : ""}`, { code: "error" });
  }
}

async function exchangeToken(form, { base = OAUTH_BASE_URL, fetchFn = fetch, signal, nowMs } = {}) {
  const root = base.replace(/\/+$/, "");
  const { status, text, json } = await postForm(`${root}/token`, form, { fetchFn, signal });

  // Format 1: HTTP non-200 bare RFC 6749 error {"error": "...", "error_description": "..."}
  if (status !== 200) {
    if (json && typeof json === "object") {
      if (typeof json.error === "string" && json.error) {
        throw classifyErrorCode(json.error, json.error_description);
      }
      if (json.data?.errorCode) {
        throw classifyErrorCode(json.data.errorCode, json.message);
      }
    }
    throw new OAuthError(`OAuth 端点返回 HTTP ${status}: ${truncateText(text)}`, {
      code: status === 401 ? "unauthorized" : "error",
    });
  }

  if (!json || typeof json !== "object") {
    throw new OAuthError(`OAuth 响应 JSON 无效: ${truncateText(text)}`);
  }

  // Format 2: HTTP 200 wrapped business response {"code": 200|..., "message": ..., "data": {...}}
  if (typeof json.code === "number" && json.code !== 0 && json.code !== 200) {
    const errCode = json.data?.errorCode;
    if (typeof errCode === "string" && errCode) {
      throw classifyErrorCode(errCode, json.message);
    }
    throw new OAuthError(`OAuth 请求失败 code=${json.code} ${json.message || ""}`.trim());
  }

  const payload = json.data && typeof json.data === "object" && json.data.access_token ? json.data : json;
  const access = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!access) {
    const errCode = json.data?.errorCode || json.error;
    if (errCode) throw classifyErrorCode(errCode, json.message || json.error_description);
    throw new OAuthError(`OAuth 响应缺少 access_token: ${truncateText(text)}`);
  }

  const refresh = typeof payload.refresh_token === "string" ? payload.refresh_token.trim() : "";
  const expiresIn = Number(payload.expires_in) > 0 ? Number(payload.expires_in) : DEFAULT_SESSION_DURATION_SEC;
  const meta = extractAccountMeta(access, expiresIn, typeof nowMs === "function" ? nowMs() : Date.now());

  return {
    access,
    refresh,
    expires: meta.expires,
    expiresIn,
    tokenType: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
    accountId: meta.accountId,
    uid: meta.uid,
    email: meta.email,
  };
}

export function abortableSleep(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollDeviceToken({
  base = OAUTH_BASE_URL,
  clientId = OAUTH_CLIENT_ID,
  deviceCode,
  intervalSec = 5,
  expiresInSec = 1800,
  fetchFn = fetch,
  signal,
  sleepFn = abortableSleep,
  nowFn = Date.now,
} = {}) {
  let interval = Number(intervalSec) > 0 ? Number(intervalSec) : 5;
  const ttl = Number(expiresInSec) > 0 ? Number(expiresInSec) : 1800;
  const deadline = nowFn() + ttl * 1000;

  while (!signal?.aborted) {
    const remaining = deadline - nowFn();
    if (remaining <= 0) {
      return { type: "failed", error: "设备码已过期，请重新登录" };
    }
    try {
      await sleepFn(Math.min(interval * 1000, remaining), signal);
    } catch (err) {
      if (err?.name === "AbortError" || signal?.aborted) {
        return { type: "failed", error: "登录已取消" };
      }
      throw err;
    }

    if (signal?.aborted) {
      return { type: "failed", error: "登录已取消" };
    }

    try {
      const token = await exchangeToken(
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: clientId,
        },
        { base, fetchFn, signal, nowMs: nowFn },
      );
      return {
        type: "success",
        refresh: token.refresh,
        access: token.access,
        expires: token.expires,
        ...(token.accountId ? { accountId: token.accountId } : {}),
        ...(token.uid ? { uid: token.uid } : {}),
      };
    } catch (err) {
      if (err?.name === "AbortError" || signal?.aborted) {
        return { type: "failed", error: "登录已取消" };
      }
      if (err instanceof OAuthError) {
        if (err.code === "pending") continue;
        if (err.code === "slow_down") {
          interval += 5;
          continue;
        }
        return { type: "failed", error: err.message };
      }
      return { type: "failed", error: err?.message || String(err) };
    }
  }

  return { type: "failed", error: "登录已取消" };
}

export async function refreshAccessToken({
  base = OAUTH_BASE_URL,
  clientId = OAUTH_CLIENT_ID,
  refreshToken,
  fetchFn = fetch,
  signal,
  nowFn = Date.now,
} = {}) {
  if (!refreshToken) {
    throw Object.assign(new Error("缺少 refresh_token，请重新登录"), { signIn: "expired" });
  }
  const token = await exchangeToken(
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    },
    { base, fetchFn, signal, nowMs: nowFn },
  );
  return {
    access: token.access,
    refresh: token.refresh || refreshToken,
    expires: token.expires,
    ...(token.accountId ? { accountId: token.accountId } : {}),
    ...(token.uid ? { uid: token.uid } : {}),
  };
}
