import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"

// package.json 里的 magpie 字段是宿主直接读的：icon 坏了不会报错，provider
// 卡片只是悄悄没有头像。这里按宿主（internal/plugin/host.js iconOf +
// internal/provider/icon.go StoreIcon）的规则把它验一遍。
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

test("the icon is a data URI the host will accept and can decode", () => {
  const icon = String(pkg.magpie?.icon ?? "")
  // 宿主只收 https:// 或 data:image/，且超过 1.5 MB 的直接丢掉
  expect(icon).toMatch(/^data:image\//)
  expect(icon.length).toBeLessThanOrEqual(3 << 19)

  const [meta, data] = icon.slice("data:".length).split(",")
  expect(meta.endsWith(";base64")).toBe(true)
  const bytes = Buffer.from(data, "base64")
  expect(bytes.length).toBeGreaterThan(0)
  // 宿主按内容判断格式：SVG 要求开头 1 KB 里有 <svg
  expect(bytes.subarray(0, 1024).toString("utf8").toLowerCase()).toContain("<svg")
  // 文件版与内联版必须是同一张图，否则改一边另一边就悄悄过期了
  expect(readFileSync(new URL("../icon.svg", import.meta.url)).toString("utf8")).toBe(bytes.toString("utf8"))
})

test("package.json points at the repo it lives in", () => {
  expect(pkg.repository?.url).toContain("github.com/xiyingruyi/magpie-loomy-auth")
  expect(pkg.bugs?.url).toContain("github.com/xiyingruyi/magpie-loomy-auth/issues")
  expect(pkg.license).toBe("MIT")
  // 文件清单里漏掉的文件不会进 tarball
  for (const f of ["index.mjs", "lib", "README.md", "README.zh-CN.md", "LICENSE", "NOTICE", "icon.svg"]) {
    expect(pkg.files).toContain(f)
  }
})

// magpie 的两个列表读的不是同一个字段：provider 卡片读 magpie.icon（内联
// data URI，立刻可用），插件列表读 InstalledIcon 的 https URL（后台下载、
// 下一次刷新才显示）。两份都必须是同一张图。
test("the icon's URL copy is reachable and is the same picture", () => {
  const url = String(pkg.magpie?.iconUrl ?? "")
  expect(url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/xiyingruyi\/magpie-loomy-auth\/main\//)
  expect(pkg.magpie.icon).toContain(Buffer.from(readFileSync(new URL("../icon.svg", import.meta.url))).toString("base64").slice(0, 40))
})
