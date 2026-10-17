import { test, expect } from "bun:test"
import { parseRecord, peekFirst, withPrefix, sseRecords } from "../lib/sse.mjs"

const bytes = (s) => new TextEncoder().encode(s)
const streamOf = (...parts) => new ReadableStream({
  start(c) {
    for (const p of parts) c.enqueue(typeof p === "string" ? bytes(p) : p)
    c.close()
  },
})
const collect = async (body) => {
  let out = ""
  for await (const rec of sseRecords(body)) out += `[${rec.event}|${rec.data}]`
  return out
}

test("records parse with event, multi-line data and comments", () => {
  expect(parseRecord("event: error\ndata: a\ndata: b")).toEqual({ event: "error", data: "a\nb" })
  expect(parseRecord(": keep-alive\ndata: x")).toEqual({ event: "", data: "x" })
  expect(parseRecord(": only a comment")).toBeNull()
  expect(parseRecord("")).toBeNull()
})

test("a stream splits into records", async () => {
  const body = streamOf(
    'data: {"a":1}\n\n',
    "event: ping\ndata: x\n\n",
    "data: [DONE]\n\n",
  )
  expect(await collect(body)).toBe('[|{"a":1}][ping|x][|[DONE]]')
})

// 关键回归：peekFirst 不能丢字节 —— 首条的原文要能原样回放。
test("peekFirst returns the first record and replays every byte", async () => {
  const original = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n'
  const { record, raw, rest } = await peekFirst(streamOf(original))
  expect(record).toEqual({ event: "", data: '{"a":1}' })
  expect(raw).toBe('data: {"a":1}\n\n')
  let got = ""
  for await (const rec of sseRecords(withPrefix(raw, rest))) got += `[${rec.data}]`
  expect(got).toBe('[{"a":1}][{"b":2}][[DONE]]')
})

test("peekFirst handles a stream that ends without a blank line", async () => {
  const { record, raw, rest } = await peekFirst(streamOf('data: {"only":1}'))
  expect(record).toEqual({ event: "", data: '{"only":1}' })
  const parts = []
  for await (const rec of sseRecords(withPrefix(raw, rest))) parts.push(rec.data)
  expect(parts).toEqual(['{"only":1}'])
})

test("peekFirst copes with CRLF separators", async () => {
  const { record } = await peekFirst(streamOf('data: {"a":1}\r\n\r\nrest'))
  expect(record).toEqual({ event: "", data: '{"a":1}' })
})

// 多字节字符被切在块边界时不能变乱码：每条流各持一个 decoder。
test("a multi-byte character split across chunks survives", async () => {
  const all = bytes('data: 你好\n\n')
  const cut = 9 // 切在「你」的中间
  const body = streamOf(all.subarray(0, cut), all.subarray(cut))
  expect(await collect(body)).toBe("[|你好]")
})

test("peekFirst on an empty stream is null", async () => {
  const { record, raw } = await peekFirst(streamOf(""))
  expect(record).toBeNull()
  expect(raw).toBe("")
})

test("peekFirst with no stream", async () => {
  const { record, raw, rest } = await peekFirst(null)
  expect(record).toBeNull()
  expect(raw).toBe("")
  expect(rest).toBeNull()
})
