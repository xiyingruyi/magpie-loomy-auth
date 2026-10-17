// 请求管线：magpie 把 AI SDK 的 fetch 交到这里，这里把它接到 Loomy 的
// OpenAI 兼容网关。
//
// 上游的三个行为必须处理：
//   1. **登录失效回 HTTP 200**，body 里 code=100002/020002（实测）。原样透传
//      会让 magpie 以为请求成功，账号的失效标记永远打不上。
//   2. 对话端点认 `Authorization: Bearer`，清单/积分端点认 `token` —— 两个都发。
//   3. Content-Type 必须带 charset=utf-8，否则上游按 GBK 解 body，中文乱码。
//
// 插件这边有一个契约：**fetch 抛错只能变成一条没有上下文的失败**。所以所有
// 异常（包括 getAuth 自己抛）都在这里折成带状态码的 Response。

import { AUTH_CODES, MODEL_BASE } from "./constants.mjs"
import { codeOf, messageOf, toNum } from "./http.mjs"
import { adaptBody } from "./thinking.mjs"
import { peekFirst, withPrefix } from "./sse.mjs"
import { mergeStream } from "./assemble.mjs"

// 上游的限流文案 / 额度耗尽文案。上游目前用业务码表达，但状态码兜底也要有：
// 上游一旦改用 HTTP 状态，magpie 的故障切换得能看懂。
const LIMIT_WORDS = /限流|频率|过快|过于频繁|rate ?limit|too many|too frequent/i
const USED_UP_WORDS = /额度已用完|额度不足|额度耗尽|积分不足|余额不足|请升级套餐|quota|insufficient/i

// 业务码 → HTTP 状态。magpie 按状态码决定「换账号 / 等一会儿 / 标失效 / 停下」
// 这几种处置，映射必须按语义来。
export function statusFor(code, message) {
  const text = String(message ?? "")
  if (AUTH_CODES.has(String(code))) return 401
  const n = toNum(code)
  if (n === 40100 || n === 51102) return 401
  if (n === 40201 || n === 40200) return 402
  if (n === 40300 || n === 40301) return 403
  if (n === 42900 || n === 42901) return 429
  if (LIMIT_WORDS.test(text)) return 429
  if (USED_UP_WORDS.test(text)) return 402
  return 400
}

const TYPE_FOR = { 401: "authentication_error", 402: "insufficient_quota", 429: "rate_limit_error", 403: "permission_error" }

export function errorResponse(status, message, code) {
  const headers = { "content-type": "application/json" }
  // 401 带 X-Magpie-Sign-In: expired，magpie 才会把账号标成 lapsed
  if (status === 401) headers["X-Magpie-Sign-In"] = "expired"
  const error = { message, type: TYPE_FOR[status] ?? "api_error" }
  const c = toNum(code)
  if (c !== null) error.code = c
  return new Response(JSON.stringify({ error }), { status, headers })
}

const successHeaders = (init) => {
  const h = new Headers(init)
  // 成功也要带 kept：插件不自己续期，用的就是存下来的 session。
  // magpie 靠这个头把账号上的失效标记清掉。
  h.set("X-Magpie-Sign-In", "kept")
  return h
}

// 读请求体。宿主可能给字符串，也可能给字节（bodyOf 在非 UTF-8 时保留字节）。
function rawBodyOf(input, init) {
  const b = init?.body
  if (typeof b === "string") return b
  if (b instanceof Uint8Array) return new TextDecoder().decode(b)
  if (b instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(b))
  if (b == null) return ""
  return String(b)
}

// 上游回了一个 JSON（而非 SSE）时的处理：它可能是业务错误，也可能是完整的
// completion（stream:false 的正常回答）。
async function jsonAnswer(res) {
  const text = await res.text().catch(() => "")
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    return errorResponse(502, `Loomy 上游返回了无法解析的内容（HTTP ${res.status}）`)
  }
  const code = codeOf(payload)
  if (AUTH_CODES.has(code)) return errorResponse(401, messageOf(payload) || "Loomy 登录态已失效，请重新登录", code)
  if (code && code !== "000000") {
    const message = messageOf(payload) || `Loomy 上游返回 code=${code}`
    return errorResponse(statusFor(code, message), message, code)
  }
  if (!res.ok) return errorResponse(res.status, `Loomy 上游返回 HTTP ${res.status}`, code)
  // 正常：OpenAI 形状的 completion 原样交回（补 kept 头）
  return new Response(text, { status: 200, headers: successHeaders({ "content-type": "application/json" }) })
}

// makeFetch 的依赖全部注入：单测里不需要真的网络，也不需要 magpie 宿主。
//
//   getAuth()   读当前账号（异步，必须 await）
//   sessionOf() 从账号里取 session（签名/来源可能变，见 index.mjs）
//   profileOf(auth) → (model) => 模型能力 { reasoning, tagImages }，未知返回 undefined
//   call()      真正的 fetch，测试里替掉
export function makeFetch({ getAuth, sessionOf, profileOf, call = fetch, base = MODEL_BASE }) {
  return async function loomyFetch(input, init = {}) {
    // 只服务对话补全。AI SDK 的其它端点（embeddings 等）上游没有，必须回
    // 404，而不是把请求改道成一次对话。
    let pathname = ""
    try {
      pathname = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname
    } catch {
      return errorResponse(400, "Loomy：请求地址无法解析")
    }
    if (!/\/chat\/completions$/.test(pathname)) return errorResponse(404, "Loomy：只提供 chat completions")

    // getAuth 自己也可能抛（宿主重载 / 账号被删）。抛出去只会让 magpie 记一条
    // 没有上下文的失败，折成 401 才能让它去提示重新登录。
    let auth
    try {
      auth = await getAuth()
    } catch (e) {
      return errorResponse(401, e?.message ?? "Loomy：登录信息不可用")
    }
    let session = ""
    try {
      session = String((await sessionOf(auth)) ?? "").trim()
    } catch (e) {
      return errorResponse(401, e?.message ?? "Loomy：登录信息不可用")
    }
    if (!session) return errorResponse(401, "Loomy：尚未登录")

    // 请求体必须是 JSON 对象。解析失败不能兜成 {} 发上去：那会把一个坏请求
    // 变成一个「模型没填」的上游错误，错误归因就跑到上游头上了。
    const raw = rawBodyOf(input, init)
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      return errorResponse(400, "Loomy：请求体不是合法 JSON")
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse(400, "Loomy：请求体不是 JSON 对象")
    }

    try {
      adaptBody(body, profileOf?.(auth)?.(body.model))
    } catch {
      // 改写失败不能连累请求本身：原样发出去
    }

    const url = `${base()}/chat/completions`
    let res
    try {
      res = await call(url, {
        method: init.method ?? "POST",
        headers: {
          // charset=utf-8 是必须的：没有它上游按 GBK 解 body
          "content-type": "application/json;charset=utf-8",
          accept: "text/event-stream",
          token: session,
          authorization: `Bearer ${session}`,
        },
        body: JSON.stringify(body),
        signal: init.signal,
      })
    } catch (e) {
      return errorResponse(502, e?.message ?? String(e))
    }

    // 状态码层面的失效（上游理论上不用，但多一道保险）
    if (res.status === 401 || res.status === 403) {
      return errorResponse(401, "Loomy 登录态已失效，请重新登录")
    }
    const ctype = res.headers.get("content-type") ?? ""
    if (!ctype.includes("event-stream")) {
      // 上游把业务错误放在 200 的 JSON 里，或者 stream:false 的完整回答
      return jsonAnswer(res)
    }
    if (!res.ok) {
      return errorResponse(res.status, `Loomy 上游返回 HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 2000) || "无错误说明"}`)
    }

    // SSE：先看首条。上游可能把错误作为首条 JSON（非 event 流）发出来；
    // 正常时把首条原样放回去，一个字节都不改。
    let head
    try {
      head = await peekFirst(res.body)
    } catch (e) {
      return errorResponse(502, e?.message ?? "Loomy：读取上游响应失败")
    }
    const first = head.record
    if (first) {
      let payload = null
      try {
        payload = first.data ? JSON.parse(first.data) : null
      } catch {
        payload = null
      }
      const code = codeOf(payload)
      if (AUTH_CODES.has(code)) return errorResponse(401, messageOf(payload) || "Loomy 登录态已失效，请重新登录", code)
      if (code && code !== "000000") {
        const message = messageOf(payload) || `Loomy 上游返回 code=${code}`
        return errorResponse(statusFor(code, message), message, code)
      }
      if (first.event === "error") {
        const message = messageOf(payload) || first.data || "Loomy 上游在流里报错"
        return errorResponse(statusFor(codeOf(payload), message), message, codeOf(payload))
      }
    }

    const headers = successHeaders({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" })
    const stream = withPrefix(head.raw, head.rest)
    // 非流式调用方（stream:false）拿到的是被上游按流发出的事件，这里重组
    if (body.stream === false) {
      try {
        const merged = await mergeStream(stream, body.model)
        return new Response(JSON.stringify(merged), { status: 200, headers: successHeaders({ "content-type": "application/json" }) })
      } catch (e) {
        return errorResponse(502, e?.message ?? "Loomy：重组回复失败")
      }
    }
    return new Response(stream, { status: 200, headers })
  }
}
