const DOT_TOKEN = "__dot__";
const MOGICK_ARG_PREFIX = "_mogick_";

const REASONING_EFFORT_MAP = {
  none: "none",
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "max",
  ultra: "max",
};

export function encodeToolName(name) {
  return typeof name === "string" ? name.replaceAll(".", DOT_TOKEN) : name;
}

export function decodeToolName(name) {
  return typeof name === "string" ? name.replaceAll(DOT_TOKEN, ".") : name;
}

export function stripMogickArgs(argsStr) {
  if (typeof argsStr !== "string" || argsStr === "") return argsStr;
  let parsed;
  try {
    parsed = JSON.parse(argsStr);
  } catch {
    return argsStr;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return argsStr;
  }
  let removed = false;
  for (const key of Object.keys(parsed)) {
    if (key.startsWith(MOGICK_ARG_PREFIX)) {
      delete parsed[key];
      removed = true;
    }
  }
  return removed ? JSON.stringify(parsed) : argsStr;
}

export function foldReasoningEffort(obj, enabled = true) {
  if (!enabled || !obj || typeof obj !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(obj, "reasoning_effort")) return false;
  const raw = obj.reasoning_effort;
  if (typeof raw !== "string") return false;

  const normalized = raw.trim().toLowerCase();
  if (normalized === "" || normalized === "unset") {
    delete obj.reasoning_effort;
    return true;
  }
  const mapped = REASONING_EFFORT_MAP[normalized];
  if (!mapped) return false;
  if (mapped === raw) return false;
  obj.reasoning_effort = mapped;
  return true;
}

export function rewriteRequestBody(bodyInput, options = {}) {
  const {
    model = "",
    stream = false,
    foldReasoningEffort: shouldFoldEffort = true,
    stripMogickArgs: shouldStripArgs = true,
  } = options;

  if (bodyInput == null) {
    return { body: bodyInput, clientModel: model, isStream: Boolean(stream) };
  }

  let text;
  if (typeof bodyInput === "string") {
    text = bodyInput;
  } else if (ArrayBuffer.isView(bodyInput)) {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bodyInput);
  } else {
    return { body: bodyInput, clientModel: model, isStream: Boolean(stream) };
  }

  if (!text) {
    return { body: bodyInput, clientModel: model, isStream: Boolean(stream) };
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { body: bodyInput, clientModel: model, isStream: Boolean(stream) };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { body: bodyInput, clientModel: model, isStream: Boolean(stream) };
  }

  const clientModel = typeof obj.model === "string" && obj.model ? obj.model : model;
  if (!obj.model && model) {
    obj.model = model;
  }

  if (typeof obj.stream !== "boolean") {
    obj.stream = Boolean(stream);
  }
  const isStream = Boolean(obj.stream);

  foldReasoningEffort(obj, shouldFoldEffort);

  if (Array.isArray(obj.tools)) {
    for (const tool of obj.tools) {
      if (tool?.function && typeof tool.function.name === "string") {
        tool.function.name = encodeToolName(tool.function.name);
      }
    }
  }

  if (Array.isArray(obj.messages)) {
    for (const msg of obj.messages) {
      if (!msg || typeof msg !== "object") continue;
      if (msg.role === "tool") {
        delete msg.name;
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc?.function) continue;
          if (typeof tc.function.name === "string") {
            tc.function.name = encodeToolName(tc.function.name);
          }
          if (shouldStripArgs && typeof tc.function.arguments === "string") {
            tc.function.arguments = stripMogickArgs(tc.function.arguments);
          }
        }
      }
    }
  }

  return {
    body: JSON.stringify(obj),
    clientModel,
    isStream,
  };
}

export function rewriteCompletionResponse(rawText, options = {}) {
  const {
    clientModel = "",
    stripMogickArgs: shouldStripArgs = true,
    stripReasoning = true,
  } = options;

  if (typeof rawText !== "string" || !rawText) return rawText;
  let obj;
  try {
    obj = JSON.parse(rawText);
  } catch {
    return rawText;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return rawText;

  let modified = false;
  if (clientModel && typeof obj.model === "string" && obj.model !== clientModel) {
    obj.model = clientModel;
    modified = true;
  }

  if (Array.isArray(obj.choices)) {
    for (const choice of obj.choices) {
      const msg = choice?.message;
      if (!msg || typeof msg !== "object") continue;

      if (stripReasoning && Object.prototype.hasOwnProperty.call(msg, "reasoning_content")) {
        delete msg.reasoning_content;
        modified = true;
      }

      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc?.function) continue;
          if (typeof tc.function.name === "string") {
            const decoded = decodeToolName(tc.function.name);
            if (decoded !== tc.function.name) {
              tc.function.name = decoded;
              modified = true;
            }
          }
          if (shouldStripArgs && typeof tc.function.arguments === "string") {
            const stripped = stripMogickArgs(tc.function.arguments);
            if (stripped !== tc.function.arguments) {
              tc.function.arguments = stripped;
              modified = true;
            }
          }
        }
      }
    }
  }

  return modified ? JSON.stringify(obj) : rawText;
}

export class ToolCallAccumulator {
  constructor() {
    this.entries = new Map();
  }

  update(calls) {
    if (!Array.isArray(calls)) return;
    for (const tc of calls) {
      if (!tc || typeof tc !== "object") continue;
      const idx = typeof tc.index === "number" ? tc.index : 0;
      let entry = this.entries.get(idx);
      if (!entry) {
        entry = { id: "", type: "", name: "" };
        this.entries.set(idx, entry);
      }
      if (typeof tc.id === "string" && tc.id !== "") entry.id = tc.id;
      if (typeof tc.type === "string" && tc.type !== "") entry.type = tc.type;
      if (typeof tc.function?.name === "string" && tc.function.name !== "") {
        entry.name = decodeToolName(tc.function.name);
      }
    }
  }

  get(index) {
    return this.entries.get(index);
  }
}

export function rewriteSseFrame(dataStr, options = {}) {
  const {
    clientModel = "",
    stripMogickArgs: shouldStripArgs = true,
    stripReasoning = true,
    accumulator,
  } = options;

  if (typeof dataStr !== "string" || !dataStr || dataStr === "[DONE]") return dataStr;

  let obj;
  try {
    obj = JSON.parse(dataStr);
  } catch {
    return dataStr;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return dataStr;

  let modified = false;
  if (clientModel && typeof obj.model === "string" && obj.model !== clientModel) {
    obj.model = clientModel;
    modified = true;
  }

  if (!Array.isArray(obj.choices) || obj.choices.length === 0) {
    return modified ? JSON.stringify(obj) : dataStr;
  }

  for (const choice of obj.choices) {
    const delta = choice?.delta;
    if (!delta || typeof delta !== "object") continue;

    if (stripReasoning && Object.prototype.hasOwnProperty.call(delta, "reasoning_content")) {
      delete delta.reasoning_content;
      modified = true;
    }

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      if (accumulator) accumulator.update(delta.tool_calls);

      for (const tc of delta.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const idx = typeof tc.index === "number" ? tc.index : 0;
        const acc = accumulator?.get(idx);

        if ((tc.id === "" || tc.id === undefined) && acc?.id) {
          tc.id = acc.id;
          modified = true;
        }
        if ((tc.type === "" || tc.type === undefined) && acc?.type) {
          tc.type = acc.type;
          modified = true;
        }

        if (tc.function && typeof tc.function === "object") {
          if ((tc.function.name === "" || tc.function.name === undefined) && acc?.name) {
            tc.function.name = acc.name;
            modified = true;
          } else if (typeof tc.function.name === "string" && tc.function.name !== "") {
            const decoded = decodeToolName(tc.function.name);
            if (decoded !== tc.function.name) {
              tc.function.name = decoded;
              modified = true;
            }
          }

          if (shouldStripArgs && typeof tc.function.arguments === "string" && tc.function.arguments !== "") {
            const stripped = stripMogickArgs(tc.function.arguments);
            if (stripped !== tc.function.arguments) {
              tc.function.arguments = stripped;
              modified = true;
            }
          }
        }
      }
    }
  }

  return modified ? JSON.stringify(obj) : dataStr;
}

function rewriteSseBlock(blockText, options) {
  const lines = blockText.split("\n");
  const passthrough = [];
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
    } else if (line !== "") {
      passthrough.push(line);
    }
  }

  if (dataLines.length === 0) {
    return `${blockText}\n\n`;
  }

  const rawPayload = dataLines.join("\n");
  const rewritten = rewriteSseFrame(rawPayload, options);
  const outLines = [...passthrough];
  for (const dl of rewritten.split("\n")) {
    outLines.push(`data: ${dl}`);
  }
  return `${outLines.join("\n")}\n\n`;
}

export function createSseTransformStream(options = {}) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();
  const accumulator = new ToolCallAccumulator();
  const frameOptions = { ...options, accumulator };
  let buffer = "";

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      let sepIndex;
      while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        if (!block) continue;
        controller.enqueue(encoder.encode(rewriteSseBlock(block, frameOptions)));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (buffer.trim()) {
        controller.enqueue(encoder.encode(rewriteSseBlock(buffer.replace(/\n+$/, ""), frameOptions)));
      }
      buffer = "";
    },
  });
}
