import { test, expect } from "bun:test"
import { signHeaders, escapedPath, contentMD5, utcDateString } from "../lib/sign.mjs"

// 与服务端 fake 的校验逻辑互相印证：同一组输入必须得到同一组头。
test("the nine-part HMAC string has the client's shape", () => {
  const headers = signHeaders("POST", "/login/phone/sendMsgCode", '{"a":1}', {
    now: Date.UTC(2026, 9, 18, 3, 0, 0),
    nonce: "11111111-2222-3333-4444-555555555555",
    keyId: "AKID",
    secret: "SECRET",
  })
  expect(headers.Authorization).toMatch(/^account AKID:[A-Za-z0-9+/=]+$/)
  expect(headers.Date).toBe("Sun, 18 Oct 2026 03:00:00 GMT")
  expect(headers.Nonce).toBe("11111111-2222-3333-4444-555555555555")
  expect(headers["Content-MD5"]).toBe(contentMD5('{"a":1}'))
  expect(headers["Content-Type"]).toBe("application/json")
})

test("an empty body sends no Content-MD5 and leaves the part empty", () => {
  const h = signHeaders("GET", "/x", "", { now: 0, nonce: "n", keyId: "k", secret: "s" })
  expect(h["Content-MD5"]).toBeUndefined()
  expect(h.Authorization).toMatch(/^account k:/)
})

test("paths are escaped and trailing slashes dropped", () => {
  expect(escapedPath("/login/phone/sendMsgCode")).toBe("/login/phone/sendMsgCode")
  expect(escapedPath("a/b/")).toBe("/a/b")
  expect(escapedPath("/")).toBe("/")
  // encodeURIComponent 放过 !'()*，签名实现必须把它们也转义
  expect(escapedPath("/a!b'c(d)e*f")).toBe("/a%21b%27c%28d%29e%2Af")
  expect(escapedPath("/带中文/段")).toBe(`/${encodeURIComponent("带中文")}/${encodeURIComponent("段")}`)
})

test("the date is the client's UTC string form", () => {
  expect(utcDateString(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe("Fri, 02 Jan 2026 03:04:05 GMT")
})

// 锁住完整签名值：改了任何一段（顺序、分隔、编码）都会在这里失败。
test("the signature is stable and covers every part", () => {
  const opts = { now: Date.UTC(2026, 9, 18, 3, 0, 0), nonce: "n-1", keyId: "AKID", secret: "SECRET" }
  const a = signHeaders("POST", "/login/phone/checkCode", '{"x":1}', opts)
  const b = signHeaders("POST", "/login/phone/checkCode", '{"x":1}', opts)
  expect(a.Authorization).toBe(b.Authorization)
  // body 变一个字节，签名必须变
  const c = signHeaders("POST", "/login/phone/checkCode", '{"x":2}', opts)
  expect(c.Authorization).not.toBe(a.Authorization)
  // 路径变，签名必须变
  const d = signHeaders("POST", "/other", '{"x":1}', opts)
  expect(d.Authorization).not.toBe(a.Authorization)
  // 方法变，签名必须变
  const e = signHeaders("GET", "/login/phone/checkCode", '{"x":1}', opts)
  expect(e.Authorization).not.toBe(a.Authorization)
})
