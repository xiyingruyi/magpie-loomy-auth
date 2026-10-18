import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { LoomyAuthPlugin, _internal } from "../index.mjs"
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
  // 模型目录缓存是模块级的，测试之间必须清掉，否则前一个用例的清单会漏过来
  _internal.catalogs.clear()
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

  // magpie 的 authorize 只取 {url, instructions, method} —— type/error 会被丢掉，
  // 然后它照样去调 callback。所以「失败」也必须是一个带 callback 的流程，不然
  // 报出来的是 `s.a.callback is not a function`（实测过）。
  test("SMS: an invalid phone is refused before anything is sent", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("SMS"))
    const bad = await method.authorize({ phone: "12345" })
    expect(typeof bad.callback).toBe("function")
    expect(bad.method).not.toBe("code")
    expect((await bad.callback()).error).toContain("11 位")
    expect(fake.state.smsSent).toBeNull()
  })

  test("SMS: a vendor refusing the send is reported through the flow", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("SMS"))
    // fake 只认一个手机号，换一个就会被上游拒（HTTP 400 + 业务码）
    const bad = await method.authorize({ phone: "13900139000" })
    expect(typeof bad.callback).toBe("function")
    const r = await bad.callback()
    expect(r.type).toBe("failed")
    expect(r.error).toContain("phone not found")
  })

  // 收尾必须走 callback：magpie（CLI 的 plugin.Finish 与窗口的 SignIn 驱动）
  // 对 method !== "code" 的流程直接调一次 callback，authorize 的返回值里只有
  // {url, instructions, method} 会留下。
  // 这条断言挡住的是整类 bug：magpie 对 oauth 流程**无条件**调用 callback
  // （CLI 的 plugin.Finish、窗口的 SignIn 驱动都一样），而 authorize 的返回值
  // 里只有 {url, instructions, method} 留得下来。任何一条路只要改成「从
  // authorize 里 return 结果」，用户看到的就是 `s.a.callback is not a function`。
  test("every sign-in path hands magpie a flow with a callback", async () => {
    const sms = plugin.auth.methods.find((m) => m.label.includes("SMS"))
    const paste = plugin.auth.methods.find((m) => m.label.includes("Paste"))
    const cases = [
      [sms, { phone: "13800138000" }], // 正常：发码 + 等验证码
      [sms, { phone: "12345" }], // 非法手机号
      [sms, { phone: "13900139000" }], // 上游拒绝发码
      [paste, { session: "  " }], // 空 session
      [paste, { session: "nope" }], // 坏 session
      [paste, { session: fake.state.session }], // 好 session
    ]
    for (const [method, inputs] of cases) {
      const flow = await method.authorize(inputs)
      expect(typeof flow.callback).toBe("function")
      expect(typeof flow.url).toBe("string")
    }
  })

  test("manual paste finishes through its callback", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("Paste"))
    const flow = await method.authorize({ session: fake.state.session })
    expect(flow.method).toBe("auto")
    expect(typeof flow.callback).toBe("function")
    const good = await flow.callback()
    expect(good.type).toBe("success")
    expect(good.access).toBe(fake.state.session)
    // 校验过：上游确实被问了一次清单
    expect(fake.state.modelsReads).toBeGreaterThan(0)
  })

  test("manual paste rejects a session the vendor does not know", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("Paste"))
    const flow = await method.authorize({ session: "nope" })
    const bad = await flow.callback()
    expect(bad.type).toBe("failed")
    expect(bad.error).toContain("失效")
  })

  test("manual paste refuses an empty session, from the callback", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("Paste"))
    const flow = await method.authorize({ session: "  " })
    expect(typeof flow.callback).toBe("function")
    const bad = await flow.callback()
    expect(bad.type).toBe("failed")
    expect(bad.error).toContain("必填")
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

  test("reasoning effort folds into the five levels the upstream knows", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const send = (effort) => loader.fetch("http://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: true, reasoning_effort: effort, messages: [] }),
    })
    await send("minimal")
    await send("max")
    await send("none")
    await send("xhigh")
    expect(fake.state.chatCalls[0].body.reasoning_effort).toBe("low")
    expect(fake.state.chatCalls[1].body.reasoning_effort).toBe("xhigh")
    expect(fake.state.chatCalls[2].body.reasoning_effort).toBe("none")
    // 上游一等档位 xhigh 原样透传，不能折成 high
    expect(fake.state.chatCalls[3].body.reasoning_effort).toBe("xhigh")
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

    // 第二次不再扫描，也不再上报；上游说今天已经处理过 → done
    const queries = fake.state.onboardingQueries
    const completes = fake.state.onboardingCompletes
    const second = await plugin.auth.checkin(getAuth)
    expect(second.outcome).toBe("done")
    expect(second.message).toContain("今日已领过")
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
    // 生图模型被剔除：插件账号没有可用的生图入口（magpie 不替插件转发
    // images API，chat 端点对它们一律 404）
    expect(Object.keys(list)).toEqual(["spark-x", "deepseek-v4-flash", "glm-5.3-flash", "plain"])
    expect(list["spark-x"].name).toBe("Spark X2.5")
    expect(list["spark-x"].rate).toBe("x0.1")
    expect(list["spark-x"].limit).toEqual({ context: 128000, output: 8192 })
    // 真实上游字段名是 max_output_tokens，没给就 0，不能猜
    expect(list["deepseek-v4-flash"].rate).toBe("x3.0")
    expect(list["deepseek-v4-flash"].limit.output).toBe(0)
    expect(list["glm-5.3-flash"].rate).toBe("x0.8")
    expect(list["glm-5.3-flash"].limit.output).toBe(131072)
    expect(list["glm-5.3-flash"].capabilities.input.image).toBe(true)
    expect(list["plain"].rate).toBeUndefined()
    expect(list["plain"].name).toBe("No Suffix At All")
    // 生图模型不在聊天清单里（见上）
    expect(list["hy-image"]).toBeUndefined()
  })

  // magpie 每个请求前都会问一次 provider.models（fetchAs → info），所以钩子里
  // 直接打上游等于每聊一句多一次往返。短缓存是行为的一部分，得钉住。
  test("the catalogue is cached between calls, and per session", async () => {
    await plugin.provider.models({ models: {} }, { auth: saved })
    expect(fake.state.modelsReads).toBe(1)
    await plugin.provider.models({ models: {} }, { auth: saved })
    expect(fake.state.modelsReads).toBe(1)
    // 另一个账号不复用：不同账号能用的模型可能不同
    fake.state.extraSessions = ["sess-2"]
    await plugin.provider.models({ models: {} }, { auth: { ...saved, access: "sess-2" } })
    expect(fake.state.modelsReads).toBe(2)
  })

  test("a catalogue that carries no business code is still the live one", async () => {
    // 真实上游的模型清单接口不返回 code；严格判码会把整个实时清单换成兜底表
    fake.state.modelsNoCode = true
    const p = { models: { "spark-x": { name: "Spark X2.5" } } }
    const list = await plugin.provider.models(p, { auth: saved })
    expect(Object.keys(list).length).toBeGreaterThan(1)
    expect(list["glm-5.3-flash"]).toBeDefined()
  })

  test("a failed read is not cached, so the next call tries again", async () => {
    fake.state.modelsNoCode = false
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ code: "100009", desc: "boom" }), { status: 200 })
    try {
      const p = { models: { keep: { name: "Keep" } } }
      expect(await plugin.provider.models(p, { auth: saved })).toEqual({ keep: { name: "Keep" } })
    } finally {
      globalThis.fetch = realFetch
    }
    // 上游恢复后照常拿到实时清单
    const list = await plugin.provider.models({ models: {} }, { auth: saved })
    expect(list["spark-x"]).toBeDefined()
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
    // magpie 把 amount 当「用掉多少」拼成 "N / limit credits · M% used"：
    // 满额钱包就是 0 / 5000 · 0%
    expect(daily.amount).toBe(0)
    expect(daily.used).toBe(0)
    expect(daily.limit).toBe(5000)
    expect(daily.resetsAt).toBeGreaterThan(Date.now())
    expect(daily.resetsAt - Date.now()).toBeLessThanOrEqual(86400e3)
    const permanent = usage.windows.find((w) => w.name === "永久积分")
    expect(permanent.display).toBe("1200 credits")
    expect(usage.balance).toBe("1200 credits")
    expect(usage.user).toBe("138****8000")
  })

  // magpie 把 amount 当「用掉多少」，卡片拼成 "N / limit credits · M% used"；
  // 报余额会显示成 "5,000 / 5,000 · 0% used" 这种自相矛盾的组合。
  test("a partly spent day reports what was used, not the balance", async () => {
    fake.state.dailyBalance = 1200 // 5000 的日额度里还剩 1200
    const usage = await plugin.auth.usage(getAuth)
    const daily = usage.windows.find((w) => w.name === "每日赠送积分")
    expect(daily.amount).toBe(3800)
    expect(daily.limit).toBe(5000)
    expect(daily.used).toBe(76)
  })

  // 回归：真实上游的 points/records **不返回额度**（只有余额、每日剩余）。
  // 曾经把「余额」当上限，用量页显示成 "0 / 4673 · 0% used" —— 一个编造的
  // 额度。现在上限来自签到学到的 dailyQuota（没有就用出厂值 5000）。
  test("the daily window never takes the balance for its limit", async () => {
    fake.state.dailyBalance = 4673
    const usage = await plugin.auth.usage(getAuth)
    const daily = usage.windows.find((w) => w.name === "每日赠送积分")
    expect(daily.limit).toBe(5000)
    expect(daily.amount).toBe(327)
    expect(daily.used).toBe(7)
    // 余额比额度大（上游改过发放量）也不能出现负数或超过 100%
    fake.state.dailyBalance = 6000
    const over = (await plugin.auth.usage(getAuth)).windows.find((w) => w.name === "每日赠送积分")
    expect(over.amount).toBe(0)
    expect(over.used).toBe(0)
  })

  // 签到接口是唯一回 dailyQuota 的地方：学到后写回账号，用量页用它。
  test("check-in learns the daily quota and the usage page uses it", async () => {
    fake.state.dailyBalance = 4200
    fake.state.dailyQuota = 6000
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(saved.dailyQuota).toBe(6000)
    // getAuth 每次都重新读 saved，所以用量页自然拿到新值
    const daily = (await plugin.auth.usage(getAuth)).windows.find((w) => w.name === "每日赠送积分")
    expect(daily.limit).toBe(6000)
    expect(daily.amount).toBe(1800)
  })

  test("a second check-in the same day says so, and does not re-scan", async () => {
    const first = await plugin.auth.checkin(getAuth)
    expect(first.outcome).toBe("claimed")
    const second = await plugin.auth.checkin(getAuth)
    expect(second.outcome).toBe("done")
    expect(second.message).toContain("今日已领过")
  })

  // 回归（对抗审查发现）：client.auth.set 是**替换**不是合并。同一次签到里
  // 先写 dailyQuota、再写 onboardingSettled 时，后一次用的是开头读到的旧快照，
  // 会把前一次刚写的字段抹掉。两处都必须把字段补进快照。
  test("one check-in writes both fields, neither clobbers the other", async () => {
    saved = { type: "oauth", access: fake.state.session, refresh: "", expires: 0, accountId: "138****8000", source: "sms" }
    fake.state.dailyQuota = 6000
    fake.state.dailyBalance = 6000
    plugin = await LoomyAuthPlugin({ client, magpie: { option: () => true } })
    const r = await plugin.auth.checkin(getAuth)
    expect(r.outcome).toBe("claimed")
    // 最后一次写入之后，两个字段都还在
    expect(saved.dailyQuota).toBe(6000)
    expect(saved.onboardingSettled).toBe(true)
  })

  // 实测这个上游的积分接口在 2.4s–16s 之间抖，偶发超时。读失败时不该让整块
  // 用量变成错误 —— 把上一次读成功的数交回去，并说明它是上一次的。
  test("a failed read falls back to the last good reading", async () => {
    const good = await plugin.auth.usage(getAuth)
    const daily = good.windows.find((w) => w.name === "每日赠送积分")
    expect(daily.limit).toBe(5000)

    const realFetch = globalThis.fetch
    globalThis.fetch = () => Promise.reject(new Error("The operation timed out."))
    try {
      const kept = await plugin.auth.usage(getAuth)
      expect(kept.error).toContain("上一次读取")
      // 数还在
      const stillThere = kept.windows.find((w) => w.name === "每日赠送积分")
      expect(stillThere.limit).toBe(5000)
      expect(stillThere.amount).toBe(daily.amount)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  // 回归（2026-10-19 真机事故）：magpie 只给 20 秒
  // （plugin_usage.go 的 context.WithTimeout），而插件原来给 45 秒 —— 上游一慢
  // 宿主就先放弃，卡片上打「暂时无法获取最新额度」，尽管积分充足。现在预算
  // 压在 20 秒以内，v2 慢了就对冲一个 v1。
  test("a flaky v2 is hedged by v1", async () => {
    fake.state.recordsFail = ["v2-error"]
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.error).toBeUndefined()
    expect(usage.windows.find((w) => w.name === "每日赠送积分").limit).toBe(5000)
    // v2 失败后 v1 也对冲出去了
    expect(fake.state.recordsVersions.sort()).toEqual(["v1", "v2"])
  })

  // 两个入口都失败才是真失败：这时退回上一次读数，并同时说明两边的错误，
  // 而不是只报最后一个（那会掩盖第一个的真实原因）。
  test("when both entries fail, the error names both", async () => {
    fake.state.recordsFail = ["v2-error", "v1-error"]
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.error).toContain("系统内部错误")
    expect(usage.error).toContain("v2")
    expect(fake.state.recordsVersions.sort()).toEqual(["v1", "v2"])
  })

  // 登录失效要两边都说才算数：实测上游偶尔对一次只读请求回 100002（60 次里
  // 见过 1 次），session 本身是好的。拿一次这种回答去标记账号，用户就得重新
  // 短信登录一次才消掉。
  test("one entry saying signed-out is not enough to mark the account", async () => {
    fake.state.recordsFail = ["v2-auth"]
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.signIn).toBeUndefined()
    expect(usage.error).toBeUndefined()
    expect(usage.windows.find((w) => w.name === "每日赠送积分").limit).toBe(5000)
    expect(fake.state.recordsVersions.sort()).toEqual(["v1", "v2"])
  })

  // 两边都说失效才是真失效，并且不重试第三次。
  test("both entries saying signed-out marks the account expired", async () => {
    fake.state.recordsFail = ["v2-auth", "v1-auth"]
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.signIn).toBe("expired")
    expect(usage.windows).toEqual([])
    expect(fake.state.recordsVersions.sort()).toEqual(["v1", "v2"])
  })

  // 预算：magpie 的钩子期限是 20 秒，最坏情况要留在里面（对冲等待 + 一次超时）。
  test("one read never outlasts magpie's 20-second window", async () => {
    const source = await Bun.file(new URL("../lib/usage.mjs", import.meta.url)).text()
    const num = (name) => Number(source.match(new RegExp(`const ${name} = ([\\d_]+)`))[1].replace(/_/g, ""))
    expect(num("HEDGE_AFTER") + num("ATTEMPT_TIMEOUT")).toBeLessThanOrEqual(16_000)
  })

  // 登录失效不能沿用旧数：那会把一个需要重新登录的账号显示成一切正常。
  test("a lapsed session never reuses the last good reading", async () => {
    await plugin.auth.usage(getAuth) // 先有一次成功
    saved = { type: "oauth", access: "gone", refresh: "", expires: 0 }
    const u = await plugin.auth.usage(getAuth)
    expect(u.signIn).toBe("expired")
    expect(u.windows).toEqual([])
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

// 🔴 magpie 给 auth.usage / auth.checkin 钩子的期限是 20 秒，从钩子被调起
// 那一刻开始算。插件自己的单次请求预算必须**留出余量**，否则上游一慢就变成
// 「宿主先放弃、插件后报超时」—— 实测 25 轮签到里出现过 1 次 20003ms 失败。
test("a single upstream request never outlasts magpie's 20-second hook window", async () => {
  const { REQUEST_TIMEOUT } = await import("../lib/constants.mjs")
  expect(REQUEST_TIMEOUT).toBeLessThan(20_000)
  // 留足余量：至少 4 秒给宿主的调度、序列化和回写
  expect(20_000 - REQUEST_TIMEOUT).toBeGreaterThanOrEqual(4_000)
})
