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
import { ONBOARDING_TASKS, ONBOARDING_TOTAL, settledOf, SETTLED_FIELD } from "./lib/onboarding.mjs"

// 每个账号的模型能力表：模型清单拉下来时填，请求管线按 model id 查。
// 键是 `${accountKey}:${modelId}`，accountKey 取 auth 的 accountId。
const profiles = new Map()

// 账号 → session。Loomy 的 session 只有一种来源（短信登录 / 手动粘贴），
// 存在 access 里；refresh 恒为空 —— 上游没有续期接口。
const sessionOf = (auth) => (auth?.type === "oauth" ? auth.access : auth?.key) ?? ""
const profileKey = (auth, model) => `${auth?.accountId ?? auth?.userId ?? ""}:${model}`
const profileOf = (auth) => (model) => profiles.get(profileKey(auth, model))

const accountLabel = (auth) => auth?.accountId || auth?.name || ""

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

  const checkin = makeCheckin({ sessionOf, settledOf, settle, onboardingOn: () => onboardingOn({ magpie }) })

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
            if (!phone) return { type: "failed", error: "请填写 11 位中国大陆手机号" }
            // 现在就把验证码发出去；用户接下来输入的 6 位码完成这次登录
            let msgid
            try {
              ;({ msgid } = await sendCode(phone))
            } catch (e) {
              return { type: "failed", error: String(e?.message ?? e) }
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
          async authorize(inputs) {
            const session = String(inputs?.session ?? "").trim()
            if (!session) return { type: "failed", error: "session 必填" }
            // 先验证一次：粘错一个字符的话，magpie 会得到一次「看起来登录成功、
            // 实际每次请求 401」的账号。这里花一次 GET /models 确认可用。
            try {
              await gatewayJson("GET", "/api/v1/models", session)
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
              return { type: "failed", error: `session 校验失败：${e?.message ?? e}` }
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
          const payload = await gatewayJson("GET", "/api/v1/models", session)
          const entries = Array.isArray(payload?.data) ? payload.data : []
          if (!entries.length) return provider.models
          const live = modelsFromCatalog(entries, ID)
          if (!Object.keys(live).length) return provider.models
          // 记下能力表（请求管线按 model 查），保留用户已有的覆盖
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
}
