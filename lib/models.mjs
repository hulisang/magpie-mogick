import {
  APP_ID,
  BASE_URL,
  MODEL_CACHE_TTL_MS,
  PROVIDER_ID,
  SERVICE_USER_AGENT,
  UPSTREAM_MODEL_INFO_URL,
} from "./constants.mjs";

const SCENE_LABELS = {
  default_model: "默认对话模型",
  default_light_model: "默认轻量模型",
  default_embedding_model: "默认向量化模型",
  default_image_understanding_model: "默认识图模型",
};

const ALL_MODALITIES = ["text", "image", "audio", "video", "pdf"];

export function formatSceneLabel(key) {
  return SCENE_LABELS[key] || key;
}

function buildModalityMap(list, defaultText = false) {
  const set = new Set(Array.isArray(list) ? list : []);
  if (set.size === 0 && defaultText) set.add("text");
  return Object.fromEntries(ALL_MODALITIES.map((k) => [k, set.has(k)]));
}

export function mapUpstreamModel(item, scenes = {}, baseUrl = BASE_URL) {
  const id = String(item?.id || "").trim();
  if (!id) return null;

  const inputList = Array.isArray(item.input_modalities)
    ? item.input_modalities
    : Array.isArray(item.input_modals)
      ? item.input_modals
      : ["text"];
  const outputList = Array.isArray(item.output_modalities)
    ? item.output_modalities
    : Array.isArray(item.output_modals)
      ? item.output_modals
      : ["text"];
  const inputMap = buildModalityMap(inputList, true);
  const outputMap = buildModalityMap(outputList, true);

  const efforts = Array.isArray(item.capabilities?.reasoning_efforts)
    ? item.capabilities.reasoning_efforts
    : Array.isArray(item.reasoning_efforts)
      ? item.reasoning_efforts
      : [];
  const variants = {};
  for (const effort of efforts) {
    if (typeof effort === "string" && effort.trim()) {
      variants[effort.trim()] = {};
    }
  }

  const reasoning = Boolean(item.capabilities?.reasoning ?? item.reasoning);
  const toolcall = Boolean(item.capabilities?.tool_calls ?? item.capabilities?.toolcall ?? item.tool_calls);
  const rateNum = Number(item.credit_consumption_rate);

  let description = typeof item.description === "string" ? item.description : "";
  const matchedScenes = Object.entries(scenes || {})
    .filter(([, modelId]) => modelId === id)
    .map(([sceneKey]) => `${formatSceneLabel(sceneKey)}：${id}`)
    .sort();

  if (matchedScenes.length > 0) {
    const sceneText = matchedScenes.join("；");
    description = description ? `${description}（场景：${sceneText}）` : `场景：${sceneText}`;
  }

  return {
    id,
    providerID: PROVIDER_ID,
    name: item.display_name || item.name || id,
    ...(description ? { description } : {}),
    api: {
      id,
      url: baseUrl,
      npm: "@ai-sdk/openai-compatible",
    },
    status: "active",
    limit: {
      context: Number(item.context_length) > 0 ? Number(item.context_length) : 0,
      output: item.output_limit != null && Number(item.output_limit) > 0 ? Number(item.output_limit) : 0,
    },
    capabilities: {
      reasoning,
      toolcall,
      attachment: inputList.some((m) => m !== "text"),
      input: inputMap,
      output: outputMap,
    },
    variants,
    ...(Number.isFinite(rateNum) && rateNum > 0 ? { rate: rateNum } : {}),
  };
}

export async function fetchUpstreamModels({
  url = UPSTREAM_MODEL_INFO_URL,
  baseUrl = BASE_URL,
  fetchFn = fetch,
  signal,
} = {}) {
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-app-id": APP_ID,
      "user-agent": SERVICE_USER_AGENT,
    },
    signal,
  });

  if (!res.ok) {
    throw new Error(`Mogick modelinfo returned HTTP ${res.status}`);
  }

  const payload = await res.json();
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.models)) {
    throw new Error("Mogick modelinfo response missing models array");
  }

  const out = {};
  for (const item of payload.models) {
    const mapped = mapUpstreamModel(item, payload.scenes, baseUrl);
    if (mapped) out[mapped.id] = mapped;
  }
  return out;
}

export class ModelCatalog {
  constructor({ ttlMs = MODEL_CACHE_TTL_MS, nowFn = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.nowFn = nowFn;
    this.cachedAt = 0;
    this.cachedModels = null;
    this.pending = null;
  }

  invalidate() {
    this.cachedAt = 0;
    this.cachedModels = null;
  }

  async getModels(fallbackModels = {}, opts = {}) {
    const now = this.nowFn();
    if (this.ttlMs > 0 && this.cachedModels && now - this.cachedAt < this.ttlMs) {
      return structuredClone(this.cachedModels);
    }

    if (!this.pending) {
      this.pending = fetchUpstreamModels(opts)
        .then((models) => {
          this.cachedModels = models;
          this.cachedAt = this.nowFn();
          return models;
        })
        .finally(() => {
          this.pending = null;
        });
    }

    try {
      const models = await this.pending;
      return structuredClone(models);
    } catch {
      const fallback = structuredClone(fallbackModels || {});
      fallback[Symbol.for("magpie.fellBack")] = true;
      return fallback;
    }
  }
}
