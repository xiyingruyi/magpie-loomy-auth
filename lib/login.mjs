// 登录：短信验证码（两步）。
//
// 上游只有这一种账号登录方式：
//   1. POST /login/phone/sendMsgCode  {ccode, phone, expire:300}      → { msgid }
//   2. POST /login/phone/checkCode    {ccode, phone, mcode, msgid, expire:1209600}
//      → { session, userid }
//
// session 有效期 14 天（checkCode 里申请的 expire 就是它），**没有续期接口**：
// 到期只能重新登录。这一点写进了 index 的 auth 里（不提供 refresh）。
//
// 两个请求都带客户端签名的 base 信封（appid / modelid / version / devid /
// ua / traceid），缺了会被上游当作非客户端流量。

import { randomBytes } from "node:crypto"
import { APP_ID, SESSION_DAYS, OK, AUTH_CODES } from "./constants.mjs"
import { signedPost, codeOf, messageOf } from "./http.mjs"

// 客户端 _makeBase() 的信封
export function makeBase(traceid) {
  return {
    appid: APP_ID(),
    modelid: "Web",
    version: "1.0.0",
    devid: "web",
    ua: "Loomy|Desktop|Electron|macOS",
    traceid: traceid ?? randomBytes(16).toString("hex"),
  }
}

// 手机号规范化：客户端去空格/连字符，接受 +86 / 86 前缀。
export function normalizePhone(raw) {
  const trimmed = String(raw ?? "").replace(/[\s-]/g, "")
  let digits = trimmed.replace(/^\+86/, "")
  if (digits.length === 13 && digits.startsWith("86")) digits = digits.slice(2)
  if (/^1[3-9]\d{9}$/.test(digits)) return digits
  return null
}

export const maskPhone = (phone) => `${String(phone).slice(0, 3)}****${String(phone).slice(-4)}`

// 发码。返回 { msgid }；失败抛错（带人话说明），由调用方折成 failed 结果。
export async function sendCode(phone, { call } = {}) {
  const sent = await signedPost(
    "/login/phone/sendMsgCode",
    { base: makeBase(), param: { ccode: "86", phone, expire: 300 } },
    call ? { call } : {},
  )
  const code = codeOf(sent)
  if (AUTH_CODES.has(code)) throw new Error("登录态已失效，请重新获取验证码")
  if (code !== OK) throw new Error(`验证码发送失败：${messageOf(sent) || `code=${code}`}`)
  const msgid = sent?.data?.msgid
  if (!msgid) throw new Error("验证码发送成功但上游没有返回 msgid")
  return { msgid: String(msgid) }
}

// 核码换 session。返回 { session, userId, expires }。
export async function checkCode({ phone, mcode, msgid }, { call } = {}) {
  const answer = await signedPost(
    "/login/phone/checkCode",
    { base: makeBase(), param: { ccode: "86", phone, mcode, msgid, expire: SESSION_DAYS * 86400 } },
    call ? { call } : {},
  )
  const code = codeOf(answer)
  // 210106「验证码已失效」/ 210107「验证码错误」是常见回执，给更直白的说法
  if (code === "210106") throw new Error("验证码已失效，请重新获取")
  if (code === "210107") throw new Error("验证码错误，请重试")
  if (AUTH_CODES.has(code)) throw new Error("登录态已失效，请重新获取验证码")
  if (code !== OK) throw new Error(`登录失败：${messageOf(answer) || `code=${code}`}`)
  const session = String(answer?.data?.session ?? "").trim()
  if (!session) throw new Error("登录成功但上游没有返回 session")
  return {
    session,
    userId: String(answer?.data?.userid ?? ""),
    expires: Date.now() + SESSION_DAYS * 86400e3,
  }
}
