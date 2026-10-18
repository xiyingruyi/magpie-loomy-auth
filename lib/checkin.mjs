// 每日签到：Loomy 的「每日首登赠送」。
//
// 上游没有一个叫「签到」的接口：客户端的签到就是**每天第一次登录**时调
//   POST /api/v1/points/first-login   body {}
// 服务端把每日赠送积分刷回 5000。它按天幂等 —— 同一天再调仍是成功，余额
// 不变。因此：
//   - 响应里没有「本次领到多少」，dailyBalance 是**刷新后的余额**，不是奖励，
//     把它当 credit 上报会显示成「+4891」，与事实不符；
//   - 第一次与第二次调用在响应上不可区分，`claimed` 表示「已经刷新到今天」。
//
// magpie 的契约（host 实测）：outcome 必须是
//   claimed | done | ineligible | inactive | captcha | failed 之一；
// **钩子抛错会被 host 记成 failed**，所以这里永不抛，只折成 outcome。
//
// 一次性新手任务（8 个 key，合计 10000 积分）不放进定时签到 —— 它是**一次性
// 福利**，不是每日任务（参照实现的侦察笔记也这么定）。这里只在用户明确打开
// 「补领新手任务」开关后才扫，且每账号只结算一次。

import { ONBOARDING_TASKS, ONBOARDING_TOTAL, DAILY_QUOTA_FIELD, SETTLED_FIELD } from "./onboarding.mjs"
import { gatewayJson, messageOf, toNum, SignedOut } from "./http.mjs"

// 北京零点（今天的下一次每日刷新时刻），毫秒时间戳。北京时间无夏令时。
export function beijingMidnight(now = Date.now()) {
  const DAY = 86400e3
  return Math.floor((now + 8 * 3600e3) / DAY) * DAY + DAY - 8 * 3600e3
}

// 上游若用文案表达「今天已经领过」
const DONE_RE = /已领取|已签到|already|重复|今日已/i

// checkin(getAuth) 的工厂。全部依赖注入，单测不需要 magpie 宿主：
//   sessionOf(auth)     账号 → session
//   settledOf(auth)     这个账号的新手任务是否已结算
//   settle(auth)        结算标记写回账号（client.auth.set）
//   rememberQuota(auth, n)  记下这个账号的每日赠送额度（写回账号）
//   onboardingOn()      用户是否打开了「补领新手任务」
//   call                测试里替换 fetch
export function makeCheckin({ sessionOf, settledOf, settle, rememberQuota, onboardingOn, call }) {
  return async function checkin(getAuth) {
    // 1) 读账号。getAuth 抛错同样折成 outcome —— 抛出去 magpie 只记 failed
    //    并且丢掉 message。
    let auth
    try {
      auth = await getAuth()
    } catch (e) {
      return { outcome: "failed", message: `读取登录信息失败：${e?.message ?? e}` }
    }
    let session = ""
    try {
      session = String((await sessionOf(auth)) ?? "").trim()
    } catch (e) {
      return { outcome: "failed", message: `读取登录信息失败：${e?.message ?? e}` }
    }
    if (!session) return { outcome: "ineligible", message: "Loomy：尚未登录" }

    const opts = call ? { call } : {}

    // 2) 每日首登：把每日赠送积分刷回今天。
    let payload
    try {
      payload = await gatewayJson("POST", "/api/v1/points/first-login", session, { body: {}, ...opts })
    } catch (e) {
      return toOutcome(e, "每日赠送积分刷新失败")
    }

    // 这个接口是唯一回每日额度的地方（只读的 points/records 只给剩余）。
    // 记到账号上，用量页就不用猜了。写回失败不影响签到本身。
    const quota = toNum(payload?.data?.dailyQuota)
    if (quota != null && quota > 0 && auth?.[DAILY_QUOTA_FIELD] !== quota) {
      try {
        await rememberQuota?.(auth, quota)
        // magpie 的 client.auth.set 是**替换**不是合并，而这次签到后面还可能
        // 再写一次账号（新手任务结算）。两处都基于开头读到的那份快照，不把
        // 刚写的字段补进快照，后一次写入就会把它抹掉。
        if (auth && typeof auth === "object") auth[DAILY_QUOTA_FIELD] = quota
      } catch {
        // 同上：只是缓存
      }
    }
    const daily = toNum(payload?.data?.dailyBalance ?? payload?.data?.data?.dailyBalance)
    const dailyMsg = daily != null ? `每日赠送积分已刷新（当前 ${daily}）` : "每日赠送积分已刷新"
    // 上游用 `alreadyProcessed` 明说「今天已经处理过」；文案里的「已领取」是
    // 第二道判断（换个接口信封时也不会误报成 claimed）。
    const already = payload?.data?.alreadyProcessed === true || payload?.data?.data?.alreadyProcessed === true || DONE_RE.test(messageOf(payload))
    let message = already ? `${dailyMsg}（今日已领过）` : dailyMsg
    let credit
    let outcome = already ? "done" : "claimed"

    // 3) 新手任务（可选，一次性）：只扫一次，结算后永不再扫。
    const wantsOnboarding = settledOf?.(auth) !== true && (await safeOn(onboardingOn))
    if (wantsOnboarding) {
      const sweep = await scanOnboarding(session, call)
      if (sweep.authGone) return { outcome: "ineligible", message: `${dailyMsg}；登录已失效，请重新登录` }
      if (sweep.error) {
        message += `；新手任务扫描失败：${sweep.error}`
      } else {
        if (sweep.claimed > 0) {
          credit = sweep.points
          message += `；新手任务领取 ${sweep.claimed} 项 +${sweep.points} 积分`
        } else if (sweep.missing === 0) {
          message += "；新手任务均已领取"
        }
        // 全部领完才结算；仍有剩余（单 key 失败 / 上游变化）时下一轮再扫
        if (sweep.missing === 0) {
          try {
            await settle?.(auth)
            if (auth && typeof auth === "object") auth[SETTLED_FIELD] = true
          } catch {
            // 写回账号失败不影响本次签到的结果
          }
        }
      }
    }

    const out = { outcome, message }
    if (credit !== undefined) out.credit = credit
    return out
  }
}

async function safeOn(fn) {
  try {
    return (await fn?.()) === true
  } catch {
    return false
  }
}

// 扫一遍新手任务表，补领缺的 key。单个 key 失败不阻断其余。
async function scanOnboarding(session, call) {
  const opts = call ? { call } : {}
  const readTable = async () => {
    const table = await gatewayJson("GET", "/api/v1/onboarding/tasks", session, opts)
    const tasks = table?.data?.tasks
    return tasks && typeof tasks === "object" ? tasks : {}
  }
  let done
  try {
    done = await readTable()
  } catch (e) {
    if (isAuthGone(e)) return { authGone: true }
    return { error: e?.message ?? String(e) }
  }
  let claimed = 0
  let points = 0
  let lastError = null
  for (const task of ONBOARDING_TASKS) {
    if (done[task.key]) continue
    try {
      const answer = await gatewayJson("POST", "/api/v1/onboarding/tasks/complete", session, {
        body: { key: task.key },
        ...opts,
      })
      // alreadyCompleted 也是成功；积分只算这次真领到的
      if (answer?.data?.alreadyCompleted !== true) {
        claimed++
        points += task.points
      }
    } catch (e) {
      if (isAuthGone(e)) return { authGone: true }
      lastError = e?.message ?? String(e)
    }
  }
  // 再查一次表：既用来判断能不能结算，也让「单 key 失败」有个准确说法
  let missing
  try {
    const after = await readTable()
    missing = ONBOARDING_TASKS.filter((t) => !after[t.key]).length
  } catch (e) {
    if (isAuthGone(e)) return { authGone: true }
    missing = null
  }
  if (lastError) return { claimed, points, missing, error: lastError }
  // missing 为 null 表示「没查清」：不结算，下一轮重扫（结算是一次性的，
  // 不能凭一次读失败就断定全部领完）
  return { claimed, points, missing }
}

const isAuthGone = (e) => e?.signIn === "expired" || e instanceof SignedOut

// 失败归一：登录失效 → ineligible（账号不能参与，别反复重试）；其余 → failed
// （magpie 半小时后重试）。
function toOutcome(e, prefix) {
  if (isAuthGone(e)) return { outcome: "ineligible", message: `${prefix}：登录已失效，请重新登录` }
  return { outcome: "failed", message: `${prefix}：${e?.message ?? String(e)}` }
}

export { ONBOARDING_TASKS, ONBOARDING_TOTAL, DAILY_QUOTA_FIELD }
