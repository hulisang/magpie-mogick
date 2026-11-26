import { describe, expect, test } from "bun:test";
import { ModelCatalog } from "../lib/models.mjs";
import {
  DailyRewardTracker,
  claimDailyRewardOnce,
  fetchBalance,
  formatUsageResult,
  nextUtcMidnightIso,
  runCheckin,
} from "../lib/usage.mjs";

describe("models & usage", () => {
  test("ModelCatalog fetches, maps variants/scenes, deduplicates concurrent calls, and falls back on error", async () => {
    let calls = 0;
    let now = 1000;
    const catalog = new ModelCatalog({ ttlMs: 600_000, nowFn: () => now });

    const fetchFn = async (_url, init) => {
      calls++;
      expect(init.headers["x-app-id"]).toBe("mogick");
      expect(init.headers.authorization).toBeUndefined();
      return new Response(
        JSON.stringify({
          models: [
            {
              id: "deepseek-v4-flash-vision-exp",
              display_name: "DeepSeek V4 Flash Vision Exp",
              context_length: 1000000,
              output_limit: 384000,
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
              capabilities: {
                reasoning: true,
                tool_calls: true,
                reasoning_efforts: ["low", "high", "xhigh"],
              },
            },
          ],
          scenes: { default_model: "deepseek-v4-flash-vision-exp" },
        }),
        { status: 200 },
      );
    };

    const [m1, m2] = await Promise.all([
      catalog.getModels({}, { fetchFn }),
      catalog.getModels({}, { fetchFn }),
    ]);
    expect(calls).toBe(1);
    expect(m1["deepseek-v4-flash-vision-exp"].variants).toEqual({ low: {}, high: {}, xhigh: {} });
    expect(m1["deepseek-v4-flash-vision-exp"].capabilities.input.image).toBe(true);
    expect(m1["deepseek-v4-flash-vision-exp"].description).toContain("默认对话模型");
    expect(m2["deepseek-v4-flash-vision-exp"].limit.output).toBe(384000);

    // Also verify live flat modelinfo shape (input_modals, top-level reasoning/tool_calls/reasoning_efforts)
    now += 700_000;
    const flatModels = await catalog.getModels({}, {
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                id: "deepseek-v4.1-flash",
                name: "DeepSeek V4.1 Flash",
                context_length: 1048576,
                output_limit: 393216,
                input_modals: ["text", "image"],
                output_modals: ["text"],
                reasoning: true,
                tool_calls: true,
                reasoning_efforts: ["low", "high", "max"],
                credit_consumption_rate: "0.364",
              },
            ],
            scenes: { default_image_understanding_model: "deepseek-v4.1-flash" },
          }),
          { status: 200 },
        ),
    });
    expect(flatModels["deepseek-v4.1-flash"].capabilities.reasoning).toBe(true);
    expect(flatModels["deepseek-v4.1-flash"].capabilities.toolcall).toBe(true);
    expect(flatModels["deepseek-v4.1-flash"].capabilities.input.image).toBe(true);
    expect(flatModels["deepseek-v4.1-flash"].variants).toEqual({ low: {}, high: {}, max: {} });
    expect(flatModels["deepseek-v4.1-flash"].rate).toBe(0.364);
    expect(flatModels["deepseek-v4.1-flash"].description).toContain("默认识图模型");

    // Advance past TTL and simulate upstream failure -> fallback with fellBack symbol
    now += 700_000;
    const fallback = { "fallback-model": { id: "fallback-model" } };
    const fb = await catalog.getModels(fallback, {
      fetchFn: async () => new Response("error", { status: 503 }),
    });
    expect(fb[Symbol.for("magpie.fellBack")]).toBe(true);
    expect(fb["fallback-model"].id).toBe("fallback-model");
  });

  test("fetchBalance & formatUsageResult build prepaid wallet and aside breakdown windows", async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({
          code: 0,
          message: "success",
          data: {
            user_id: "u_1",
            free_balance: "30",
            plan_balance: "20.3506",
            available_amount: "50.3146",
            active_hold_amount: "0.036",
            total_balance: "50.3506",
          },
        }),
        { status: 200 },
      );

    const data = await fetchBalance("tok_1", { fetchFn });
    const usage = formatUsageResult(data, { auth: { accountId: "Ethan" }, signIn: "kept" });
    expect(usage.user).toBe("Ethan");
    expect(usage.balance).toBe("50.3146 credits");
    expect(usage.signIn).toBe("kept");
    expect(usage.windows[0]).toEqual({
      name: "可用额度",
      balance: 50.3146,
      unit: "credits",
      display: "50.3146 credits",
    });
    expect(usage.windows[1].aside).toBe(true);
    expect(usage.windows[2].aside).toBe(true);
    expect(usage.windows[3].name).toBe("在途冻结");
  });

  test("DailyRewardTracker & runCheckin throttle per UTC day", async () => {
    let now = Date.UTC(2026, 10, 25, 10, 0, 0);
    const tracker = new DailyRewardTracker({ nowFn: () => now });
    let balanceCalls = 0;

    const fetchFn = async () => {
      balanceCalls++;
      return new Response(
        JSON.stringify({
          code: 0,
          data: { free_balance: "12", available_amount: "20" },
        }),
        { status: 200 },
      );
    };

    const r1 = await claimDailyRewardOnce("mogick", "tok_1", tracker, { fetchFn, nowFn: () => now });
    const r2 = await claimDailyRewardOnce("mogick", "tok_1", tracker, { fetchFn, nowFn: () => now });
    expect(r1.skipped).toBe(false);
    expect(r1.ok).toBe(true);
    expect(r2.skipped).toBe(true);
    expect(balanceCalls).toBe(1);

    // Same UTC day checkin reports "done"
    const c1 = await runCheckin("mogick", "tok_1", tracker, { fetchFn, nowFn: () => now });
    expect(c1.outcome).toBe("done");
    expect(c1.until).toBe(nextUtcMidnightIso(now));

    // Next UTC day checkin reports "claimed"
    now = Date.UTC(2026, 10, 26, 0, 1, 0);
    const c2 = await runCheckin("mogick", "tok_1", tracker, { fetchFn, nowFn: () => now });
    expect(c2.outcome).toBe("claimed");
    expect(c2.credit).toBe(2);
  });
});
