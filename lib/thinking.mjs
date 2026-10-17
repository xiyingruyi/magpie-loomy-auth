// 请求体的两处适配（上游客户端自己的改写规则）。
//
// 1. 思考档位只认 low / medium / high。agent 们可能发 none/minimal/low/
//    medium/high/xhigh/max，甚至 `reasoning: {effort}` 这种新形状 —— 统一折进
//    这三档；关不掉的值（none/off/disabled）直接删字段，比发一个上游不认识的
//    值更安全。
//
// 2. DeepSeek 系模型读图的方式不是 OpenAI 的 image_url 块，而是**文本里的
//    `<image_base64>data:...</image_base64>` 标记**。data URI 图片转成标记并
//    并入相邻的文本块；http(s) 图片 URL 原样保留（没有证据表明标记接受 URL）。

const LEVEL = (v) => {
  switch (String(v ?? "").trim().toLowerCase()) {
    case "minimal":
    case "low":
      return "low"
    case "medium":
      return "medium"
    case "high":
    case "xhigh":
    case "max":
    case "ultra":
      return "high"
    default:
      // none / off / disabled / 空串 / 不认识：上游没有对应档，删掉
      return null
  }
}

// 把请求里的思考档位折进上游的三档。返回 true 表示改写过。
export function foldReasoning(body) {
  if (!body || typeof body !== "object") return false
  let changed = false
  if (typeof body.reasoning_effort === "string") {
    const folded = LEVEL(body.reasoning_effort)
    if (folded !== body.reasoning_effort) {
      if (folded) body.reasoning_effort = folded
      else delete body.reasoning_effort
      changed = true
    }
  }
  if (body.reasoning && typeof body.reasoning === "object" && typeof body.reasoning.effort === "string") {
    const folded = LEVEL(body.reasoning.effort)
    if (folded !== body.reasoning.effort) {
      if (folded) body.reasoning.effort = folded
      else delete body.reasoning.effort
      changed = true
    }
  }
  return changed
}

// 模型是否只认标记式图片。DeepSeek 系全系如此（含 deepseek-v4-flash 这种
// 带版本后缀的 id）。
export function prefersTagFormat(model) {
  return /deepseek/i.test(String(model ?? ""))
}

function toTag(part) {
  const kind = String(part?.type ?? "").trim().toLowerCase()
  if (kind !== "image_url" && kind !== "input_image") return null
  const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
  if (typeof url !== "string" || !url.startsWith("data:")) return null
  return `<image_base64>${url}</image_base64>`
}

// data URI 图片 → 标记文本。返回转换的张数。
export function rewriteImagesToTags(body) {
  let converted = 0
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (!Array.isArray(message?.content)) continue
    // 从后往前改，插入/删除不会打乱尚未处理的索引
    for (let i = message.content.length - 1; i >= 0; i--) {
      const tag = toTag(message.content[i])
      if (!tag) continue
      message.content.splice(i, 1)
      const prev = i > 0 && message.content[i - 1]?.type === "text" ? message.content[i - 1] : null
      const next = message.content[i]?.type === "text" ? message.content[i] : null
      if (prev) prev.text = `${prev.text ?? ""}\n${tag}`
      else if (next) next.text = `${tag}\n${next.text ?? ""}`
      else message.content.splice(i, 0, { type: "text", text: tag })
      converted++
    }
  }
  return converted
}

// 一次请求的完整改写。profile 是 lib/models.mjs 记下的模型能力
// （{ reasoning, vision }），未知模型时不删任何东西。
export function adaptBody(body, profile) {
  const notes = {}
  if (profile && profile.reasoning === false) {
    // 不推理的模型收到 reasoning_effort 只会招来上游的拒绝
    if ("reasoning_effort" in body) {
      delete body.reasoning_effort
      notes.droppedEffort = true
    }
    if (body.reasoning?.effort !== undefined) {
      delete body.reasoning.effort
      notes.droppedEffort = true
    }
  } else {
    notes.foldedEffort = foldReasoning(body)
  }
  const tagImages = profile?.tagImages ?? prefersTagFormat(body.model)
  if (tagImages) {
    const n = rewriteImagesToTags(body)
    if (n > 0) notes.imaged = n
  }
  return notes
}
