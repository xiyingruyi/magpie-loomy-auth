import { test, expect } from "bun:test"
import { splitRateSuffix, runtimeModel, modelsFromCatalog, configModelsFrom } from "../lib/models.mjs"

test("the rate suffix is split off the display name", () => {
  expect(splitRateSuffix("DeepSeek V4 Flash 0731 (x3.0)")).toEqual({ name: "DeepSeek V4 Flash 0731", rate: "x3.0" })
  expect(splitRateSuffix("GLM 5.3 Flash(x0.8)")).toEqual({ name: "GLM 5.3 Flash", rate: "x0.8" })
  expect(splitRateSuffix("Spark X2.5 （x0.1）")).toEqual({ name: "Spark X2.5", rate: "x0.1" })
  expect(splitRateSuffix("Model (x1)")).toEqual({ name: "Model", rate: "x1" })
  // 不是倍率的括号原样保留
  expect(splitRateSuffix("限时免费")).toEqual({ name: "限时免费", rate: undefined })
  expect(splitRateSuffix("Model (free)")).toEqual({ name: "Model (free)", rate: undefined })
  expect(splitRateSuffix("")).toEqual({ name: "", rate: undefined })
})

test("a catalogue entry becomes a runtime model", () => {
  const m = runtimeModel({
    id: "spark-x",
    name: "Spark X2.5 (x0.1)",
    type: "chat",
    context_length: 128000,
    max_output_tokens: 8192,
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
    capabilities: { reasoning: true, function_calling: true, vision: false, output_modalities: ["text"] },
  }, "loomy")
  expect(m.id).toBe("spark-x")
  expect(m.name).toBe("Spark X2.5")
  expect(m.rate).toBe("x0.1")
  expect(m.limit).toEqual({ context: 128000, output: 8192 })
  expect(m.capabilities.reasoning).toBe(true)
  expect(m.capabilities.toolcall).toBe(true)
  expect(m.capabilities.input.image).toBe(false)
  expect(Object.keys(m.variants)).toEqual(["none", "low", "medium", "high", "xhigh"])
})

// 参考实现读的是旧字段名（context_window/max_tokens），真实上游已改成
// context_length/max_output_tokens。新名字优先，旧名字兼容回退。
test("the real field names win, the old ones still fall back", () => {
  const m = runtimeModel({ id: "a", context_length: 1000, context_window: 2000, max_output_tokens: 100, max_tokens: 200, capabilities: { reasoning: true } }, "loomy")
  expect(m.limit).toEqual({ context: 1000, output: 100 })
  const old = runtimeModel({ id: "b", context_window: 2000, max_tokens: 200, capabilities: {} }, "loomy")
  expect(old.limit).toEqual({ context: 2000, output: 200 })
})

// 核心回归：上游没给输出上限时必须是 0（「没说」），不能编一个数。
// magpie 把 limit.output 当硬上限下发 —— 编出来的数就是真实天花板。
test("a missing output limit stays 0, never a guess", () => {
  const m = runtimeModel({ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", capabilities: { reasoning: true, vision: true } }, "loomy")
  expect(m.limit.output).toBe(0)
  expect(m.limit.context).toBe(0)
  expect(m.capabilities.input.image).toBe(true)
})

test("a model without reasoning declares no variants", () => {
  const m = runtimeModel({ id: "glm-5.3-flash", name: "GLM", capabilities: { reasoning: false, vision: true } }, "loomy")
  expect(m.variants).toEqual({})
  expect(m.capabilities.reasoning).toBe(false)
})

// 生图模型不该出现在清单里：唯一入口是 images API，magpie 不替插件账号转发，
// chat 端点对它们一律 404（实测三个都是「该模型暂未开放」）。
test("an image-generation model is not offered at all", () => {
  const m = runtimeModel({
    id: "hy-image",
    type: "image",
    capabilities: { reasoning: false, vision: true, function_calling: false, input_modalities: ["text", "image"], output_modalities: ["image"] },
  }, "loomy")
  // 解析本身仍然如实（output 只有 image）
  expect(m.capabilities.output.image).toBe(true)
  expect(m.capabilities.output.text).toBe(false)
  expect(m.capabilities.toolcall).toBe(false)
  // 但清单里没有它
  const list = modelsFromCatalog([{ id: "hy-image", type: "image" }, { id: "text-model" }], "loomy")
  expect(Object.keys(list)).toEqual(["text-model"])
  // type=image 但没给 output_modalities 也按出图处理
  expect(modelsFromCatalog([{ id: "img2", type: "image", capabilities: { vision: true } }], "loomy")).toEqual({})
  // config 的扁平形状同理
  expect(configModelsFrom([{ id: "hy-image", type: "image" }, { id: "text-model", name: "T" }])).toHaveProperty(["text-model"])
})

// 实测：上游的 `auto`（自动 · 均衡）条目连 capabilities 都没有，它会路由到
// 一个支持工具的模型（真发一次 tool_choice=required 拿到了 tool_calls）。
// 把「没说」当成「不支持」会让用户一选自动模型就用不了工具。
test("a model that says nothing about tools keeps them", () => {
  const auto = runtimeModel({ id: "auto", name: "自动 · 均衡", type: "chat" }, "loomy")
  expect(auto.capabilities.toolcall).toBe(true)
  // 明确说不支持的才关掉
  const noTools = runtimeModel({ id: "x", capabilities: { function_calling: false } }, "loomy")
  expect(noTools.capabilities.toolcall).toBe(false)
  // 生图模型永远不支持
  expect(runtimeModel({ id: "img", type: "image" }, "loomy").capabilities.toolcall).toBe(false)
})

// 上游的 input_modalities 会带 video（实测 Kimi-k2.6），硬编码 false 会漏。
test("every modality the upstream names is mapped, not just images", () => {
  const m = runtimeModel({ id: "kimi", capabilities: { reasoning: true, vision: true, input_modalities: ["text", "image", "video"], output_modalities: ["text"] } }, "loomy")
  expect(m.capabilities.input.video).toBe(true)
  expect(m.capabilities.input.image).toBe(true)
  expect(m.capabilities.input.audio).toBe(false)
  const cfg = configModelsFrom([{ id: "kimi", name: "K", capabilities: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] } }])
  expect(cfg.kimi.modalities.input).toEqual(["text", "image", "video"])
})

test("entries without an id are dropped", () => {
  const out = modelsFromCatalog([{ name: "x" }, { id: "ok" }, null], "loomy")
  expect(Object.keys(out)).toEqual(["ok"])
})

test("the flat config shape carries limits only when they are known", () => {
  const out = configModelsFrom([
    { id: "a", name: "A", context_length: 1000, max_output_tokens: 100, capabilities: { output_modalities: ["text"] } },
    { id: "b", name: "B" },
  ])
  expect(out.a.limit).toEqual({ context: 1000, output: 100 })
  // 未给上限：不写 limit，既不是 0 也不是猜的值
  expect(out.b.limit).toBeUndefined()
  expect(out.b.modalities.input).toEqual(["text"])
})
