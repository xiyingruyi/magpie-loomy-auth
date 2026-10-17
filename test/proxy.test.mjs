import { test, expect } from "bun:test"
import { statusFor, errorResponse, makeFetch } from "../lib/proxy.mjs"

const sse = (lines) => new Response(
  new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(new TextEncoder().encode(l))
      c.close()
    },
  }),
  { status: 200, headers: { "content-type": "text/event-stream" } },
)
const okStream = () => sse([
  'data: {"id":"c","model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
  "data: [DONE]\n\n",
])

const auth = () => ({ type: "oauth", access: "sess", accountId: "138****8000" })
const base = (over = {}) => ({
  getAuth: async () => auth(),
  sessionOf: (a) => a?.access ?? "",
  profileOf: () => undefined,
  call: async () => okStream(),
  ...over,
})

// 业务码 → 状态。这个映射决定 magpie 怎么处置账号，必须按语义来。
test("statusFor maps the upstream's business codes by meaning", () => {
  // 登录失效：两处上游都回 HTTP 200 + 这两个码
  expect(statusFor("100002", "登录已失效，请重新登录")).toBe(401)
  expect(statusFor("020002", "sign-in gone")).toBe(401)
  // 缺 token（实测无 token 访问）
  expect(statusFor("100002", "缺少 token")).toBe(401)
  // 额度用完：等一会儿不会好，不能退回 400
  expect(statusFor("40201", "免费额度已用完")).toBe(402)
  expect(statusFor("40200", "额度不足")).toBe(402)
  // 模型维度的拒绝
  expect(statusFor("40300", "不支持的模型")).toBe(403)
  expect(statusFor("40301", "模型不可见")).toBe(403)
  // 限流
  expect(statusFor("42900", "请求过于频繁")).toBe(429)
  // 没见过的 code 但文案在说额度用完 / 限流
  expect(statusFor("99999", "额度已用完，请升级套餐")).toBe(402)
  expect(statusFor("99999", "请求过于频繁，请稍后再试")).toBe(429)
  // 其余：请求本身有问题
  expect(statusFor("12345", "whatever")).toBe(400)
  expect(statusFor("", "")).toBe(400)
})

test("a 401 carries the lapse mark, others do not", async () => {
  const r401 = errorResponse(401, "no")
  expect(r401.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect((await r401.json()).error.type).toBe("authentication_error")
  const r402 = errorResponse(402, "quota", "40201")
  expect(r402.headers.get("X-Magpie-Sign-In")).toBeNull()
  const body = await r402.json()
  expect(body.error.type).toBe("insufficient_quota")
  expect(body.error.code).toBe(40201)
  const r429 = errorResponse(429, "slow")
  expect((await r429.json()).error.type).toBe("rate_limit_error")
})

test("a streaming answer passes through exactly as it came", async () => {
  let seen = null
  const f = makeFetch(base({
    call: async (url, init) => {
      seen = { url, init }
      return okStream()
    },
  }))
  const res = await f("https://gateway/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "spark-x", stream: true, messages: [{ role: "user", content: "hi" }] }),
  })
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  const text = await res.text()
  expect(text).toContain('"content":"hi"')
  expect(text).toContain("data: [DONE]")
  // 上游拿到的头：双凭据 + charset=utf-8
  expect(seen.init.headers.token).toBe("sess")
  expect(seen.init.headers.authorization).toBe("Bearer sess")
  expect(seen.init.headers["content-type"]).toBe("application/json;charset=utf-8")
  expect(seen.url).toMatch(/\/api\/v1\/chat\/completions$/)
})

test("a non-streaming caller gets one assembled completion", async () => {
  const f = makeFetch(base({
    call: async () => sse([
      'data: {"id":"c","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"你"}}]}\n\n',
      'data: {"id":"c","model":"m","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ]),
  }))
  const res = await f("https://gateway/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "m", stream: false, messages: [] }),
  })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.object).toBe("chat.completion")
  expect(body.choices[0].message.content).toBe("你好")
  expect(body.choices[0].finish_reason).toBe("stop")
  expect(body.usage.total_tokens).toBe(5)
})

// 上游最要命的一点：登录失效不是 401，而是 200 里带 business code。
test("a lapsed sign-in inside a 200 becomes a real 401", async () => {
  const f = makeFetch(base({
    call: async () => new Response(JSON.stringify({ code: "100002", desc: "登录已失效，请重新登录", data: {} }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  }))
  const res = await f("https://gateway/v1/chat/completions", { body: '{"model":"m","stream":true,"messages":[]}' })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect((await res.json()).error.message).toContain("登录已失效")
})

test("a business error on the first SSE frame becomes its status", async () => {
  const f = makeFetch(base({
    call: async () => sse([`data: ${JSON.stringify({ code: "40201", desc: "免费额度已用完" })}\n\n`]),
  }))
  const res = await f("https://gateway/v1/chat/completions", { body: '{"model":"m","stream":true,"messages":[]}' })
  expect(res.status).toBe(402)
  expect((await res.json()).error.message).toContain("额度已用完")
})

test("a quota business code in a 200 JSON is a 402", async () => {
  const f = makeFetch(base({
    call: async () => new Response(JSON.stringify({ code: "40201", desc: "免费额度已用完，请升级套餐" }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
  }))
  const res = await f("https://gateway/v1/chat/completions", { body: '{"model":"m","stream":false,"messages":[]}' })
  expect(res.status).toBe(402)
  expect((await res.json()).error.type).toBe("insufficient_quota")
})

test("an ordinary JSON completion passes straight through", async () => {
  const payload = { id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "你好" } }] }
  const f = makeFetch(base({
    call: async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
  }))
  const res = await f("https://gateway/v1/chat/completions", { body: '{"model":"m","stream":false,"messages":[]}' })
  expect(res.status).toBe(200)
  expect((await res.json()).id).toBe("c1")
})

test("a network failure is a 502, not a thrown error", async () => {
  const f = makeFetch(base({ call: async () => { throw new Error("ECONNREFUSED") } }))
  const res = await f("https://gateway/v1/chat/completions", { body: '{"model":"m","messages":[]}' })
  expect(res.status).toBe(502)
  expect((await res.json()).error.message).toContain("ECONNREFUSED")
})

// getAuth 自己抛错时不能把异常抛给 magpie（那只会记一条没有上下文的失败）
test("a getAuth that throws becomes 401", async () => {
  const f = makeFetch(base({ getAuth: async () => { throw new Error("auth store unavailable") } }))
  const res = await f("https://gateway/v1/chat/completions", { body: "{}" })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect((await res.json()).error.message).toContain("auth store unavailable")
})

test("not signed in is a 401 without calling upstream", async () => {
  let called = false
  const f = makeFetch(base({
    getAuth: async () => undefined,
    call: async () => { called = true; return okStream() },
  }))
  const res = await f("https://gateway/v1/chat/completions", { body: '{"model":"m","messages":[]}' })
  expect(res.status).toBe(401)
  expect(called).toBe(false)
})

// 解析失败不能兜成 {} 发上去：那会把坏请求变成上游的「模型没填」
test("an unparseable body is answered 400 before it reaches the upstream", async () => {
  let called = false
  const f = makeFetch(base({ call: async () => { called = true; return okStream() } }))
  for (const body of ["not json", "", "{", '{"a":']) {
    const res = await f("https://gateway/v1/chat/completions", { body })
    expect(res.status).toBe(400)
  }
  expect(called).toBe(false)
})

test("a non-object JSON body is answered 400", async () => {
  const f = makeFetch(base())
  for (const body of ["null", "true", "123", '"str"', "[]"]) {
    const res = await f("https://gateway/v1/chat/completions", { body })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain("JSON 对象")
  }
})

// 宿主把 body 以字节交进来时也要能读
test("a body handed over as bytes is still read", async () => {
  let seen = null
  const f = makeFetch(base({
    call: async (_u, init) => { seen = JSON.parse(init.body); return okStream() },
  }))
  const res = await f("https://gateway/v1/chat/completions", {
    body: new TextEncoder().encode(JSON.stringify({ model: "m", messages: [] })),
  })
  expect(res.status).toBe(200)
  expect(seen.model).toBe("m")
})

test("the body reaches the upstream folded and image-adapted", async () => {
  let seen = null
  const f = makeFetch(base({
    profileOf: () => (model) => ({ reasoning: true, tagImages: /deepseek/i.test(model) }),
    call: async (_u, init) => { seen = JSON.parse(init.body); return okStream() },
  }))
  await f("https://gateway/v1/chat/completions", {
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      stream: true,
      reasoning_effort: "max",
      messages: [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,QQ" } }] }],
    }),
  })
  expect(seen.reasoning_effort).toBe("high")
  expect(seen.messages[0].content).toHaveLength(1)
  expect(seen.messages[0].content[0].text).toContain("<image_base64>")
})

test("a profile lookup that throws does not sink the request", async () => {
  let seen = null
  const f = makeFetch(base({
    profileOf: () => { throw new Error("boom") },
    call: async (_u, init) => { seen = JSON.parse(init.body); return okStream() },
  }))
  const res = await f("https://gateway/v1/chat/completions", { body: '{"model":"m","messages":[]}' })
  expect(res.status).toBe(200)
  expect(seen.model).toBe("m")
})

test("a real 401 from upstream is passed on with the lapse mark", async () => {
  const f = makeFetch(base({
    call: async () => new Response('{"code":"100002","desc":"登录已失效，请重新登录"}', { status: 401 }),
  }))
  const res = await f("https://gateway/v1/chat/completions", { body: '{"model":"m","messages":[]}' })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
})

// 回归：首条就是错误时，上游响应体已经被 peekFirst 锁住；不取消它，连接要
// 等 GC 才还回去。取消要通过 peekFirst 交回的 rest 流（原流已被锁）。
test("a first-frame error cancels the upstream body instead of abandoning it", async () => {
  let cancelled = false
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ code: "42900", desc: "请求过于频繁" })}\n\n`))
    },
    cancel() {
      cancelled = true
    },
  })
  const f = makeFetch(base({
    call: async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
  }))
  const res = await f("https://gateway/v1/chat/completions", { body: '{"model":"m","stream":true,"messages":[]}' })
  expect(res.status).toBe(429)
  await new Promise((r) => setTimeout(r, 0))
  expect(cancelled).toBe(true)
})
