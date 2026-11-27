export const PROVIDER_ID = "mogick";
export const PROVIDER_NAME = "Mogick";

export const BASE_URL = "https://copilot.tongyuan.cc/api/v1";
export const UPSTREAM_CHAT_URL = `${BASE_URL}/chat/completions`;
export const UPSTREAM_MODEL_INFO_URL = `${BASE_URL}/application/modelinfo?app=mogick&version=3`;

export const OAUTH_BASE_URL = "https://login.tongyuan.cc/authentication/oauth2";
export const OAUTH_CLIENT_ID = "mogick";
export const OAUTH_SCOPE = "openid profile email";

export const BALANCE_URL = "https://api.tongyuan.cc/subscription/api/v1/user/balance";

export const APP_ID = "mogick";
export const CHAT_USER_AGENT = "Go-http-client/1.1";
export const SERVICE_USER_AGENT = "Go-http-client/2.0";

export const REFRESH_LEAD_MS = 15 * 60 * 1000;
export const DEFAULT_SESSION_DURATION_SEC = 7200;
export const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
export const DAILY_REWARD_TIMEOUT_MS = 5000;
export const USAGE_TIMEOUT_MS = 15000;

export const DEFAULT_OPTIONS = {
  fold_reasoning_effort: true,
  strip_mogick_args: true,
  strip_reasoning: true,
  // OpenCode / non-Magpie fallback (Magpie uses native auth.checkin in Advanced settings)
  claim_daily_reward: true,
};

export const PLUGIN_OPTIONS = [
  {
    key: "fold_reasoning_effort",
    label: "Fold reasoning_effort",
    labels: { zh: "折叠 reasoning_effort 思考强度", "zh-TW": "折疊 reasoning_effort 思考強度" },
    description: "Map minimal/medium/xhigh/ultra reasoning_effort values to low/high/max accepted by Mogick.",
    descriptions: {
      zh: "将客户端的 minimal/medium/xhigh/ultra 档位自动折叠为 Mogick 上游接受的 low/high/max。",
      "zh-TW": "將用戶端的 minimal/medium/xhigh/ultra 檔位自動折疊為 Mogick 上游接受的 low/high/max。",
    },
    default: true,
  },
  {
    key: "strip_mogick_args",
    label: "Strip _mogick_* args",
    labels: { zh: "剥离 _mogick_* 工具参数", "zh-TW": "剝離 _mogick_* 工具參數" },
    description: "Remove internal _mogick_* metadata fields from tool call arguments in requests and responses.",
    descriptions: {
      zh: "清理请求历史和响应 tool_calls 参数中的内部 _mogick_* 元数据字段。",
      "zh-TW": "清理請求歷史與回應 tool_calls 參數中的內部 _mogick_* 中繼資料欄位。",
    },
    default: true,
  },
  {
    key: "strip_reasoning",
    label: "Strip reasoning_content",
    labels: { zh: "剥离 reasoning_content", "zh-TW": "剝離 reasoning_content" },
    description: "Strip reasoning_content field from upstream chat completion responses and SSE deltas.",
    descriptions: {
      zh: "从非流式响应和流式 SSE delta 中移除 reasoning_content 思维链字段。",
      "zh-TW": "從非串流回應和串流 SSE delta 中移除 reasoning_content 思維鏈欄位。",
    },
    default: true,
  },
];

export const DEFAULT_MODELS = {
  "deepseek-v4.1-flash": {
    name: "DeepSeek V4.1 Flash",
    limit: { context: 1048576, output: 393216 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    variants: { low: {}, high: {}, max: {} },
  },
  "deepseek-v4-pro": {
    name: "DeepSeek V4 Pro",
    limit: { context: 1048576, output: 393216 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
    variants: { low: {}, high: {}, max: {} },
  },
  "glm-5.3": {
    name: "GLM 5.3",
    limit: { context: 1000000, output: 131072 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
    variants: { low: {}, high: {}, max: {} },
  },
  "glm-5.3-flash": {
    name: "GLM 5.3 Flash",
    limit: { context: 1000000, output: 131072 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image", "video"], output: ["text"] },
    variants: { low: {}, high: {}, max: {} },
  },
};
