// 用量：两个钱包。
//
//   GET /api/v2/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat
//   → data: { balance（永久积分）, dailyBalance（每日赠送）, dailyLimitPoints,
//            dailyRemainingPoints, list[], total }
//
// 每日赠送积分每天刷新（就是签到刷的那个数），永久积分不过期。
//
// signIn 的取舍：干净读取时**不报 signIn** —— magpie 的规则是「没有它时，说
// 要重新登录的错误会标记账号，干净的读取会清除标记」。Loomy 没有续期接口，
// 若这里报 kept，一次瞬时 401 留下的 lapsed 标记就永远清不掉（参照实现踩过
// 这个坑，与 CatPaw 同修）。

import { gatewayJson, toNum } from "./http.mjs"
import { NAME } from "./constants.mjs"
import { beijingMidnight } from "./checkin.mjs"

const RECORDS = "/api/v2/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat"

// payload → magpie 的 usage 形状。纯函数，便于单测。
export function usageFrom(payload, { user } = {}) {
  const data = payload?.data?.data ?? payload?.data ?? {}
  const permanent = toNum(data.balance)
  const daily = toNum(data.dailyBalance)
  const dailyLimit = toNum(data.dailyLimitPoints)
  const dailyLeft = toNum(data.dailyRemainingPoints)

  const windows = []
  if (daily != null || dailyLimit != null) {
    const amount = daily ?? 0
    const limit = dailyLimit && dailyLimit > 0 ? dailyLimit : amount
    const left = dailyLeft ?? amount
    windows.push({
      name: "每日赠送积分",
      used: limit > 0 ? Math.max(0, Math.round(((limit - left) / limit) * 100)) : 0,
      amount,
      limit,
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

// 完整的 usage 钩子体：读账号 → 取 session → 查积分。永不抛。
export async function usageOf(getAuth, { sessionOf, userOf, call }) {
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
    const payload = await gatewayJson("GET", RECORDS, session, call ? { call } : {})
    return usageFrom(payload, { user: userOf?.(auth) })
  } catch (e) {
    const out = { error: e?.message ?? String(e), windows: [] }
    // 只有登录确实失效才标记；网络/上游故障不碰账号状态
    if (e?.signIn === "expired") out.signIn = "expired"
    return out
  }
}
