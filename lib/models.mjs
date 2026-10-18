// 积分网关的数据形状：模型清单、两个钱包、积分记录。
//
// 模型清单（GET /api/v1/models）是 OpenAI 的形态，外加 capabilities 位图。
// **实测**（真实账号）每条 entry 的字段是：
//   { id, name, object, owned_by, type: "chat"|"image", protocol,
//     context_length, max_output_tokens, default_reasoning_effort,
//     reasoning_efforts: ["none","low","medium","high","xhigh"],
//     capabilities: { reasoning, vision, function_calling, streaming,
//       system_message, input_modalities, output_modalities } }
// 展示名尾部带用量倍率，形如 "DeepSeek V4.1 Flash(x2.0)" / "GLM 5.3 Flash(x0.8)"。
// 注意：参考实现读的是 context_window / max_tokens（旧字段名），真实上游早改成
// context_length / max_output_tokens —— 读旧名字会让 13 个模型的 output 全部
// 落成 0。这里两个名字都认，新名字优先。
//
// 关键取舍：**最大输出只认上游真的给了的数**。上游给了 max_output_tokens 就
// 原样声明；没给就写 0（「没说」），交给 magpie 从 models.dev 取值。绝不能自己
// 填一个「保守」的默认值 —— magpie 把 limit.output 当硬上限下发，编出来的数字
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

// 上游承认的推理档位。magpie 的 fitEffort 会把 agent 要的档位按模型声明的
// variants 键名就近匹配（catalog.NearestEffort），所以键名必须和上游真能收的
// 一致；报错了档，magpie 要么发一个上游不认的值、要么就近折损一档。
const KNOWN_EFFORTS = ["none", "low", "medium", "high", "xhigh"]

// 从目录里读出这个模型的推理档位，折进上游承认的那组。
function variantsFor(entry, reasoning) {
  if (!reasoning) return {}
  const said = Array.isArray(entry?.reasoning_efforts) ? entry.reasoning_efforts : null
  const list = (said && said.length ? said : KNOWN_EFFORTS)
    .map((v) => String(v).trim().toLowerCase())
    .filter((v, i, a) => v && a.indexOf(v) === i && KNOWN_EFFORTS.includes(v))
  if (!list.length) return {}
  return Object.fromEntries(list.map((v) => [v, {}]))
}

// 一条上游目录 → magpie 的运行时模型（OpenCode 的 provider 运行时形状）。
export function runtimeModel(entry, providerID) {
  const id = String(entry?.id ?? "").trim()
  if (!id) return null
  const caps = entry?.capabilities ?? {}
  const { name, rate } = splitRateSuffix(entry?.name ?? entry?.display_name ?? id)
  // 新字段名优先；参考实现用的旧名字（context_window/max_tokens）作为兼容回退
  const context = num(entry?.context_length ?? entry?.context_window ?? entry?.limit?.context)
  const output = num(entry?.max_output_tokens ?? entry?.max_tokens ?? entry?.limit?.output)
  const reasoning = !!caps.reasoning
  // 生图模型 type=image、output_modalities 含 image；这里决定「能不能出图」。
  // 上游只给「能输出 image」的信号，没有「同时也能输出 text」的信号 —— 生图
  // 模型 output 只能 image，文本模型只能 text，不存在混合（目录里没有）。
  const outMods = Array.isArray(caps.output_modalities) ? caps.output_modalities.map((v) => String(v).toLowerCase()) : null
  const producesImage = outMods ? outMods.includes("image") : entry?.type === "image"
  // 生图模型在插件里**没有可用的路**：上游只让它们走
  // /api/v1/images/generations（实测三个都如此，chat 端点一律 404
  // 「该模型暂未开放」），而 magpie 对插件账号（p.Account != nil）在生图路径上
  // 直接返回 nil —— 它不替插件转发 images API。列出来只会让用户选中后必然报错。
  // 所以这里直接不产出，见 modelsFromCatalog。
  const inMods = Array.isArray(caps.input_modalities) ? caps.input_modalities.map((v) => String(v).toLowerCase()) : null
  const acceptsImage = inMods ? inMods.includes("image") : !!caps.vision
  // 其余模态照上游说的映射：实测 Kimi-k2.6 的 input_modalities 含 video，
  // 硬编码 false 会让它少吃一种输入。
  const inHas = (m) => (inMods ? inMods.includes(m) : false)
  const outHas = (m) => (outMods ? outMods.includes(m) : false)
  // 工具调用：只有上游**明确说了 false** 才算不支持。实测 `auto`（自动·均衡）
  // 条目连 capabilities 都没有，但它会路由到一个支持工具调用的模型（真发一次
  // tool_choice=required 拿到了 tool_calls）。按 `=== true` 判会把它标成
  // toolcall:false，用户一选 auto 就用不了工具。生图模型永远不支持。
  const toolcall = caps.function_calling !== false && !producesImage
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
      attachment: acceptsImage,
      toolcall,
      input: { text: true, image: acceptsImage, audio: inHas("audio"), video: inHas("video"), pdf: inHas("pdf") },
      output: { text: !producesImage, image: producesImage, audio: outHas("audio"), video: outHas("video"), pdf: outHas("pdf") },
      interleaved: false,
    },
    release_date: "",
    // 推理档位来自目录（reasoning_efforts），报错档名会让 magpie 就近折损
    variants: variantsFor(entry, reasoning),
  }
  if (rate) model.rate = rate
  return model
}

// 整个目录 → { id: model }。空条目、无 id 的跳过；已有配置的字段在下游合并。
//
// 生图模型（type=image / output 只有 image）被**剔除**：它们的唯一入口是
// /api/v1/images/generations，而 magpie 不替插件账号转发那个接口（见
// runtimeModel 里的说明）。留一张选不了的模型比不列更糟。
export function modelsFromCatalog(entries, providerID) {
  const out = {}
  for (const entry of Array.isArray(entries) ? entries : []) {
    const m = runtimeModel(entry, providerID)
    if (m && m.capabilities.output.text) out[m.id] = m
  }
  return out
}

// 未登录时 config 钩子用的扁平形状（和 FALLBACK_MODELS 同形）。
// 生图模型同样剔除：插件账号在 magpie 里没有生图的路。
export function configModelsFrom(entries) {
  const out = {}
  for (const entry of Array.isArray(entries) ? entries : []) {
    const m = runtimeModel(entry, "")
    if (!m || !m.capabilities.output.text) continue
    const cfg = {
      name: m.name,
      reasoning: m.capabilities.reasoning,
      tool_call: m.capabilities.toolcall,
      modalities: {
        input: ["text", ...(m.capabilities.input.image ? ["image"] : []), ...(m.capabilities.input.video ? ["video"] : [])],
        output: m.capabilities.output.image ? ["image"] : ["text"],
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
