import { describe, expect, test } from "bun:test";
import {
  OAuthError,
  extractAccountMeta,
  parseJwtClaims,
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceCode,
} from "../lib/oauth.mjs";

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("oauth", () => {
  test("parseJwtClaims & extractAccountMeta extract user fields and expiry", () => {
    const jwt = makeJwt({ sub: "u_123", nickname: "Ethan", email: "ethan@example.com", exp: 1800000000 });
    const claims = parseJwtClaims(jwt);
    expect(claims.sub).toBe("u_123");

    const meta = extractAccountMeta(jwt, 7200, 1000_000);
    expect(meta.accountId).toBe("Ethan");
    expect(meta.uid).toBe("u_123");
    expect(meta.expires).toBe(1000_000 + 7200 * 1000);

    const metaFromExp = extractAccountMeta(jwt, 0, 1000_000);
    expect(metaFromExp.expires).toBe(1800000000 * 1000);
    expect(parseJwtClaims("not-a-jwt")).toEqual({});
  });

  test("requestDeviceCode sends form request and parses response", async () => {
    let seen = null;
    const fetchFn = async (url, init) => {
      seen = { url, method: init.method, body: init.body, headers: init.headers };
      return new Response(
        JSON.stringify({
          device_code: "dev_abc",
          user_code: "ABCD-EFGH",
          verification_uri: "https://login.tongyuan.cc/device",
          verification_uri_complete: "https://login.tongyuan.cc/device?user_code=ABCD-EFGH",
          interval: 3,
          expires_in: 600,
        }),
        { status: 200 },
      );
    };

    const dev = await requestDeviceCode({ fetchFn });
    expect(seen.url).toBe("https://login.tongyuan.cc/authentication/oauth2/device/code");
    expect(seen.method).toBe("POST");
    expect(seen.body).toContain("client_id=mogick");
    expect(dev.device_code).toBe("dev_abc");
    expect(dev.user_code).toBe("ABCD-EFGH");
    expect(dev.interval).toBe(3);
  });

  test("pollDeviceToken handles authorization_pending, slow_down, and success", async () => {
    const sleeps = [];
    let attempt = 0;
    const jwt = makeJwt({ sub: "u_1", email: "a@b.com" });

    const fetchFn = async () => {
      attempt++;
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
      }
      if (attempt === 2) {
        return new Response(JSON.stringify({ code: 400, data: { errorCode: "slow_down" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          access_token: jwt,
          refresh_token: "rt_new",
          expires_in: 7200,
        }),
        { status: 200 },
      );
    };

    let now = 10_000;
    const result = await pollDeviceToken({
      deviceCode: "dev_1",
      intervalSec: 2,
      expiresInSec: 300,
      fetchFn,
      nowFn: () => now,
      sleepFn: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    expect(sleeps).toEqual([2000, 2000, 7000]);
    expect(result).toEqual({
      type: "success",
      refresh: "rt_new",
      access: jwt,
      expires: now + 7200 * 1000,
      accountId: "a@b.com",
      uid: "u_1",
    });
  });

  test("pollDeviceToken stops on abort and expired code", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const aborted = await pollDeviceToken({
      deviceCode: "dev_1",
      signal: ctl.signal,
      fetchFn: async () => new Response("{}", { status: 400 }),
    });
    expect(aborted.type).toBe("failed");

    const expired = await pollDeviceToken({
      deviceCode: "dev_2",
      intervalSec: 1,
      expiresInSec: 60,
      sleepFn: async () => {},
      fetchFn: async () => new Response(JSON.stringify({ error: "expired_token" }), { status: 400 }),
    });
    expect(expired.type).toBe("failed");
    expect(expired.error).toContain("过期");
  });

  test("refreshAccessToken supports wrapped response and marks invalid_grant expired", async () => {
    const jwt = makeJwt({ sub: "u_9", nickname: "Neo" });
    const ok = await refreshAccessToken({
      refreshToken: "rt_1",
      nowFn: () => 5000,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            code: 200,
            data: { access_token: jwt, refresh_token: "rt_2", expires_in: 3600 },
          }),
          { status: 200 },
        ),
    });
    expect(ok.access).toBe(jwt);
    expect(ok.refresh).toBe("rt_2");
    expect(ok.expires).toBe(5000 + 3600 * 1000);
    expect(ok.accountId).toBe("Neo");

    let caught = null;
    try {
      await refreshAccessToken({
        refreshToken: "rt_bad",
        fetchFn: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OAuthError);
    expect(caught.signIn).toBe("expired");
  });
});
