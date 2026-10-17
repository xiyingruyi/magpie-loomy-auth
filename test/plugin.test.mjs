import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { LoomyAuthPlugin } from "../index.mjs"
import { fakeLoomy } from "./fake.mjs"

// 全部打到本地 fake 上游：账号域会重新校验 HMAC 签名，网关会检查双凭据头
// 与 charset。不触网、不用真实 session。

let fake
let saved = {}
let plugin
let client

const getAuth = async () => saved
const setAuth = async (body) => { saved = body }

beforeAll(() => {
  fake = fakeLoomy()
  process.env.LOOMY_POINTS_BASE_URL = fake.gatewayUrl
  process.env.LOOMY_XFYUN_BASE_URL = fake.accountUrl
})

afterAll(() => {
  fake.account.stop(true)
  fake.gateway.stop(true)
})

beforeEach(async () => {
  fake.state.reset()
  saved = { type: "oauth", access: fake.state.session, refresh: "", expires: 0, accountId: "138****8000", source: "sms" }
  client = { auth: { set: async ({ body }) => setAuth(body) } }
  plugin = await LoomyAuthPlugin({ client })
})

describe("sign-in", () => {
  test("SMS: sends the code, then trades it for a 14-day session", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("SMS"))
    const flow = await method.authorize({ phone: "138 0013 8000" }) // 空格要能容忍
    expect(flow.method).toBe("code")
    expect(flow.instructions).toContain("已发送")
    expect(flow.instructions).toContain("138****8000")
    expect(fake.state.smsSent).toBeTruthy()
    // 错的码失败并给原因
    const bad = await flow.callback("000000")
    expect(bad.type).toBe("failed")
    expect(bad.error).toContain("验证码")
    // 格式不对的码不发给上游
    expect((await flow.callback("abc")).type).toBe("failed")
    const result = await flow.callback("123456")
    expect(result.type).toBe("success")
    expect(result.access).toBe("sess-1")
    expect(result.refresh).toBe("")
    expect(result.expires).toBeGreaterThan(Date.now() + 13 * 86400e3)
    expect(result.accountId).toBe("138****8000")
    expect(result.userId).toBe("261014155255771375")
  })

  test("SMS: an invalid phone is refused before anything is sent", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("SMS"))
    const bad = await method.authorize({ phone: "12345" })
    expect(bad.type).toBe("failed")
    expect(fake.state.smsSent).toBeNull()
  })

  test("SMS: a vendor refusing the send is reported, not thrown", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("SMS"))
    // fake 只认一个手机号，换一个就会被上游拒（HTTP 400 + 业务码）
    const bad = await method.authorize({ phone: "13900139000" })
    expect(bad.type).toBe("failed")
    expect(bad.error).toContain("phone not found")
  })

  test("manual paste verifies the session before accepting it", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("Paste"))
    const good = await method.authorize({ session: fake.state.session })
    expect(good.type).toBe("success")
    expect(good.access).toBe(fake.state.session)
    // 校验过：上游确实被问了一次清单
    expect(fake.state.modelsReads).toBeGreaterThan(0)
    // 错的 session 直接拒绝，不让 magpie 存一个「看似登录、实际每次 401」的账号
    const bad = await method.authorize({ session: "nope" })
    expect(bad.type).toBe("failed")
    expect(bad.error).toContain("失效")
  })

  test("manual paste refuses an empty session", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("Paste"))
    expect((await method.authorize({ session: "  " })).type).toBe("failed")
  })
})

describe("chat", () => {
  test("streams through with both auth headers", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("http://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"content":"你"')
    expect(text).toContain("data: [DONE]")
    expect(fake.state.chatCalls.length).toBe(1)
    expect(fake.state.chatCalls[0].body.model).toBe("spark-x")
    expect(fake.state.lastChatHeaders.token).toBe(fake.state.session)
    expect(fake.state.lastChatHeaders.bearer).toBe(`Bearer ${fake.state.session}`)
    expect(fake.state.lastChatHeaders.contentType).toContain("charset=utf-8")
  })

  test("reasoning effort folds to low/medium/high", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const send = (effort) => loader.fetch("http://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: true, reasoning_effort: effort, messages: [] }),
    })
    await send("minimal")
    await send("max")
    await send("none")
    expect(fake.state.chatCalls[0].body.reasoning_effort).toBe("low")
    expect(fake.state.chatCalls[1].body.reasoning_effort).toBe("high")
    expect(fake.state.chatCalls[2].body.reasoning_effort).toBeUndefined()
  })

  test("non-streaming callers get one completion back", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("http://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: false, messages: [] }),
    })
    expect(res.headers.get("content-type")).toBe("application/json")
    const body = await res.json()
    expect(body.choices[0].message.content).toBe("你好")
    expect(body.choices[0].finish_reason).toBe("stop")
  })

  test("a dead session is a 401 that marks the account", async () => {
    saved = { type: "oauth", access: "gone", refresh: "", expires: 0 }
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("http://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: true, messages: [] }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  })
})

describe("checkin", () => {
  test("the daily grant is pressed and reported", async () => {
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(result.message).toContain("5000")
    // dailyBalance 是刷新后的余额，不是奖励：不能当 credit 上报
    expect(result.credit).toBeUndefined()
    expect(fake.state.firstLoginCalls).toBe(1)
    // 新手任务默认不扫（默认关闭）
    expect(fake.state.onboardingQueries).toBe(0)
  })

  test("it never throws — a dead session is ineligible", async () => {
    saved = { type: "oauth", access: "gone", refresh: "", expires: 0 }
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("ineligible")
    expect(result.message).toContain("登录")
  })

  test("not signed in is ineligible", async () => {
    saved = {}
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("ineligible")
  })

  test("a getAuth that throws is folded into an outcome", async () => {
    const result = await plugin.auth.checkin(async () => { throw new Error("store down") })
    expect(result.outcome).toBe("failed")
    expect(result.message).toContain("store down")
  })

  test("with the newbie switch on, the one-time tasks are claimed once", async () => {
    plugin = await LoomyAuthPlugin({
      client,
      magpie: { option: (provider, key) => provider === "loomy" && key === "onboarding" },
    })
    const first = await plugin.auth.checkin(getAuth)
    expect(first.outcome).toBe("claimed")
    expect(first.credit).toBe(10000)
    expect(first.message).toContain("新手任务")
    expect(fake.state.onboardingCompletes).toBe(8)
    // 结算标记写回账号
    expect(saved.onboardingSettled).toBe(true)

    // 第二次不再扫描，也不再上报
    const queries = fake.state.onboardingQueries
    const completes = fake.state.onboardingCompletes
    const second = await plugin.auth.checkin(getAuth)
    expect(second.outcome).toBe("claimed")
    expect(second.credit).toBeUndefined()
    expect(fake.state.onboardingQueries).toBe(queries)
    expect(fake.state.onboardingCompletes).toBe(completes)
  })

  test("a partly-done table claims only the missing keys", async () => {
    plugin = await LoomyAuthPlugin({
      client,
      magpie: { option: () => true },
    })
    fake.state.onboardingDone = { first_message: true, pick_skill: true }
    const result = await plugin.auth.checkin(getAuth)
    expect(result.credit).toBe(10000 - 1500)
    expect(fake.state.onboardingCompletes).toBe(6)
    expect(saved.onboardingSettled).toBe(true)
  })

  test("a settled account skips the scan even with the switch on", async () => {
    saved.onboardingSettled = true
    plugin = await LoomyAuthPlugin({ client, magpie: { option: () => true } })
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(fake.state.onboardingQueries).toBe(0)
  })

  test("a scan failure does not fail the daily grant", async () => {
    plugin = await LoomyAuthPlugin({ client, magpie: { option: () => true } })
    const realFetch = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input)
      if (String(url).includes("/api/v1/onboarding/tasks") && !String(url).endsWith("/complete")) {
        return Promise.resolve(new Response(JSON.stringify({ code: "100009", desc: "boom" }), { status: 200 }))
      }
      return realFetch(input, init)
    }
    try {
      const result = await plugin.auth.checkin(getAuth)
      expect(result.outcome).toBe("claimed")
      expect(result.message).toContain("扫描失败")
      // 没扫描成功就不结算，下一轮再试
      expect(saved.onboardingSettled).toBeUndefined()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe("models", () => {
  test("the live catalogue, rates split out of the names", async () => {
    const p = { models: {} }
    const list = await plugin.provider.models(p, { auth: saved })
    expect(Object.keys(list)).toEqual(["spark-x", "deepseek-v4-flash", "glm-5.3-flash", "plain"])
    expect(list["spark-x"].name).toBe("Spark X2.5")
    expect(list["spark-x"].rate).toBe("x0.1")
    expect(list["spark-x"].limit).toEqual({ context: 128000, output: 8192 })
    expect(list["deepseek-v4-flash"].rate).toBe("x3.0")
    expect(list["deepseek-v4-flash"].limit.output).toBe(0)
    expect(list["glm-5.3-flash"].rate).toBe("x0.8")
    expect(list["glm-5.3-flash"].capabilities.input.image).toBe(true)
    expect(list["plain"].rate).toBeUndefined()
    expect(list["plain"].name).toBe("No Suffix At All")
  })

  test("signed out keeps the list it was given", async () => {
    const p = { models: { keep: { name: "Keep" } } }
    const list = await plugin.provider.models(p, { auth: {} })
    expect(list).toEqual({ keep: { name: "Keep" } })
  })

  test("a dead session marks the account", async () => {
    await expect(plugin.provider.models({ models: {} }, { auth: { type: "oauth", access: "gone" } })).rejects.toMatchObject({ signIn: "expired" })
  })

  test("live models feed the request pipeline's capability table", async () => {
    await plugin.provider.models({ models: {} }, { auth: saved })
    // spark-x 会推理；glm-5.3-flash 不会 —— 后者收到 reasoning_effort 要删掉
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch("http://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "glm-5.3-flash", stream: true, reasoning_effort: "high", messages: [] }),
    })
    expect(fake.state.chatCalls[0].body.reasoning_effort).toBeUndefined()
  })
})

describe("usage", () => {
  test("the two wallets", async () => {
    const usage = await plugin.auth.usage(getAuth)
    // 干净读取不报 signIn：没有续期接口，报 kept 会让 lapsed 标记永远清不掉
    expect(usage.signIn).toBeUndefined()
    const daily = usage.windows.find((w) => w.name === "每日赠送积分")
    expect(daily.amount).toBe(5000)
    expect(daily.limit).toBe(5000)
    expect(daily.resetsAt).toBeGreaterThan(Date.now())
    expect(daily.resetsAt - Date.now()).toBeLessThanOrEqual(86400e3)
    const permanent = usage.windows.find((w) => w.name === "永久积分")
    expect(permanent.display).toBe("1200 credits")
    expect(usage.balance).toBe("1200 credits")
    expect(usage.user).toBe("138****8000")
  })

  test("a dead session reports expired and never throws", async () => {
    saved = { type: "oauth", access: "gone", refresh: "", expires: 0 }
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.signIn).toBe("expired")
    expect(usage.error).toContain("登录")
  })

  test("a network failure does not mark the account", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = () => Promise.reject(new Error("offline"))
    try {
      const usage = await plugin.auth.usage(getAuth)
      expect(usage.error).toContain("offline")
      expect(usage.signIn).toBeUndefined()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("not signed in says so", async () => {
    saved = {}
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.error).toContain("尚未登录")
  })
})

describe("config", () => {
  test("the provider is declared with the fallback models", async () => {
    const cfg = {}
    await plugin.config(cfg)
    const p = cfg.provider.loomy
    expect(p.name).toBe("Loomy（讯飞）")
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
    expect(p.api).toBe(`${fake.gatewayUrl}/api/v1`)
    expect(Object.keys(p.models).length).toBeGreaterThan(0)
  })

  test("an existing model list is merged, not replaced", async () => {
    const cfg = { provider: { loomy: { models: { mine: { name: "Mine" } } } } }
    await plugin.config(cfg)
    expect(cfg.provider.loomy.models.mine).toEqual({ name: "Mine" })
    expect(cfg.provider.loomy.models["spark-x"]).toBeTruthy()
  })
})
