// 两个平面的 HTTP 客户端。
//
//   账号域（account.xfinfr.com）：登录链路，每个请求带 HMAC 签名；
//   积分网关（loomyad.xunfei.cn）：模型清单、对话、积分、签到，带双凭据头。
//
// 一个必须记住的上游行为：**这两处对登录失效都回 HTTP 200**，只在 body 的
// code 里写 100002/020002（实测）。所以鉴权判断只能看 code；只看状态码会把
// 死账号当成正常账号。

import { OK, AUTH_CODES, ACCOUNT_BASE, POINTS_BASE, REQUEST_TIMEOUT } from "./constants.mjs"
import { signHeaders } from "./sign.mjs"

// 登录态失效：调用方据此把账号标成 lapsed / 让 checkin 报 ineligible。
export class SignedOut extends Error {
  constructor(message = "Loomy 登录已失效，请重新登录") {
    super(message)
    this.signIn = "expired"
  }
}

export const expired = (message) => Object.assign(new Error(message), { signIn: "expired" })

// 业务码/文案的位置在上游有两种：顶层的 {code, desc}，以及 OpenAI 形状的
// {error: {code, message}}。两种都认，避免上游换信封后错误被当成成功。
export const codeOf = (payload) => {
  const raw = payload?.code ?? payload?.error?.code ?? payload?.data?.code ?? ""
  return String(raw ?? "").trim()
}
export const messageOf = (payload) =>
  String(
    payload?.desc ??
      payload?.message ??
      payload?.msg ??
      payload?.error?.message ??
      payload?.error?.desc ??
      "",
  ).trim()

export function toNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string" && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

async function readJson(res, what) {
  const text = await res.text().catch(() => "")
  try {
    return text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${what} 返回了无法解析的内容（HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ""}）`)
  }
}

// 一个带签名的 POST。签名覆盖的字节必须与真正发出去的一致，所以 body 只
// 序列化一次。
export async function signedPost(pathname, body, { call = fetch, timeout = REQUEST_TIMEOUT } = {}) {
  const bodyString = JSON.stringify(body ?? {})
  const res = await call(ACCOUNT_BASE() + pathname, {
    method: "POST",
    headers: signHeaders("POST", pathname, bodyString),
    body: bodyString,
    signal: AbortSignal.timeout(timeout),
  })
  const payload = await readJson(res, "Loomy 账号接口")
  if (!payload) throw new Error(`Loomy 账号接口返回了空响应（HTTP ${res.status}）`)
  if (!res.ok) throw new Error(`Loomy 账号接口返回 HTTP ${res.status}：${messageOf(payload) || `code=${codeOf(payload)}`}`)
  return payload
}

// 网关请求。双凭据头是上游的要求：模型/积分网关读 `token`，对话网关读
// `Authorization: Bearer`，客户端两个都发，这里也一样。
//
// 返回 { payload, res }：多数端点要业务码，对话端点要原始 Response（SSE 直通）。
export async function tokenRequest(method, path, session, { body, call = fetch, timeout = REQUEST_TIMEOUT, signal } = {}) {
  const token = String(session ?? "").trim()
  if (!token) throw new SignedOut("Loomy：缺少登录态")
  const headers = { token, Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream" }
  const init = { method, headers, signal: signal ?? AbortSignal.timeout(timeout) }
  if (body !== undefined) {
    // charset=utf-8 是必须的：没有它上游按 GBK 解 body，中文会变成乱码
    headers["Content-Type"] = "application/json;charset=utf-8"
    init.body = JSON.stringify(body)
  }
  const res = await call(POINTS_BASE() + path, init)
  // 上游理论上永远回 200；真回了 401/403 也按失效处理，多一道保险
  if (res.status === 401 || res.status === 403) throw new SignedOut()
  return { res }
}

// 网关的 JSON 端点：读 body、按业务码判失效、要求 000000。
export async function gatewayJson(method, path, session, opts = {}) {
  const { res } = await tokenRequest(method, path, session, opts)
  const payload = await readJson(res, "Loomy 接口")
  if (!payload) throw new Error(`Loomy 接口返回了空响应（HTTP ${res.status}）`)
  if (AUTH_CODES.has(codeOf(payload))) throw new SignedOut()
  if (!res.ok) throw new Error(`Loomy 接口返回 HTTP ${res.status}：${messageOf(payload) || `code=${codeOf(payload)}`}`)
  if (codeOf(payload) !== OK) throw new Error(`Loomy 接口：${messageOf(payload) || `code=${codeOf(payload)}`}`)
  return payload
}
