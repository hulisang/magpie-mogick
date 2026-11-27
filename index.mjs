import {
  APP_ID,
  BALANCE_URL,
  BASE_URL,
  CHAT_USER_AGENT,
  DEFAULT_MODELS,
  DEFAULT_OPTIONS,
  OAUTH_BASE_URL,
  OAUTH_CLIENT_ID,
  OAUTH_SCOPE,
  PLUGIN_OPTIONS,
  PROVIDER_ID,
  PROVIDER_NAME,
  REFRESH_LEAD_MS,
  UPSTREAM_MODEL_INFO_URL,
} from "./lib/constants.mjs";
import { SessionGroupTracker, ULIDGenerator } from "./lib/ids.mjs";
import { ModelCatalog } from "./lib/models.mjs";
import {
  OAuthError,
  extractAccountMeta,
  parseJwtClaims,
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceCode,
} from "./lib/oauth.mjs";
import {
  createSseTransformStream,
  rewriteCompletionResponse,
  rewriteRequestBody,
  rewriteSseFrame,
} from "./lib/transform.mjs";
import {
  DailyRewardTracker,
  claimDailyRewardOnce,
  fetchBalance,
  formatUsageResult,
  runCheckin,
} from "./lib/usage.mjs";

export const MogickAuthPlugin = async (input = {}, pluginOptions = {}) => {
  const fetchFn = pluginOptions.fetchFn || globalThis.fetch;
  const nowFn = pluginOptions.nowFn || Date.now;
  const sleepFn = pluginOptions.sleepFn;
  const baseUrl = (pluginOptions.baseUrl || BASE_URL).replace(/\/+$/, "");
  const oauthBase = (pluginOptions.oauthBase || OAUTH_BASE_URL).replace(/\/+$/, "");
  const clientId = pluginOptions.clientId || OAUTH_CLIENT_ID;
  const scope = pluginOptions.scope || OAUTH_SCOPE;
  const modelInfoUrl = pluginOptions.modelInfoUrl || UPSTREAM_MODEL_INFO_URL;
  const balanceUrl = pluginOptions.balanceUrl || BALANCE_URL;

  const idGen = new ULIDGenerator(nowFn);
  const sessionTracker = new SessionGroupTracker({ nowFn, idGen });
  const modelCatalog = new ModelCatalog({ nowFn });
  const dailyRewardTracker = new DailyRewardTracker({ nowFn });
  const inflightRefresh = new Map();
  const isMagpieHost = Boolean(input?.magpie) || input?.project?.id === "magpie";

  function readOption(key) {
    if (typeof input?.magpie?.option === "function") {
      return Boolean(input.magpie.option(PROVIDER_ID, key));
    }
    if (typeof pluginOptions[key] === "boolean") {
      return pluginOptions[key];
    }
    return Boolean(DEFAULT_OPTIONS[key]);
  }

  function shouldClaimDailyRewardOnChat() {
    // In Magpie, daily reward check-in is handled natively by auth.checkin ("高级 → 每日签到").
    if (isMagpieHost) return false;
    if (typeof pluginOptions.claim_daily_reward === "boolean") {
      return pluginOptions.claim_daily_reward;
    }
    return Boolean(DEFAULT_OPTIONS.claim_daily_reward);
  }

  async function emitLog(level, message) {
    try {
      await input?.client?.app?.log?.({
        body: {
          service: PROVIDER_ID,
          level,
          message,
        },
      });
    } catch {
      // Never let logging failures break plugin flows
    }
  }

  function accountScopeKey(auth) {
    if (typeof input?.magpie?.account === "function") {
      const k = input.magpie.account(PROVIDER_ID);
      if (k) return k;
    }
    return auth?.uid || auth?.accountId || auth?.refresh || auth?.access || PROVIDER_ID;
  }

  async function refreshSingleFlight(key, refreshToken) {
    if (!refreshToken) {
      throw Object.assign(new Error("缺少 refresh_token，请重新登录"), { signIn: "expired" });
    }
    const existing = inflightRefresh.get(key);
    if (existing) return existing;

    const promise = refreshAccessToken({
      base: oauthBase,
      clientId,
      refreshToken,
      fetchFn,
      nowFn,
    }).finally(() => {
      inflightRefresh.delete(key);
    });
    inflightRefresh.set(key, promise);
    return promise;
  }

  async function persistRefreshedAuth(oldAuth, renewed) {
    const nextAuth = {
      ...oldAuth,
      type: "oauth",
      ...renewed,
    };
    try {
      await input?.client?.auth?.set?.({
        path: { id: PROVIDER_ID },
        body: nextAuth,
      });
    } catch (err) {
      await emitLog("warn", `保存刷新后的凭证失败: ${err?.message || String(err)}`);
    }
    return nextAuth;
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER_ID] ??= {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        api: baseUrl,
        models: structuredClone(DEFAULT_MODELS),
      };
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider, { signal } = {}) {
        const fallback = provider?.models || DEFAULT_MODELS;
        return modelCatalog.getModels(fallback, {
          url: modelInfoUrl,
          baseUrl,
          fetchFn,
          signal,
        });
      },
    },

    "chat.headers": async (hookInput, output) => {
      if (hookInput?.model?.providerID === PROVIDER_ID && hookInput?.sessionID) {
        output.headers["x-magpie-session-hint"] = hookInput.sessionID;
      }
    },

    auth: {
      provider: PROVIDER_ID,
      rotating: true,
      refreshLead: REFRESH_LEAD_MS,
      options: PLUGIN_OPTIONS,
      methods: [
        {
          type: "oauth",
          label: "Sign in with Mogick (OAuth device code)",
          labels: {
            zh: "使用 Mogick 账号登录 (OAuth 设备码)",
            "zh-TW": "使用 Mogick 帳號登入 (OAuth 裝置碼)",
          },
          async authorize(_inputs, { signal } = {}) {
            const dev = await requestDeviceCode({
              base: oauthBase,
              clientId,
              scope,
              fetchFn,
              signal,
            });
            const url = dev.verification_uri_complete || dev.verification_uri;
            return {
              url,
              instructions: `请在浏览器中确认授权登录；如未自动填入，请输入设备码：${dev.user_code}`,
              method: "auto",
              async callback(_code, cbOpts = {}) {
                return pollDeviceToken({
                  base: oauthBase,
                  clientId,
                  deviceCode: dev.device_code,
                  intervalSec: dev.interval,
                  expiresInSec: dev.expires_in,
                  fetchFn,
                  signal: cbOpts?.signal ?? signal,
                  sleepFn,
                  nowFn,
                });
              },
            };
          },
        },
      ],

      async refresh(auth) {
        if (!auth || auth.type !== "oauth" || !auth.refresh) return;
        const key = accountScopeKey(auth);
        return refreshSingleFlight(key, auth.refresh);
      },

      async usage(getAuth, _provider, opts = {}) {
        let auth = await getAuth();
        if (!auth || auth.type !== "oauth" || !auth.access) {
          return { error: "未登录 Mogick 账号", signIn: "expired", windows: [] };
        }

        const key = accountScopeKey(auth);
        let signIn = "kept";

        try {
          const data = await fetchBalance(auth.access, {
            url: balanceUrl,
            fetchFn,
            signal: opts?.signal,
          });
          return formatUsageResult(data, { auth, signIn });
        } catch (err) {
          if (err?.signIn === "expired" && auth.refresh) {
            try {
              const renewed = await refreshSingleFlight(key, auth.refresh);
              auth = await persistRefreshedAuth(auth, renewed);
              signIn = "renewed";
              const data = await fetchBalance(auth.access, {
                url: balanceUrl,
                fetchFn,
                signal: opts?.signal,
              });
              return formatUsageResult(data, { auth, signIn });
            } catch (refreshErr) {
              return {
                error: refreshErr?.message || "登录已过期，请重新登录",
                signIn: refreshErr?.signIn || "expired",
                windows: [],
              };
            }
          }
          return {
            error: err?.message || String(err),
            ...(err?.signIn ? { signIn: err.signIn } : {}),
            windows: [],
          };
        }
      },

      async checkin(getAuth) {
        let auth = await getAuth();
        if (!auth || auth.type !== "oauth" || !auth.access) {
          return { outcome: "ineligible", message: "未登录 Mogick 账号" };
        }

        const key = accountScopeKey(auth);
        let res = await runCheckin(key, auth.access, dailyRewardTracker, {
          url: balanceUrl,
          fetchFn,
          nowFn,
        });

        if (res.outcome === "failed" && /401/.test(res.message || "") && auth.refresh) {
          try {
            const renewed = await refreshSingleFlight(key, auth.refresh);
            auth = await persistRefreshedAuth(auth, renewed);
            res = await runCheckin(key, auth.access, dailyRewardTracker, {
              url: balanceUrl,
              fetchFn,
              nowFn,
            });
          } catch {
            // Keep failed outcome
          }
        }
        return res;
      },

      async loader(getAuth) {
        const initialAuth = await getAuth();
        if (!initialAuth || initialAuth.type !== "oauth" || !initialAuth.access) {
          return {};
        }

        return {
          baseURL: baseUrl,
          apiKey: "",
          async fetch(reqInput, reqInit = {}) {
            let auth = await getAuth();
            if (!auth || !auth.access) {
              throw Object.assign(new Error("Mogick 未登录或缺少访问令牌"), { signIn: "expired" });
            }

            const key = accountScopeKey(auth);
            let renewedDuringFetch = false;

            // OpenCode / non-Magpie fallback: refresh proactively if near expiry
            if (auth.refresh && (!auth.expires || auth.expires - nowFn() < REFRESH_LEAD_MS)) {
              try {
                const renewed = await refreshSingleFlight(key, auth.refresh);
                auth = await persistRefreshedAuth(auth, renewed);
                renewedDuringFetch = true;
              } catch (err) {
                if (err?.signIn === "expired") {
                  throw Object.assign(new Error(err.message), { signIn: "expired" });
                }
                await emitLog("warn", `请求前预刷新失败，继续尝试当前令牌: ${err?.message || String(err)}`);
              }
            }

            const foldEffort = readOption("fold_reasoning_effort");
            const stripArgs = readOption("strip_mogick_args");
            const stripReason = readOption("strip_reasoning");
            const claimReward = shouldClaimDailyRewardOnChat();

            const headers = new Headers(reqInput instanceof Request ? reqInput.headers : undefined);
            if (reqInit?.headers) {
              new Headers(reqInit.headers).forEach((v, k) => headers.set(k, v));
            }
            const magpieSessionHint = headers.get("x-magpie-session-hint") || "";
            headers.delete("x-magpie-session-hint");
            headers.delete("x-magpie-caller-agent");
            headers.delete("x-magpie-caller-name");
            headers.delete("x-magpie-caller-via");

            const targetUrl = typeof reqInput === "string"
              ? reqInput
              : reqInput instanceof URL
                ? reqInput.href
                : reqInput.url;
            const method = reqInit?.method || (reqInput instanceof Request ? reqInput.method : "POST");
            const rawBody = reqInit && "body" in reqInit
              ? reqInit.body
              : reqInput instanceof Request && reqInput.body
                ? await reqInput.text()
                : undefined;

            const { body: rewrittenBody, clientModel, isStream } = rewriteRequestBody(rawBody, {
              foldReasoningEffort: foldEffort,
              stripMogickArgs: stripArgs,
            });

            if (claimReward) {
              await claimDailyRewardOnce(key, auth.access, dailyRewardTracker, {
                url: balanceUrl,
                fetchFn,
                nowFn,
                logFn: emitLog,
              });
            }

            const traceIds = sessionTracker.acquire(key, clientModel, magpieSessionHint);
            headers.set("content-type", "application/json");
            headers.set("x-app-id", APP_ID);
            headers.set("user-agent", CHAT_USER_AGENT);
            headers.set("x-session-id", traceIds.sessionId);
            headers.set("x-mogick-session-id", traceIds.sessionId);
            headers.set("x-mogick-run-id", traceIds.runId);
            headers.set("x-mogick-turn-id", traceIds.turnId);
            headers.set("x-mogick-step-id", traceIds.stepId);
            headers.set("x-mogick-llm-call-id", traceIds.callId);
            headers.set("x-chat-id", traceIds.chatId);
            headers.set("traceparent", traceIds.traceparent);
            headers.set("authorization", `Bearer ${auth.access}`);

            if (isStream) {
              headers.set("accept", "text/event-stream");
              headers.set("x-llm-store-resumable", "true");
              headers.set("x-llm-store-stream-error-events", "true");
            } else {
              headers.set("accept", "application/json");
              headers.delete("x-llm-store-resumable");
              headers.delete("x-llm-store-stream-error-events");
            }

            const sendUpstream = () =>
              fetchFn(targetUrl, {
                ...reqInit,
                method,
                headers,
                body: rewrittenBody,
              });

            let res = await sendUpstream();

            if (res.status === 401 && auth.refresh) {
              try {
                const renewed = await refreshSingleFlight(key, auth.refresh);
                auth = await persistRefreshedAuth(auth, renewed);
                renewedDuringFetch = true;
                headers.set("authorization", `Bearer ${auth.access}`);
                res = await sendUpstream();
              } catch (err) {
                const outHeaders = new Headers(res.headers);
                if (err?.signIn === "expired") {
                  outHeaders.set("x-magpie-sign-in", "expired");
                }
                return new Response(res.body, {
                  status: res.status,
                  statusText: res.statusText,
                  headers: outHeaders,
                });
              }
            }

            const outHeaders = new Headers(res.headers);
            if (renewedDuringFetch && res.status !== 401) {
              outHeaders.set("x-magpie-sign-in", "renewed");
            }

            if (!res.ok) {
              return new Response(res.body, {
                status: res.status,
                statusText: res.statusText,
                headers: outHeaders,
              });
            }

            const contentType = (res.headers.get("content-type") || "").toLowerCase();
            if (isStream && res.body && (!contentType.includes("application/json") || contentType.includes("text/event-stream"))) {
              outHeaders.delete("content-length");
              outHeaders.delete("content-encoding");
              const transformed = res.body.pipeThrough(
                createSseTransformStream({
                  clientModel,
                  stripMogickArgs: stripArgs,
                  stripReasoning: stripReason,
                }),
              );
              return new Response(transformed, {
                status: res.status,
                statusText: res.statusText,
                headers: outHeaders,
              });
            }

            const respText = await res.text();
            const transformedText = rewriteCompletionResponse(respText, {
              clientModel,
              stripMogickArgs: stripArgs,
              stripReasoning: stripReason,
            });
            outHeaders.delete("content-length");
            outHeaders.delete("content-encoding");
            return new Response(transformedText, {
              status: res.status,
              statusText: res.statusText,
              headers: outHeaders,
            });
          },
        };
      },
    },
  };
};

export const _internal = {
  OAuthError,
  parseJwtClaims,
  extractAccountMeta,
  requestDeviceCode,
  pollDeviceToken,
  refreshAccessToken,
  ULIDGenerator,
  SessionGroupTracker,
  ModelCatalog,
  DailyRewardTracker,
  claimDailyRewardOnce,
  fetchBalance,
  formatUsageResult,
  runCheckin,
  rewriteRequestBody,
  rewriteCompletionResponse,
  rewriteSseFrame,
  createSseTransformStream,
};
