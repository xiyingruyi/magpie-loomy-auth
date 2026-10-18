import { test, expect } from "bun:test"
import { mergeStream } from "../lib/assemble.mjs"

// 上游即使 stream:false 也以 SSE 作答，这里把它重组回一个 chat.completion。
const sse = (chunks) =>
  new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk))
      c.close()
    },
  })
const frame = (delta, extra = {}) =>
  `data: ${JSON.stringify({ id: "c1", model: "m", choices: [{ index: 0, delta, ...extra }] })}\n\n`
const DONE = "data: [DONE]\n\n"

const merge = (chunks) => mergeStream(sse(chunks), "m")

test("content frames join in order and keep finish_reason", async () => {
  const out = await merge([
    frame({ role: "assistant", content: "你" }),
    frame({ content: "好" }),
    frame({}, { finish_reason: "stop" }),
    DONE,
  ])
  expect(out.object).toBe("chat.completion")
  expect(out.model).toBe("m")
  expect(out.choices[0].message.content).toBe("你好")
  expect(out.choices[0].message.role).toBe("assistant")
  expect(out.choices[0].finish_reason).toBe("stop")
})

test("reasoning content is kept apart from the answer", async () => {
  const out = await merge([
    frame({ reasoning_content: "先想" }),
    frame({ reasoning_content: "一下" }),
    frame({ content: "答案" }),
    frame({}, { finish_reason: "stop" }),
    DONE,
  ])
  const msg = out.choices[0].message
  expect(msg.content).toBe("答案")
  expect(msg.reasoning_content).toBe("先想一下")
})

// 工具调用的分片按 index 归并，名字和参数分几帧到达也要拼对。
test("tool call fragments gather by index", async () => {
  const out = await merge([
    frame({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_time", arguments: "" } }] }),
    frame({ tool_calls: [{ index: 0, function: { arguments: '{"tz":' } }] }),
    frame({ tool_calls: [{ index: 0, function: { arguments: '"UTC"}' } }] }),
    frame({}, { finish_reason: "tool_calls" }),
    DONE,
  ])
  const msg = out.choices[0].message
  expect(out.choices[0].finish_reason).toBe("tool_calls")
  expect(msg.tool_calls).toHaveLength(1)
  expect(msg.tool_calls[0].id).toBe("call_1")
  expect(msg.tool_calls[0].function.name).toBe("get_time")
  expect(msg.tool_calls[0].function.arguments).toBe('{"tz":"UTC"}')
  // OpenAI 的约定：只有工具调用时 content 为 null
  expect(msg.content).toBeNull()
})

test("parallel tool calls come back in index order", async () => {
  const out = await merge([
    frame({ tool_calls: [{ index: 1, id: "b", function: { name: "two", arguments: "{}" } }] }),
    frame({ tool_calls: [{ index: 0, id: "a", function: { name: "one", arguments: "{}" } }] }),
    frame({}, { finish_reason: "tool_calls" }),
    DONE,
  ])
  expect(out.choices[0].message.tool_calls.map((c) => c.id)).toEqual(["a", "b"])
})

test("usage from the last frame is carried over", async () => {
  const out = await merge([
    frame({ content: "hi" }),
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { total_tokens: 7 } })}\n\n`,
    DONE,
  ])
  expect(out.usage.total_tokens).toBe(7)
})

// 回归：流干净结束却没有 finish_reason = 回复被截断。补一个 "stop" 会让调用方
// 把半截回答当成完整回答 —— 必须报错，由 proxy 折成 502。
test("a stream that ends without finish_reason is an error, not a stop", async () => {
  await expect(merge([frame({ content: "半截" }), DONE])).rejects.toThrow(/finish_reason/)
  // 连 [DONE] 都没有的情况同理
  await expect(merge([frame({ content: "半截" })])).rejects.toThrow(/finish_reason/)
})

// 上游在流中途报错：不能当成一次正常结束。
test("an error record in the middle throws", async () => {
  await expect(merge([
    frame({ content: "开始" }),
    `event: error\ndata: ${JSON.stringify({ code: "42900", desc: "请求过于频繁" })}\n\n`,
  ])).rejects.toThrow(/中途报了错/)
})

test("malformed frames are skipped, the rest still assembles", async () => {
  const out = await merge([
    "data: {not json}\n\n",
    frame({ content: "好" }),
    frame({}, { finish_reason: "stop" }),
    DONE,
  ])
  expect(out.choices[0].message.content).toBe("好")
})

test("an empty content answer still gets its finish_reason", async () => {
  const out = await merge([frame({ content: "" }), frame({}, { finish_reason: "length" })])
  expect(out.choices[0].message.content).toBe("")
  expect(out.choices[0].finish_reason).toBe("length")
})
