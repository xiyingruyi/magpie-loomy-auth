// 本地 fake 上游：账号域（校验 HMAC 签名的短信登录）+ 积分网关（模型、对话、
// 积分、签到、新手任务）。测试全程不触网、不使用真实 session。
//
// 账号域会把收到的请求**重新签一遍**并比对 —— 签名算法一旦写错（少一段、
// 转义不同、MD5 覆盖的字节不一致），这里就会 401，和真实上游的表现一致。

import { createHash, createHmac } from "node:crypto"

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const OK = "000000"

export const TASK_POINTS = {
  first_message: 500,
  pick_skill: 1000,
  generate_ppt: 1500,
  set_schedule: 1000,
  install_skill: 1500,
  configure_remote: 1000,
  create_soul: 1500,
  share_soul: 2000,
}

export function fakeLoomy({ phone = "13800138000" } = {}) {
  const state = {
    session: "sess-1",
    phone,
    smsSent: null,
    logins: 0,
    chatCalls: [],
    firstLoginCalls: 0,
    recordsReads: 0,
    modelsReads: 0,
    onboardingDone: {},
    onboardingQueries: 0,
    onboardingCompletes: 0,
    // 上游的每日赠送余额
    dailyBalance: 5000,
    permanentBalance: 1200,
    // 断言用：最近一次请求的头
    lastChatHeaders: null,
    // 让测试能改上游行为
    chatMode: "stream", // stream | json | json-error | sse-error | 401 | empty-sse | empty-json
    // 模型清单接口在真实上游**不返回业务码**，这里能切成那种形态
    modelsNoCode: false,
    // 额外的有效 session（默认只有一个账号）
    extraSessions: [],
    chatError: { code: "100002", desc: "登录已失效，请重新登录" },
    reset() {
      state.smsSent = null
      state.logins = 0
      state.chatCalls = []
      state.firstLoginCalls = 0
      state.recordsReads = 0
      state.modelsReads = 0
      state.onboardingDone = {}
      state.onboardingQueries = 0
      state.onboardingCompletes = 0
      state.dailyBalance = 5000
      state.lastChatHeaders = null
      state.chatMode = "stream"
      state.modelsNoCode = false
      state.extraSessions = []
    },
  }
  const AK = process.env.LOOMY_XFYUN_ACCESS_KEY_ID || "2thryby66wxi53sk"
  const SK = process.env.LOOMY_XFYUN_ACCESS_KEY_SECRET || "zsak6eadrbawz683wf5r3m2snrwj868r"

  const account = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const bodyString = await req.text()
      const auth = req.headers.get("authorization") ?? ""
      if (!auth.startsWith(`account ${AK}:`)) return json(401, { code: "020002", desc: "no signature" })
      const path = url.pathname
      let clean = path.startsWith("/") ? path : `/${path}`
      if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1)
      const escaped = clean
        .split("/")
        .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase()))
        .join("/")
      const md5 = bodyString ? createHash("md5").update(bodyString).digest("base64") : ""
      const date = req.headers.get("date") ?? ""
      const nonce = req.headers.get("nonce") ?? ""
      const stringToSign = ["POST", escaped, "", md5, "application/json", date, nonce, "", ""].join("\n")
      const expect = createHmac("sha1", SK).update(stringToSign).digest("base64")
      if (auth !== `account ${AK}:${expect}`) return json(401, { code: "020002", desc: "bad signature" })
      if (md5 && req.headers.get("content-md5") !== md5) return json(400, { code: "020003", desc: "md5 mismatch" })

      const body = JSON.parse(bodyString || "{}")
      // 客户端信封缺失是硬错误（真实上游同样按非客户端流量拒）
      if (!body?.base?.appid) return json(400, { code: "020004", desc: "missing base" })
      if (url.pathname === "/login/phone/sendMsgCode") {
        if (body?.param?.ccode !== "86") return json(400, { code: "020004", desc: "ccode" })
        if (body?.param?.phone !== state.phone) return json(400, { code: "020005", desc: "phone not found" })
        const msgid = `msg-${state.logins}-${Date.now()}`
        state.smsSent = { phone: body.param.phone, msgid }
        return json(200, { code: OK, desc: "sent", data: { msgid } })
      }
      if (url.pathname === "/login/phone/checkCode") {
        if (!state.smsSent || body?.param?.msgid !== state.smsSent.msgid) return json(200, { code: "210106", desc: "验证码已失效" })
        if (body?.param?.mcode !== "123456") return json(200, { code: "210107", desc: "验证码错误" })
        if (body?.param?.expire !== 1209600) return json(400, { code: "020006", desc: "expire" })
        state.logins++
        state.session = `sess-${state.logins}`
        return json(200, { code: OK, desc: "ok", data: { session: state.session, userid: "261014155255771375" } })
      }
      return json(404, { code: "020008", desc: "no route" })
    },
  })

  const gateway = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const token = req.headers.get("token") ?? ""
      const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
      // 第二个账号（测试缓存分桶用）：额外会话同样有效
      const known = token === state.session || state.extraSessions.includes(token)
      if (!known || bearer !== token) {
        // 真实上游的表现：HTTP 200 + code 100002
        return json(200, { code: "100002", desc: "登录已失效，请重新登录", data: {} })
      }
      if (url.pathname === "/api/v1/models") {
        state.modelsReads++
        return json(200, {
          ...(state.modelsNoCode ? {} : { code: OK, desc: "ok" }),
          data: [
            { id: "spark-x", name: "Spark X2.5 (x0.1)", capabilities: { reasoning: true, function_calling: true, vision: false }, context_window: 128000, max_tokens: 8192 },
            { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash 0731 (x3.0)", capabilities: { reasoning: true, function_calling: false, vision: true } },
            { id: "glm-5.3-flash", name: "GLM 5.3 Flash（x0.8）", capabilities: { reasoning: false, function_calling: false, vision: true } },
            { id: "plain", name: "No Suffix At All", capabilities: {} },
          ],
        })
      }
      if (url.pathname === "/api/v1/chat/completions") {
        const ct = req.headers.get("content-type") ?? ""
        state.lastChatHeaders = { contentType: ct, token: req.headers.get("token"), bearer: req.headers.get("authorization") }
        if (!/charset\s*=\s*"?utf-8/i.test(ct)) return json(400, { code: "100009", desc: "content-type must name utf-8" })
        const body = await req.json().catch(() => ({}))
        state.chatCalls.push({ body })
        if (state.chatMode === "401") return json(401, { code: "100002", desc: "登录已失效，请重新登录" })
        if (state.chatMode === "empty-json") {
          return new Response("", { headers: { "content-type": "application/json" } })
        }
        if (state.chatMode === "empty-sse") {
          // 200 + event-stream，一个字节都没有（上游把错误吞成空流的形态）
          return new Response(new ReadableStream({ start(c) { c.close() } }), {
            headers: { "content-type": "text/event-stream" },
          })
        }
        if (state.chatMode === "json-error") return json(200, { code: state.chatError.code, desc: state.chatError.desc, data: {} })
        if (state.chatMode === "sse-error") {
          return new Response(`data: ${JSON.stringify({ code: state.chatError.code, desc: state.chatError.desc })}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        }
        if (state.chatMode === "json") {
          return json(200, {
            id: "c1",
            object: "chat.completion",
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
          })
        }
        // 默认：SSE（上游即使 stream:false 也以 SSE 作答，这里给两种都要能用）
        const chunks = body.stream === false
          ? [
              `data: ${JSON.stringify({ id: "c1", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "你" } }] })}\n\n`,
              `data: ${JSON.stringify({ id: "c1", model: body.model, choices: [{ index: 0, delta: { content: "好" } }] })}\n\n`,
              `data: ${JSON.stringify({ id: "c1", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
              "data: [DONE]\n\n",
            ]
          : [
              `data: ${JSON.stringify({ id: "c1", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "你" } }] })}\n\n`,
              `data: ${JSON.stringify({ id: "c1", model: body.model, choices: [{ index: 0, delta: { content: "好" } }] })}\n\n`,
              `data: ${JSON.stringify({ id: "c1", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
              "data: [DONE]\n\n",
            ]
        return new Response(chunks.join(""), { headers: { "content-type": "text/event-stream" } })
      }
      if (url.pathname === "/api/v1/points/first-login") {
        state.firstLoginCalls++
        return json(200, { code: OK, desc: "ok", data: { dailyBalance: state.dailyBalance } })
      }
      if (url.pathname === "/api/v2/points/records") {
        state.recordsReads++
        return json(200, {
          code: OK,
          desc: "ok",
          data: {
            balance: state.permanentBalance,
            dailyBalance: state.dailyBalance,
            dailyLimitPoints: 5000,
            dailyRemainingPoints: state.dailyBalance,
            list: [],
            total: 0,
          },
        })
      }
      if (url.pathname === "/api/v1/onboarding/tasks") {
        state.onboardingQueries++
        return json(200, { code: OK, desc: "ok", data: { tasks: { ...state.onboardingDone } } })
      }
      if (url.pathname === "/api/v1/onboarding/tasks/complete") {
        state.onboardingCompletes++
        const reqBody = await req.json().catch(() => ({}))
        const key = String(reqBody?.key ?? "")
        if (!key || !(key in TASK_POINTS)) return json(200, { code: "100001", desc: `未知的 task key：${key}` })
        const already = !!state.onboardingDone[key]
        state.onboardingDone[key] = true
        return json(200, { code: OK, desc: "ok", data: { alreadyCompleted: already } })
      }
      return json(404, { code: "100003", desc: "no route" })
    },
  })

  return { account, gateway, state, accountUrl: `http://127.0.0.1:${account.port}`, gatewayUrl: `http://127.0.0.1:${gateway.port}` }
}
