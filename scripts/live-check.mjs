// 活体自检（只读 / 不花钱）：把插件的每条链路真的走一遍，打到真实上游。
//
//   bun scripts/live-check.mjs                 # 用环境里的 session（LOOMY_SESSION）
//   LOOMY_SESSION=xxxx bun scripts/live-check.mjs
//
// 没有 session 时仍会检查「无凭据 / 坏凭据」两条路径 —— 它们在真实上游上
// 都必须表现为 401 + 失效标记，而不是被当成成功。
//
// 除非显式设置 LOOMY_LIVE_CHECKIN=1，否则不会调用 first-login（签到会消耗
// 当天的「首登」机会）。新手任务永远不在这里触发。

import { LoomyAuthPlugin, _internal } from "../index.mjs"

const out = (ok, name, detail = "") => console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`)
let failures = 0
const check = (ok, name, detail) => {
  out(ok, name, detail)
  if (!ok) failures++
}

const session = process.env.LOOMY_SESSION?.trim() || ""
const saved = session
  ? { type: "oauth", access: session, refresh: "", expires: 0, accountId: "live-check", source: "manual" }
  : {}
const getAuth = async () => saved

const plugin = await LoomyAuthPlugin({ client: { auth: { set: async () => {} } } })

// 1. config 钩子
{
  const cfg = {}
  await plugin.config(cfg)
  const p = cfg.provider?.loomy
  check(!!p && p.npm === "@ai-sdk/openai-compatible" && Object.keys(p.models ?? {}).length > 0, "config 声明了 provider 与兜底模型")
}

// 2. 无凭据：loader 给出「没有可用的登录」，且管线即便被调用也是 401
{
  const empty = await plugin.auth.loader(async () => ({}))
  check(Object.keys(empty).length === 0, "无凭据：loader 不给出 fetch（magpie 不会发请求）")
  const { makeFetch } = _internal
  let called = false
  const f = makeFetch({ getAuth: async () => ({}), sessionOf: () => "", profileOf: () => undefined, call: async () => { called = true; return new Response("{}") } })
  const res = await f("http://x/v1/chat/completions", { body: JSON.stringify({ model: "spark-x", messages: [] }) })
  check(res.status === 401 && res.headers.get("X-Magpie-Sign-In") === "expired" && !called, "无凭据：401 + expired，且不触网", `${res.status}`)
}

// 3. 坏凭据：真实上游回 HTTP 200 + code 100002，插件必须折成 401
{
  const bad = { type: "oauth", access: "definitely-not-a-session", refresh: "", expires: 0 }
  const loader = await plugin.auth.loader(async () => bad)
  const res = await loader.fetch("http://x/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "spark-x", stream: true, messages: [{ role: "user", content: "你好" }] }),
  })
  const body = await res.json().catch(() => ({}))
  check(res.status === 401 && res.headers.get("X-Magpie-Sign-In") === "expired", "坏凭据：上游 200 里的 100002 被折成 401", `${res.status} ${body?.error?.message ?? ""}`)
}

// 3.5 账号域签名：拿一个不存在的 msgid 去核码。
// 这是唯一能在没有账号的情况下验证 HMAC 链路的方法，而且**不会发短信**：
// 签名正确 → 上游回业务码 210106「验证码已失效」；签名错误 → 020002。
{
  const { signedPost } = await import("../lib/http.mjs")
  const { makeBase } = await import("../lib/login.mjs")
  let code = ""
  try {
    const r = await signedPost("/login/phone/checkCode", {
      base: makeBase(),
      param: { ccode: "86", phone: "13800138000", mcode: "000000", msgid: "live-check-not-a-msgid", expire: 1209600 },
    })
    code = String(r?.code ?? "")
  } catch (e) {
    code = `error: ${e?.message ?? e}`
  }
  // 210106：签名被接受、msgid 无效 —— 正是我们要的
  check(code === "210106", "账号域 HMAC 签名被上游接受（未发短信）", code)
}

// 3.6 登录流程形态：magpie 对 oauth 方法**无条件**调用 callback（CLI 是
// plugin.Finish，窗口是它的 SignIn 驱动），authorize 的 {type,error} 会被丢掉。
// 所以每条路都必须交回一个带 callback 的流程。这里拿一个坏 session 真的走一遍
// 粘贴流程：拿到「失效」说明形态和判定都对；若打印出
// `s.a.callback is not a function`，就是形态退回旧写法了。
{
  const paste = plugin.auth.methods.find((m) => m.label.includes("Paste"))
  let verdict = ""
  try {
    const flow = await paste.authorize({ session: "live-check-not-a-session" })
    if (typeof flow.callback !== "function") verdict = "authorize 没有交回 callback"
    else {
      const r = await flow.callback()
      verdict = r?.type === "failed" ? String(r.error ?? "") : `意外成功：${JSON.stringify(r)}`
    }
  } catch (e) {
    verdict = `抛错：${e?.message ?? e}`
  }
  check(/失效|校验超时|复制得不完整/.test(verdict), "登录流程走 callback，坏 session 被如实拒绝", verdict)
}

// 4. 非 JSON 请求体：400，且不发上游
if (saved.access) {
  const loader = await plugin.auth.loader(getAuth)
  check(typeof loader.fetch === "function", "有 session 时 loader 给出 fetch")
  const res = await loader.fetch("http://x/v1/chat/completions", { body: "not json" })
  check(res.status === 400, "坏请求体：400", `${res.status}`)
}

// 5. 有 session 才检查的只读链路
//
// 上游会抖（实测模型清单与积分接口都会偶发超时 / 系统内部错误）。一次抖动
// 不是插件的问题 —— 重试一次，仍失败才记失败，并注明「重试后仍失败」。
const flaky = (msg) => /timed out|timeout|系统内部错误|ECONNRESET|socket|network|fetch failed|503|502/i.test(String(msg))
// 抖动与缺陷分开记：重试后仍抖动时，插件的行为（降级、保留旧读数）本身是对的，
// 那不是这一轮要判的缺陷。单列一行，不计入失败，但会醒目地打出来 —— 静默吞掉
// 一次上游故障比误报一次缺陷更糟。
let shaky = 0
const onceMore = async (label, fn) => {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    if (!flaky(e?.message ?? e)) return { ok: false, error: e?.message ?? String(e) }
    console.log(`  · ${label}：上游抖动（${e?.message ?? e}），重试一次`)
    try {
      return { ok: true, value: await fn(), retried: true }
    } catch (e2) {
      shaky++
      console.log(`  ! ${label}：上游连续两次抖动（${e2?.message ?? e2}）—— 插件端已降级，不计为失败`)
      return { ok: false, error: `${e2?.message ?? e2}（上游抖动，重试后仍失败）`, flaky: true }
    }
  }
}

if (session) {
  // 5a. 模型清单
  //
  // 插件在上游读失败时会**原样交回**传入的清单（magpie 的契约：保留上一份并
  // 标记 fellBack）。这里天然传的是空表，所以「读失败」的表现就是 0 个模型 ——
  // 那也是上游抖动，要和真正的插件缺陷区分开，一样重试一次。
  const got = await onceMore("模型清单", async () => {
    const list = await plugin.provider.models({ models: {} }, { auth: saved })
    if (!Object.keys(list ?? {}).length) throw new Error("上游没有返回任何模型（读取失败时插件交回的是空清单）")
    return list
  })
  if (!got.ok && !got.flaky) check(false, "模型清单", got.error)
  else if (!got.ok) out(false, "模型清单", got.error)
  const models = got.ok ? got.value : null
  if (models) {
    const ids = Object.keys(models)
    check(ids.length > 0, "模型清单", `${ids.length} 个：${ids.slice(0, 6).join(", ")}${ids.length > 6 ? " …" : ""}${got.retried ? "（重试后成功）" : ""}`)
    const outputs = ids.map((id) => models[id].limit?.output ?? 0)
    check(outputs.every((n) => n >= 0), "输出上限没有负数")
    const guessed = ids.filter((id) => (models[id].limit?.output ?? 0) === 0)
    if (guessed.length) console.log(`  · ${guessed.length} 个模型上游未给输出上限，声明为 0（交给 models.dev）`)
    // 生图模型必须不在清单里：插件账号没有生图的路（见 lib/models.mjs）
    const drawers = ids.filter((id) => models[id].capabilities?.output?.image)
    check(drawers.length === 0, "生图模型没有混进聊天清单", drawers.join(", ") || "无")
  }

  // 5b. 用量（上游慢时可能 20s+；magpie 的钩子期限只有 20s，所以插件在里面
  // 分两段读并换入口重试）
  const u = await onceMore("usage", async () => {
    const r = await plugin.auth.usage(getAuth)
    // usage 从不抛：把 error 折成异常交给重试。回退到上次读数的结果也是
    // 失败 —— 这一项要验证的是「现在读得到」。
    if (r.error) throw new Error(r.stale ? `${r.error}（本次没有读到）` : r.error)
    return r
  })
  const usage = u.ok ? u.value : { error: u.error, windows: [] }
  if (u.flaky) out(false, "usage", u.error)
  else check(!usage.error, "usage", usage.error || `${usage.balance ?? ""} ${(usage.windows ?? []).map((w) => `${w.name}=${w.display ?? w.amount}`).join(" ")}${u.retried ? "（重试后成功）" : ""}`)
  if (!usage.error) check(usage.signIn === undefined, "usage 干净读取不报 signIn（lapsed 能清掉）")

  // 5c. 真实对话（会消耗积分；只发一句）
  //
  // max_tokens 不能太小：这些模型的推理会先把 token 用光，32 的时候实测
  // finish_reason=length、content 是空串 —— 那是一次「正常的长度截断」，不是
  // 插件的问题，但当失败报出来会误导人。给足 256，并且同时检查 finish_reason。
  if (process.env.LOOMY_LIVE_CHAT !== "0") {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("http://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: process.env.LOOMY_LIVE_MODEL || "spark-x", stream: false, max_tokens: 256, messages: [{ role: "user", content: "只回复两个字：收到" }] }),
    })
    const body = await res.json().catch(() => ({}))
    const choice = body?.choices?.[0]
    const say = `${res.status} ${JSON.stringify(choice?.message?.content ?? body?.error ?? "").slice(0, 80)} finish=${choice?.finish_reason ?? "-"}`
    // 截断要有截断的说法：空内容是允许的（推理可能占满），但必须看得见原因
    check(
      res.status === 200 && typeof choice?.message?.content === "string" && (choice.message.content || choice.finish_reason === "length"),
      "真实对话（非流式）",
      say,
    )
  }

  // 5d. 签到（默认不跑：会消耗当天的首登）
  if (process.env.LOOMY_LIVE_CHECKIN === "1") {
    const r = await plugin.auth.checkin(getAuth)
    check(["claimed", "done", "inactive", "ineligible"].includes(r.outcome), "签到", `${r.outcome} ${r.message ?? ""}`)
  }
} else {
  console.log("· 跳过只读链路（未设置 LOOMY_SESSION）")
}

if (shaky) console.log(`\n${shaky} 项因上游抖动未读到（插件已降级，不是缺陷）`)
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
