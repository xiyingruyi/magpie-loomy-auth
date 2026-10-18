// 用量：两个钱包。
//
//   GET /api/v2/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat
//   → data: { balance（永久积分）, dailyBalance（每日赠送还剩多少）,
//            availableBalance（两者之和）, list[], total }
//
// 实测要点：这个接口**不返回**每日额度。docs 与参照实现里读的
// dailyLimitPoints / dailyRemainingPoints 在上游是不存在字段 —— 拿它们做
// 回退就等于「把余额当上限」，用量页会显示成「0 / 4673 · 0% used」，凭空
// 造出一个额度。真实额度只有签到接口的 `data.dailyQuota` 会给（5000），
// 签到成功时记到账号上（见 lib/checkin.mjs）；没签到过的账号用出厂值。
//
// 每日赠送积分每天刷新（就是签到刷的那个数），永久积分不过期。
//
// signIn 的取舍：干净读取时**不报 signIn** —— magpie 的规则是「没有它时，说
// 要重新登录的错误会标记账号，干净的读取会清除标记」。Loomy 没有续期接口，
// 若这里报 kept，一次瞬时 401 留下的 lapsed 标记就永远清不掉（参照实现踩过
// 这个坑，与 CatPaw 同修）。

import { gatewayJson, toNum } from "./http.mjs"
import { NAME, DEFAULT_DAILY_QUOTA } from "./constants.mjs"
import { beijingMidnight } from "./checkin.mjs"

const RECORDS = "/api/v2/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat"

// payload → magpie 的 usage 形状。纯函数，便于单测。
//   dailyQuota：这个账号已知的每日额度（签到学到的）；没有就用出厂值。
export function usageFrom(payload, { user, dailyQuota } = {}) {
  const data = payload?.data?.data ?? payload?.data ?? {}
  const permanent = toNum(data.balance)
  const daily = toNum(data.dailyBalance)
  const quota = toNum(dailyQuota) ?? DEFAULT_DAILY_QUOTA

  const windows = []
  if (daily != null) {
    // dailyBalance 是**还剩多少**；额度是固定的每日赠送（默认 5000）。
    // 用掉的 = 额度 − 剩余，余额比额度大时按 0 算（上游发放量变过也不出负数）。
    const left = Math.max(0, daily)
    const spent = Math.max(0, quota - left)
    // magpie 把 amount 当「已经用掉多少」（QuotaSpan.Amount 的注释就是
    // "the window's count, used"），卡片上拼成 "327 / 5,000 credits · 7% used"。
    // 报余额会得到「上限 = 余额」这种自相矛盾的显示。
    windows.push({
      name: "每日赠送积分",
      used: quota > 0 ? Math.min(100, Math.round((spent / quota) * 100)) : 0,
      amount: spent,
      limit: quota,
      unit: "credits",
      resetsAt: beijingMidnight(),
      span: 86400,
    })
  }
  if (permanent != null) {
    windows.push({ name: "永久积分", used: 0, display: `${permanent} credits`, aside: true })
  }
  const out = { plan: NAME, windows }
  if (user) out.user = String(user)
  if (permanent != null) out.balance = `${permanent} credits`
  return out
}

// 用量读取的延迟预算。实测这个接口在 2.4s–16s 之间抖动（偶发 20s 以上），
// 20s 的默认值会把「上游慢」报成「读取失败」。积分只是展示，宁可多等。
const USAGE_TIMEOUT = 45_000

// 上一次读成功的结果，按 session 分桶。用途只有一个：这次读失败（超时 /
// 上游 500）时，把上次的数**标着时间**交回去，而不是让用量页整块变成错误。
// 不做过期缓存 —— 成功一次就用新的。
const lastGood = new Map()
const LAST_GOOD_MAX = 16

// 完整的 usage 钩子体：读账号 → 取 session → 查积分。永不抛。
export async function usageOf(getAuth, { sessionOf, userOf, quotaOf, call }) {
  let auth
  try {
    auth = await getAuth()
  } catch (e) {
    return { error: e?.message ?? String(e), windows: [] }
  }
  let session = ""
  try {
    session = String((await sessionOf(auth)) ?? "").trim()
  } catch (e) {
    return { error: e?.message ?? String(e), windows: [] }
  }
  if (!session) return { error: "尚未登录", windows: [] }
  try {
    const payload = await gatewayJson("GET", RECORDS, session, { timeout: USAGE_TIMEOUT, ...(call ? { call } : {}) })
    const out = usageFrom(payload, { user: userOf?.(auth), dailyQuota: quotaOf?.(auth) })
    if (lastGood.size >= LAST_GOOD_MAX) lastGood.clear()
    lastGood.set(session, out)
    return out
  } catch (e) {
    const out = { error: e?.message ?? String(e), windows: [] }
    // 只有登录确实失效才标记；网络/上游故障不碰账号状态
    if (e?.signIn === "expired") {
      out.signIn = "expired"
      lastGood.delete(session)
      return out
    }
    // 读失败但手里有上次成功的数：交回去，并说明这是什么时候读的。
    // magpie 的卡片上仍能看到额度，错误不会被当成「账号有问题」。
    const kept = lastGood.get(session)
    if (kept) {
      return { ...kept, error: `${out.error}（显示的是上一次读取的结果）`, stale: true }
    }
    return out
  }
}
