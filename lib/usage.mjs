// 用量：两个钱包。
//
//   GET /api/v1/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat
//   （v2 是同一份数据的另一个入口）
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

const recordsPath = (version) => `/api/${version}/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat`

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

// 读取预算：**magpie 只给 20 秒**（internal/provider/plugin_usage.go：
// `context.WithTimeout(ctx, 20*time.Second)`），而且这个 20 秒从钩子被调起的
// 那一刻就开始走了。插件自己给 45 秒只会让它跑过宿主的期限：宿主先放弃、
// 把这次读当作失败，插件后来算出来的数没人要 —— 卡片上就是「暂时无法获取
// 最新额度」，即使积分充足。
//
// 实测这个接口 0.3s–28s 抖动，偶尔回业务码 900000（「系统内部错误」，HTTP 仍是
// 200）。所以：先问 v2；2 秒还没回来就**同时**问 v1（同一份数据的另一个入口），
// 谁先成功用谁。常见情况只发一个请求；最坏 2s + 12s = 14s，离 20 秒仍有余量。
// 串行重试试过 —— 最坏 16 秒太贴边，而且一次「慢但会成功」的读要白等完第一段。
const ATTEMPT_TIMEOUT = 12_000
const HEDGE_AFTER = 2_000

// 上一次读成功的结果，按 session 分桶。用途只有一个：这次读失败（超时 /
// 上游 500）时，把上次的数**标着时间**交回去，而不是让用量页整块变成错误。
// 不做过期缓存 —— 成功一次就用新的。
const lastGood = new Map()
const LAST_GOOD_MAX = 16

// 一次读取：v2 先走，慢了就对冲一个 v1，第一个成功的说了算。
//
// 登录失效要**两边都说**才算数。实测这个上游偶尔对一次只读请求回
// code 100002（60 次里出现过 1 次），而 session 本身是好的 —— 拿一次这种
// 回答去标记账号，用户会看到「登录已失效，请重新添加此账号」，要重新短信
// 登录一次才消掉。真正的失效两边都会回；v2 说失效时 v1 会被叫起来确认。
async function readRecords(session, call) {
  const opts = { timeout: ATTEMPT_TIMEOUT, ...(call ? { call } : {}) }
  const v2 = attempt(session, recordsPath("v2"), opts)
  // 2 秒内没有结果（成功或失败都算有结果）就叫第二个入口来对冲
  let timer
  const hedge = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), HEDGE_AFTER)
  })
  const raced = await Promise.race([v2, hedge])
  clearTimeout(timer)
  if (raced?.ok) return raced.payload

  const v1 = attempt(session, recordsPath("v1"), opts)
  // 第一个成功的立刻返回；两个都没成功才等它们都结束，好把两边的原因都报出来
  const winners = await Promise.all([v2, v1])
  const ok = winners.find((r) => r.ok)
  if (ok) return ok.payload
  const [a, b] = winners
  if (a.gone && b.gone) throw b.error
  // 一边说失效、另一边说上游故障：这是上游在抖，不是账号没了。报故障，
  // 让调用方保留上一次读数，且**不**碰账号的登录状态。
  throw new Error(`${b.error?.message ?? b.error}（v2：${a.error?.message ?? a.error}）`)
}

async function attempt(session, path, opts) {
  try {
    return { ok: true, payload: await gatewayJson("GET", path, session, opts) }
  } catch (e) {
    return { ok: false, error: e, gone: e?.signIn === "expired" }
  }
}

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
    const payload = await readRecords(session, call)
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
