import { describe, expect, test } from "bun:test";
import {
  createSseTransformStream,
  decodeToolName,
  encodeToolName,
  foldReasoningEffort,
  rewriteCompletionResponse,
  rewriteRequestBody,
  rewriteSseFrame,
  stripMogickArgs,
} from "../lib/transform.mjs";

describe("transform", () => {
  test("encodeToolName & decodeToolName round-trip dotted tool names", () => {
    expect(encodeToolName("file.read")).toBe("file__dot__read");
    expect(decodeToolName("file__dot__read")).toBe("file.read");
    expect(encodeToolName("bash")).toBe("bash");
  });

  test("stripMogickArgs removes _mogick_* fields only from valid JSON objects", () => {
    expect(stripMogickArgs('{"path":"a.txt","_mogick_trace":"x","_mogick_id":1}')).toBe('{"path":"a.txt"}');
    expect(stripMogickArgs('{"path":"a.txt"}')).toBe('{"path":"a.txt"}');
    expect(stripMogickArgs('{"path":"partial')).toBe('{"path":"partial');
  });

  test("foldReasoningEffort folds minimal/medium/xhigh/ultra and deletes unset", () => {
    const cases = [
      [{ reasoning_effort: "minimal" }, "low"],
      [{ reasoning_effort: "medium" }, "high"],
      [{ reasoning_effort: "xhigh" }, "high"],
      [{ reasoning_effort: "ultra" }, "max"],
      [{ reasoning_effort: "low" }, "low"],
      [{ reasoning_effort: "none" }, "none"],
      [{ reasoning_effort: "custom" }, "custom"],
    ];
    for (const [obj, expected] of cases) {
      foldReasoningEffort(obj, true);
      expect(obj.reasoning_effort).toBe(expected);
    }

    const unsetObj = { reasoning_effort: "unset" };
    foldReasoningEffort(unsetObj, true);
    expect("reasoning_effort" in unsetObj).toBe(false);

    const disabledObj = { reasoning_effort: "medium" };
    foldReasoningEffort(disabledObj, false);
    expect(disabledObj.reasoning_effort).toBe("medium");
  });

  test("rewriteRequestBody encodes tool names, strips tool role name, folds effort, and keeps explicit stream", () => {
    const input = JSON.stringify({
      model: "deepseek-v4-flash",
      reasoning_effort: "medium",
      tools: [{ type: "function", function: { name: "file.read", parameters: {} } }],
      messages: [
        { role: "user", name: "ethan", content: "hi" },
        {
          role: "assistant",
          tool_calls: [{ id: "c1", type: "function", function: { name: "file.read", arguments: '{"p":"1","_mogick_x":2}' } }],
        },
        { role: "tool", name: "file.read", tool_call_id: "c1", content: "ok" },
      ],
    });

    const out = rewriteRequestBody(input, { stream: false });
    const parsed = JSON.parse(out.body);
    expect(parsed.stream).toBe(false);
    expect(parsed.reasoning_effort).toBe("high");
    expect(parsed.tools[0].function.name).toBe("file__dot__read");
    expect(parsed.messages[0].name).toBe("ethan");
    expect(parsed.messages[1].tool_calls[0].function.name).toBe("file__dot__read");
    expect(parsed.messages[1].tool_calls[0].function.arguments).toBe('{"p":"1"}');
    expect("name" in parsed.messages[2]).toBe(false);
  });

  test("rewriteCompletionResponse restores model, decodes tool names, strips _mogick_* and reasoning_content", () => {
    const raw = JSON.stringify({
      id: "chatcmpl_1",
      model: "deepseek-v4-flash-0731",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            reasoning_content: "secret chain",
            tool_calls: [
              { id: "tc1", type: "function", function: { name: "file__dot__write", arguments: '{"a":1,"_mogick_meta":true}' } },
            ],
          },
        },
      ],
    });

    const res = JSON.parse(
      rewriteCompletionResponse(raw, {
        clientModel: "deepseek-v4-flash",
        stripMogickArgs: true,
        stripReasoning: true,
      }),
    );
    expect(res.model).toBe("deepseek-v4-flash");
    expect("reasoning_content" in res.choices[0].message).toBe(false);
    expect(res.choices[0].message.tool_calls[0].function.name).toBe("file.write");
    expect(res.choices[0].message.tool_calls[0].function.arguments).toBe('{"a":1}');
  });

  test("createSseTransformStream backfills empty tool_call fields, keeps partial JSON chunks, and handles usage frames", async () => {
    const frames = [
      `data: ${JSON.stringify({
        model: "deepseek-v4-flash-0731",
        choices: [{ index: 0, delta: { reasoning_content: "thinking..." } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        model: "deepseek-v4-flash-0731",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "file__dot__read", arguments: '{"pa' } }],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        model: "deepseek-v4-flash-0731",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "", type: "", function: { name: "", arguments: 'th":"a.txt"}' } }],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        model: "deepseek-v4-flash-0731",
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Split awkwardly across frame boundaries to test buffering
        controller.enqueue(encoder.encode(frames.slice(0, 75)));
        controller.enqueue(encoder.encode(frames.slice(75)));
        controller.close();
      },
    });

    const transformed = stream.pipeThrough(
      createSseTransformStream({
        clientModel: "deepseek-v4-flash",
        stripMogickArgs: true,
        stripReasoning: true,
      }),
    );

    const outText = await new Response(transformed).text();
    const blocks = outText.trim().split("\n\n");
    expect(blocks.length).toBe(5);

    const f0 = JSON.parse(blocks[0].replace(/^data: /, ""));
    expect(f0.model).toBe("deepseek-v4-flash");
    expect("reasoning_content" in f0.choices[0].delta).toBe(false);

    const f1 = JSON.parse(blocks[1].replace(/^data: /, ""));
    expect(f1.choices[0].delta.tool_calls[0].function.name).toBe("file.read");
    expect(f1.choices[0].delta.tool_calls[0].function.arguments).toBe('{"pa');

    const f2 = JSON.parse(blocks[2].replace(/^data: /, ""));
    expect(f2.choices[0].delta.tool_calls[0].id).toBe("call_1");
    expect(f2.choices[0].delta.tool_calls[0].type).toBe("function");
    expect(f2.choices[0].delta.tool_calls[0].function.name).toBe("file.read");
    expect(f2.choices[0].delta.tool_calls[0].function.arguments).toBe('th":"a.txt"}');

    const f3 = JSON.parse(blocks[3].replace(/^data: /, ""));
    expect(f3.model).toBe("deepseek-v4-flash");
    expect(f3.usage.prompt_tokens).toBe(10);

    expect(blocks[4]).toBe("data: [DONE]");
    expect(rewriteSseFrame("[DONE]")).toBe("[DONE]");
  });
});
