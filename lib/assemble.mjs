// 非流式调用方的重组：上游只会以 SSE 作答（stream:true），或直接给一个完整
// 的 chat.completion（stream:false）。两种都要能交回一个标准的
// chat.completion —— 从 SSE 重组时把 content、reasoning_content 和
// tool_calls 的分片按顺序接起来。

import { randomBytes } from "node:crypto"
import { sseRecords } from "./sse.mjs"

const newId = () => "chatcmpl-" + randomBytes(12).toString("hex")

// records: 可迭代的 {event, data}。返回一个 chat.completion 对象。
export async function mergeRecords(records, model) {
  const out = {
    id: newId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
  }
  const calls = new Map()
  let content = ""
  let reasoning = ""
  let usage

  for await (const rec of records) {
    // 上游若在流里报错（event: error），交给调用方按错误处理
    if (rec.event === "error") {
      const e = new Error("Loomy 在回复中途报了错")
      e.payload = rec.data
      throw e
    }
    if (rec.data === "[DONE]") break
    let v
    try {
      v = JSON.parse(rec.data)
    } catch {
      continue
    }
    if (v?.usage) usage = v.usage
    const ch = v?.choices?.[0]
    if (!ch) continue
    const d = ch.delta ?? {}
    if (typeof d.content === "string") content += d.content
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? 0
      let c = calls.get(i)
      if (!c) {
        c = { id: "", type: "function", function: { name: "", arguments: "" } }
        calls.set(i, c)
      }
      if (tc.id) c.id = tc.id
      if (tc.type) c.type = tc.type
      if (tc.function?.name) c.function.name = tc.function.name
      if (typeof tc.function?.arguments === "string") c.function.arguments += tc.function.arguments
    }
    if (ch.finish_reason) out.choices[0].finish_reason = ch.finish_reason
  }

  const msg = out.choices[0].message
  msg.content = content
  if (reasoning) msg.reasoning_content = reasoning
  if (calls.size > 0) {
    msg.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
    // OpenAI 的约定：只有工具调用时 content 为 null
    if (!content) msg.content = null
  }
  if (usage) out.usage = usage
  return out
}

// 从 SSE 字节流重组。
export function mergeStream(body, model) {
  return mergeRecords(sseRecords(body), model)
}
