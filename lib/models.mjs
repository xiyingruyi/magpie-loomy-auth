// 积分网关的数据形状：模型清单、两个钱包、积分记录。
//
// 模型清单（GET /api/v1/models）是 OpenAI 的形态，外加一个 capabilities 位图：
//   { id, name, capabilities: { reasoning, function_calling, vision },
//     context_window, max_tokens }
// 展示名尾部带用量倍率，形如 "Spark X2.5 (x0.1)" / "GLM 5.3 Flash（x0.8）"。
//
// 关键取舍：**最大输出只认上游真的给了的数**。上游给了 max_tokens 就原样
// 声明；没给就写 0（「没说」），交给 magpie 从 models.dev 取值。绝不能自己填
// 一个「保守」的默认值 —— magpie 把 limit.output 当硬上限下发，编出来的数字
// 就是真实的天花板（华为 codearts 那次就是这样把 384000 夹成 32000 的）。

import { NPM } from "./constants.mjs"

// 拆出展示名尾部的倍率：全角/半角括号都认，只认 x 加数字的形态。
export function splitRateSuffix(name) {
  const trimmed = String(name ?? "").trimEnd()
  for (const [close, open] of [
    [")", "("],
    ["）", "（"],
  ]) {
    if (!trimmed.endsWith(close)) continue
    const body = trimmed.slice(0, -1)
    const at = body.lastIndexOf(open)
    if (at < 0) continue
    const inner = body.slice(at + 1).trim()
    if (!/^x\s*\d+(\.\d+)?$/i.test(inner)) return { name: trimmed, rate: undefined }
    const bare = body.slice(0, at).trimEnd()
    return { name: bare || trimmed, rate: inner.replace(/\s+/g, "").toLowerCase() }
  }
  return { name: trimmed, rate: undefined }
}

const num = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : 0
}

// 一条上游目录 → magpie 的运行时模型（OpenCode 的 provider 运行时形状）。
export function runtimeModel(entry, providerID) {
  const id = String(entry?.id ?? "").trim()
  if (!id) return null
  const caps = entry?.capabilities ?? {}
  const { name, rate } = splitRateSuffix(entry?.name ?? entry?.display_name ?? id)
  const context = num(entry?.context_window ?? entry?.context_length ?? entry?.limit?.context)
  const output = num(entry?.max_tokens ?? entry?.limit?.output)
  const image = !!caps.vision
  const reasoning = !!caps.reasoning
  const model = {
    id,
    providerID,
    name: name || id,
    api: { id, url: "", npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    // output 为 0 是「上游没说」，见文件头
    limit: { context, output },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: image,
      toolcall: caps.function_calling !== false,
      input: { text: true, image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    // 上游只有 low/medium/high 三档；见 lib/thinking.mjs 的折叠规则
    variants: reasoning ? { low: {}, medium: {}, high: {} } : {},
  }
  if (rate) model.rate = rate
  return model
}

// 整个目录 → { id: model }。空条目、无 id 的跳过；已有配置的字段在下游合并。
export function modelsFromCatalog(entries, providerID) {
  const out = {}
  for (const entry of Array.isArray(entries) ? entries : []) {
    const m = runtimeModel(entry, providerID)
    if (m) out[m.id] = m
  }
  return out
}

// 未登录时 config 钩子用的扁平形状（和 FALLBACK_MODELS 同形）。
export function configModelsFrom(entries) {
  const out = {}
  for (const entry of Array.isArray(entries) ? entries : []) {
    const m = runtimeModel(entry, "")
    if (!m) continue
    const cfg = {
      name: m.name,
      reasoning: m.capabilities.reasoning,
      tool_call: m.capabilities.toolcall,
      modalities: {
        input: m.capabilities.input.image ? ["text", "image"] : ["text"],
        output: ["text"],
      },
    }
    const limit = {}
    if (m.limit.context > 0) limit.context = m.limit.context
    if (m.limit.output > 0) limit.output = m.limit.output
    if (Object.keys(limit).length) cfg.limit = limit
    out[m.id] = cfg
  }
  return out
}
