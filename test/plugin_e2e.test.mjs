import { describe, expect, test } from "bun:test";
import { MogickAuthPlugin, _internal } from "../index.mjs";

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("MogickAuthPlugin end-to-end", () => {
  test("module only exports MogickAuthPlugin as a function and keeps _internal as object", () => {
    expect(typeof MogickAuthPlugin).toBe("function");
    expect(typeof _internal).toBe("object");
  });

  test("full lifecycle: config, login, models, chat.headers, loader.fetch (stream + 401 refresh), usage, checkin, options", async () => {
    const jwt1 = makeJwt({ sub: "u_100", nickname: "Ethan", exp: 2000000000 });
    const jwt2 = makeJwt({ sub: "u_100", nickname: "Ethan", exp: 2000007200 });
    let storedAuth = null;
    const optionState = {
      fold_reasoning_effort: true,
      strip_mogick_args: true,
      strip_reasoning: true,
      claim_daily_reward: true,
    };

    const requests = [];
    let chatAttempts = 0;

    const fetchFn = async (url, init = {}) => {
      requests.push({ url, method: init.method, headers: new Headers(init.headers), body: init.body });

      if (url.endsWith("/device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "dev_xyz",
            user_code: "CODE-1234",
            verification_uri: "https://login.tongyuan.cc/device",
            interval: 1,
            expires_in: 300,
          }),
          { status: 200 },
        );
      }

      if (url.endsWith("/token")) {
        if (String(init.body).includes("device_code")) {
          return new Response(
            JSON.stringify({ access_token: jwt1, refresh_token: "rt_1", expires_in: 7200 }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            code: 200,
            data: { access_token: jwt2, refresh_token: "rt_2", expires_in: 7200 },
          }),
          { status: 200 },
        );
      }

      if (url.includes("/application/modelinfo")) {
        return new Response(
          JSON.stringify({
            models: [
              {
                id: "deepseek-v4-flash",
                display_name: "DeepSeek V4 Flash",
                context_length: 128000,
                output_limit: 16384,
                input_modalities: ["text"],
                output_modalities: ["text"],
                capabilities: { reasoning: true, tool_calls: true, reasoning_efforts: ["low", "high"] },
              },
            ],
            scenes: { default_model: "deepseek-v4-flash" },
          }),
          { status: 200 },
        );
      }

      if (url.includes("/user/balance")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              user_id: "u_100",
              available_amount: "42.5",
              plan_balance: "30",
              free_balance: "12.5",
              active_hold_amount: "0",
            },
          }),
          { status: 200 },
        );
      }

      if (url.endsWith("/chat/completions")) {
        chatAttempts++;
        const authHdr = new Headers(init.headers).get("authorization");
        if (chatAttempts === 1 && authHdr === `Bearer ${jwt1}`) {
          return new Response(JSON.stringify({ error: { message: "expired" } }), { status: 401 });
        }
        const bodyObj = JSON.parse(init.body);
        if (bodyObj.stream) {
          const sse = [
            `data: ${JSON.stringify({
              model: "deepseek-v4-flash-0731",
              choices: [{ index: 0, delta: { reasoning_content: "chain", content: "hi" } }],
            })}\n\n`,
            `data: [DONE]\n\n`,
          ].join("");
          return new Response(sse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(
          JSON.stringify({
            model: "deepseek-v4-flash-0731",
            choices: [{ index: 0, message: { role: "assistant", reasoning_content: "chain", content: "ok" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    };

    const hooks = await MogickAuthPlugin(
      {
        client: {
          auth: {
            set: async ({ body }) => {
              storedAuth = body;
              return { data: true };
            },
          },
          app: { log: async () => ({ data: true }) },
        },
        magpie: {
          option: (_provider, key) => optionState[key],
          account: () => "mogick",
        },
      },
      {
        fetchFn,
        nowFn: () => Date.UTC(2026, 10, 25, 12, 0, 0),
        sleepFn: async () => {},
      },
    );

    // 1. config
    const cfg = {};
    await hooks.config(cfg);
    expect(cfg.provider.mogick.npm).toBe("@ai-sdk/openai-compatible");

    // 2. oauth login
    const authFlow = await hooks.auth.methods[0].authorize();
    expect(authFlow.instructions).toContain("CODE-1234");
    const loginRes = await authFlow.callback();
    expect(loginRes.type).toBe("success");
    storedAuth = {
      type: "oauth",
      access: loginRes.access,
      refresh: loginRes.refresh,
      expires: loginRes.expires,
      accountId: loginRes.accountId,
      uid: loginRes.uid,
    };

    // 3. provider.models
    const models = await hooks.provider.models({ models: cfg.provider.mogick.models }, { auth: storedAuth });
    expect(models["deepseek-v4-flash"].variants).toEqual({ low: {}, high: {} });

    // 4. chat.headers + loader.fetch (stream + 401 refresh retry + daily reward)
    const loaderOpts = await hooks.auth.loader(async () => storedAuth);
    const hdrOut = { headers: {} };
    await hooks["chat.headers"]({ model: { providerID: "mogick" }, sessionID: "magpie-sess-1" }, hdrOut);
    expect(hdrOut.headers["x-magpie-session-hint"]).toBe("magpie-sess-1");

    const streamRes = await loaderOpts.fetch(`${loaderOpts.baseURL}/chat/completions`, {
      method: "POST",
      headers: hdrOut.headers,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: true,
        reasoning_effort: "medium",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("x-magpie-sign-in")).toBe("renewed");
    expect(storedAuth.refresh).toBe("rt_2");

    const sseBody = await streamRes.text();
    const frame0 = JSON.parse(sseBody.split("\n\n")[0].replace(/^data: /, ""));
    expect(frame0.model).toBe("deepseek-v4-flash");
    expect("reasoning_content" in frame0.choices[0].delta).toBe(false);

    // Verify 11-header matrix & stripped magpie hint header
    const chatReq = requests.find((r) => r.url.endsWith("/chat/completions"));
    expect(chatReq.headers.get("x-app-id")).toBe("mogick");
    expect(chatReq.headers.get("user-agent")).toBe("Go-http-client/1.1");
    expect(chatReq.headers.get("x-session-id")).toMatch(/^ses_/);
    expect(chatReq.headers.get("x-mogick-llm-call-id")).toMatch(/^mc_/);
    expect(chatReq.headers.get("x-llm-store-resumable")).toBe("true");
    expect(chatReq.headers.get("x-magpie-session-hint")).toBeNull();
    expect(JSON.parse(chatReq.body).reasoning_effort).toBe("high");

    // 5. Toggle strip_reasoning off and verify non-stream preserves reasoning_content
    optionState.strip_reasoning = false;
    const nonStreamRes = await loaderOpts.fetch(`${loaderOpts.baseURL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const nonStreamJson = await nonStreamRes.json();
    expect(nonStreamJson.choices[0].message.reasoning_content).toBe("chain");

    // 6. usage & checkin
    const usage = await hooks.auth.usage(async () => storedAuth);
    expect(usage.balance).toBe("42.5 credits");
    const checkin = await hooks.auth.checkin(async () => storedAuth);
    expect(checkin.outcome).toBe("done"); // already triggered by claim_daily_reward on first chat
  });
});
