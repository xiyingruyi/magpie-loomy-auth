// 插件入口。
//
// magpie / OpenCode 会把**每一个导出的函数**都当成一个插件去加载，所以这里
// 只导出插件工厂一个函数；其余都经由 `_internal` 暴露（给测试用）。

import { ID, NAME, NPM, MODEL_BASE, FALLBACK_MODELS } from "./lib/constants.mjs"
import { gatewayJson, SignedOut } from "./lib/http.mjs"
import { makeBase, normalizePhone, maskPhone, sendCode, checkCode } from "./lib/login.mjs"
import { modelsFromCatalog, configModelsFrom } from "./lib/models.mjs"
import { makeFetch } from "./lib/proxy.mjs"
import { makeCheckin } from "./lib/checkin.mjs"
import { usageOf } from "./lib/usage.mjs"
import { ONBOARDING_TASKS, ONBOARDING_TOTAL, settledOf, SETTLED_FIELD, DAILY_QUOTA_FIELD, dailyQuotaOf } from "./lib/onboarding.mjs"

// 每个账号的模型能力表：模型清单拉下来时填，请求管线按 model id 查。
// 键是 `${accountKey}:${modelId}`，accountKey 取 auth 的 accountId。
const profiles = new Map()

// 账号 → session。Loomy 的 session 只有一种来源（短信登录 / 手动粘贴），
// 存在 access 里；refresh 恒为空 —— 上游没有续期接口。
const sessionOf = (auth) => (auth?.type === "oauth" ? auth.access : auth?.key) ?? ""
const profileKey = (auth, model) => `${auth?.accountId ?? auth?.userId ?? ""}:${model}`
const profileOf = (auth) => (model) => profiles.get(profileKey(auth, model))

const accountLabel = (auth) => auth?.accountId || auth?.name || ""

// 登录失败也要包成一个「完整流程」：magpie 的 authorize 会丢掉 type/error，
// 只留 {url, instructions, method}，然后照样去调 callback。直接 return
// {type:"failed"} 的结果是一个没有 callback 的流程，报出来的是
// `s.a.callback is not a function`，真正的原因反而看不见。
const failedFlow = (error) => ({
  url: "",
  instructions: "",
  // 不是 "code"：magpie 不会去读验证码，直接调一次 callback 拿结果
  method: "auto",
  callback: async () => ({ type: "failed", error: String(error) }),
})

// 粘贴 session 时的那次校验单独给一个更长的预算：上游对**无效**会话不会立刻
// 回绝，实测同一个接口正常 1s、忙的时候十几秒。用默认的 20s 会把「上游慢」
// 说成「你的 session 有问题」，那是两个完全不同的结论。
const PASTE_CHECK_TIMEOUT = 45_000
const isTimeout = (e) =>
  e?.name === "TimeoutError" || e?.name === "AbortError" || /timed out|timeout|超时/i.test(String(e?.message ?? ""))

// 模型目录的短缓存。
//
// magpie 在**每个**经它转发的请求前都会走一次 info() → provider.models
// （fetchAs 就是这么调的），钩子里直接问上游等于「每聊一句先问一次模型清单」：
// 多一次往返、多一份上游额度消耗，也多一个失败点。上游清单变化很慢，magpie
// 自己也是每小时才重新列一次，缓存几分钟看不出差别。
//
// 按 session 分桶：不同账号能用的模型可能不同，共用一份缓存会串号。
const CATALOG_TTL = 5 * 60 * 1000
const catalogs = new Map() // session → { base, at, models }

async function liveCatalog(session, { now = Date.now(), call } = {}) {
  const base = MODEL_BASE()
  const hit = catalogs.get(session)
  if (hit && hit.base === base && now - hit.at < CATALOG_TTL) return hit.models
  const payload = await gatewayJson("GET", "/api/v1/models", session, {
    // 清单接口成功时不一定带业务码，见 lib/http.mjs
    allowMissingCode: true,
    ...(call ? { call } : {}),
  })
  const entries = Array.isArray(payload?.data) ? payload.data : []
  if (!entries.length) return null
  const models = modelsFromCatalog(entries, ID)
  if (!Object.keys(models).length) return null
  // 只缓存读成功的结果；失败留空，下一次重新问
  if (catalogs.size > 8) catalogs.clear()
  catalogs.set(session, { base, at: now, models })
  return models
}

// 一次性的新手任务开关：magpie 的 provider 级开关（auth.options），默认关。
const onboardingOn = ({ magpie } = {}) => {
  try {
    return magpie?.option?.(ID, "onboarding") === true
  } catch {
    return false
  }
}

export async function LoomyAuthPlugin({ client, magpie } = {}) {
  // 把「账号 + 结算标记」写回 magpie。client.auth.set 只写不合并，所以要把
  // 原账号整体带上。
  const settle = async (auth) => {
    if (!client?.auth?.set || !auth) return
    await client.auth.set({ path: { id: ID }, body: { ...auth, [SETTLED_FIELD]: true } })
  }

  // 记住每日赠送额度（签到接口唯一会给的两个字段之一）。只是缓存：既没有
  // client 也照常签到。
  const rememberQuota = async (auth, quota) => {
    if (!client?.auth?.set || !auth) return
    await client.auth.set({ path: { id: ID }, body: { ...auth, [DAILY_QUOTA_FIELD]: quota } })
  }

  const checkin = makeCheckin({ sessionOf, settledOf, settle, rememberQuota, onboardingOn: () => onboardingOn({ magpie }) })

  return {
    config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: NAME,
        npm: NPM,
        api: MODEL_BASE(),
        ...was,
        models: { ...FALLBACK_MODELS, ...(was.models ?? {}) },
      }
    },

    auth: {
      provider: ID,

      // Loomy 没有续期接口：session 14 天，到期只能重新登录。
      // 不导出 refresh → magpie 不会尝试续期（renewAt 需要 expires>0 且插件有
      // refresh）。

      methods: [
        {
          // 必须是 oauth：api 类型会让 magpie 强制从 stdin 读一个 key，
          // 而这条路不需要任何输入。
          type: "oauth",
          label: "手机验证码登录（SMS sign-in）",
          prompts: [
            {
              type: "text",
              key: "phone",
              message: "手机号（中国大陆 11 位）",
              validate: (v) => (normalizePhone(v) ? undefined : "请填写 11 位中国大陆手机号"),
            },
          ],
          async authorize(inputs) {
            const phone = normalizePhone(inputs?.phone)
            // 走到这里说明校验没拦住（CLI 不跑 prompts[].validate）。**不能**在这里
            // 直接 return {type:"failed"}：magpie 的 authorize 只取
            // {url, instructions, method} 三个字段，type/error 会被丢掉，然后它
            // 照旧去调 callback —— 于是变成一个「没有 callback」的流程，报的是
            // `s.a.callback is not a function`，用户永远看不到原因。失败也要包成
            // 一个带 callback 的流程，让原因从 callback 里出来。
            if (!phone) return failedFlow("请填写 11 位中国大陆手机号")
            // 现在就把验证码发出去；用户接下来输入的 6 位码完成这次登录
            let msgid
            try {
              ;({ msgid } = await sendCode(phone))
            } catch (e) {
              return failedFlow(
                isTimeout(e)
                  ? "发验证码超时：Loomy 这次响应太慢，请再试一次"
                  : String(e?.message ?? e),
              )
            }
            return {
              // url 留空：不需要打开任何页面，magpie 直接进入输入验证码这一步
              url: "",
              instructions: `验证码已发送到 ${maskPhone(phone)}，请在这里输入收到的 6 位验证码。`,
              method: "code",
              callback: async (code) => {
                const mcode = String(code ?? "").trim()
                if (!/^\d{6}$/.test(mcode)) return { type: "failed", error: "请输入 6 位数字验证码" }
                try {
                  const { session, userId, expires } = await checkCode({ phone, mcode, msgid })
                  return {
                    type: "success",
                    // Loomy 没有续期接口：refresh 恒为空、expires 交给 magpie 只为
                    // 显示「这个账号 14 天后要重登」，插件没有 auth.refresh 所以
                    // 它不会去续期。
                    refresh: "",
                    access: session,
                    expires,
                    accountId: maskPhone(phone),
                    userId,
                    source: "sms",
                  }
                } catch (e) {
                  return { type: "failed", error: String(e?.message ?? e) }
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "手动粘贴 session（Paste token）",
          prompts: [
            {
              type: "text",
              key: "session",
              message: "session（请求里 token 头的值，14 天有效）",
              validate: (v) => (String(v ?? "").trim() ? undefined : "必填"),
            },
          ],
          // 不打开任何页面：method 不是 "code"，magpie 直接调一次 callback 收尾
          // （CLI 是 plugin.Finish，窗口是它的 SignIn 驱动），所以结果必须从
          // callback 里 return —— 从 authorize 直接 return 一个 success 会被丢掉，
          // 然后它去调不存在的 callback。
          async authorize(inputs) {
            const session = String(inputs?.session ?? "").trim()
            return {
              url: "",
              instructions: "正在校验这个 session……",
              method: "auto",
              callback: async () => {
                if (!session) return { type: "failed", error: "session 必填" }
                // 先验证一次：粘错一个字符的话，magpie 会得到一次「看起来登录成功、
                // 实际每次请求 401」的账号。这里花一次 GET /models 确认可用。
                try {
                  await gatewayJson("GET", "/api/v1/models", session, {
                    allowMissingCode: true,
                    timeout: PASTE_CHECK_TIMEOUT,
                  })
                  return {
                    type: "success",
                    refresh: "",
                    access: session,
                    // 粘贴的 session 不知道签发时间，无法推算到期点（14 天）。给 0：
                    // magpie 因此不会尝试续期，账号一直可用到上游拒绝为止。
                    expires: 0,
                    accountId: "手动粘贴",
                    source: "manual",
                  }
                } catch (e) {
                  if (e instanceof SignedOut || e?.signIn === "expired") {
                    return { type: "failed", error: "这个 session 已失效，或者复制得不完整" }
                  }
                  // 超时不等于失效：别让用户因为上游慢就以为 session 坏了
                  if (isTimeout(e)) {
                    return { type: "failed", error: "校验超时：Loomy 这次响应太慢，session 本身可能没问题，再试一次" }
                  }
                  return { type: "failed", error: `session 校验失败：${e?.message ?? e}` }
                }
              },
            }
          },
        },
      ],

      // provider 开关（magpie 的 auth.options）：默认全部关闭
      options: [
        {
          key: "onboarding",
          label: "补领一次性新手任务（Claim one-time newbie tasks）",
          description:
            "Loomy 的新手任务（8 项，合计 10000 积分）只能领一次，不是每日任务。" +
            "打开后，下一次签到会补领尚未领取的项目，全部领完即结算，之后不再扫描。默认关闭。",
          default: false,
        },
      ],

      async loader(getAuth) {
        // 这里只给 magpie 一个「看起来已登录」的信号；真正的 session 由
        // fetch 每次现取（见 lib/proxy.mjs），因此这里失败也不影响已登录的
        // 账号继续工作。
        let session = ""
        try {
          session = String(sessionOf(await getAuth()) ?? "").trim()
        } catch {
          return {}
        }
        if (!session) return {}
        return {
          baseURL: MODEL_BASE(),
          // 上游不认这个 key（fetch 自己会带上 token 头），但 magpie 要求非空
          apiKey: session,
          // fetch 每次请求现取 auth，能力表也按那次请求的账号查
          fetch: makeFetch({ getAuth, sessionOf, profileOf, call: fetch }),
        }
      },

      async usage(getAuth) {
        return usageOf(getAuth, {
          sessionOf,
          userOf: accountLabel,
          quotaOf: dailyQuotaOf,
          call: fetch,
        })
      },

      checkin,
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const session = String(sessionOf(auth) ?? "").trim()
        if (!session) return provider.models
        try {
          const live = await liveCatalog(session)
          if (!live) return provider.models
          // 能力表按账号记（请求管线按 `${accountId}:${model}` 查），缓存命中时
          // 也要写：这份表是「谁在问」的事，不是「上游说了什么」的事
          for (const [id, m] of Object.entries(live)) {
            profiles.set(profileKey(auth, id), {
              reasoning: m.capabilities.reasoning,
              tagImages: /deepseek/i.test(id),
            })
          }
          // 实时清单覆盖同名条目；用户自己加过的其它模型保留
          return { ...(provider.models ?? {}), ...live }
        } catch (e) {
          // 登录失效要让账号被标记；其余故障保留原清单
          if (e?.signIn === "expired") throw e
          return provider.models
        }
      },
    },
  }
}

// 给测试用。注意：magpie 会把每个导出的函数当成插件，所以这里只导出常量与
// 非函数之外的对象；函数通过这个对象间接拿到，不会被当成插件。
export const _internal = {
  ID,
  NAME,
  ONBOARDING_TASKS,
  ONBOARDING_TOTAL,
  makeBase,
  normalizePhone,
  maskPhone,
  modelsFromCatalog,
  configModelsFrom,
  makeFetch,
  makeCheckin,
  usageOf,
  liveCatalog,
  failedFlow,
  catalogs,
  dailyQuotaOf,
}
