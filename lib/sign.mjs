// 账号域的 HMAC-SHA1 签名。
//
// 登录链路（account.xfinfr.com）的每个请求都带一组签名头，签名对象是一条
// 9 段、以 \n 连接的待签串：
//
//   METHOD / ESCAPED_PATH / QUERY / CONTENT_MD5 / CONTENT_TYPE / DATE /
//   NONCE / SIGNED_HEADERS / CANONICALIZED_HEADERS
//
// 后两段在这里恒为空串（客户端同样如此）。AK/SK 是 Loomy 桌面客户端安装包里
// 内置的一对常量，不是任何用户的凭据 —— 这是复刻客户端指纹，不是密码学边界。
//
// 对真实账号域实测过：签名正确时上游回业务错误码（例如 210106「验证码已
// 失效」），签名错误时回 020002 —— 也就是说这条链路是双向可验证的。

import { createHash, createHmac, randomUUID } from "node:crypto"
import { ACCESS_KEY_ID, ACCESS_KEY_SECRET } from "./constants.mjs"

// RFC 3986 的严格转义：encodeURIComponent 放过 !'()*，而上游的签名实现把它们
// 也转义了（客户端 sign.js 是同一份写法）。
export function escapeSegment(segment) {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase())
}

// 路径规范化：前导斜杠补齐，末尾斜杠去掉（长度 1 的 "/" 除外），逐段转义。
export function escapedPath(path) {
  let clean = String(path ?? "")
  if (!clean.startsWith("/")) clean = `/${clean}`
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1)
  return clean.split("/").map(escapeSegment).join("/")
}

// 空 body 时 Content-MD5 留空且不发这个头（GET 请求就是这样）。
export function contentMD5(bodyString) {
  if (!bodyString) return ""
  return createHash("md5").update(bodyString).digest("base64")
}

export function utcDateString(now = Date.now()) {
  return new Date(now).toUTCString()
}

// 签名头。bodyString 必须与真正发出去的字节完全一致 —— 调用方因此先把 body
// 序列化一次，再用同一个字符串去发。
export function signHeaders(method, path, bodyString, { now, nonce, keyId, secret } = {}) {
  const md5 = contentMD5(bodyString)
  const date = utcDateString(now)
  // 客户端用带连字符的 UUID 当 nonce
  const n = nonce ?? randomUUID()
  const stringToSign = [String(method).toUpperCase(), escapedPath(path), "", md5, "application/json", date, n, "", ""].join("\n")
  const signature = createHmac("sha1", secret ?? ACCESS_KEY_SECRET()).update(stringToSign).digest("base64")
  const headers = {
    Authorization: `account ${keyId ?? ACCESS_KEY_ID()}:${signature}`,
    Date: date,
    Nonce: n,
    "Content-Type": "application/json",
  }
  if (md5) headers["Content-MD5"] = md5
  return headers
}
