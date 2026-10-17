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
    capabilities: { reasoning: true, function_calling: true, vision: false },
    context_window: 128000,
    max_tokens: 8192,
  }, "loomy")
  expect(m.id).toBe("spark-x")
  expect(m.name).toBe("Spark X2.5")
  expect(m.rate).toBe("x0.1")
  expect(m.limit).toEqual({ context: 128000, output: 8192 })
  expect(m.capabilities.reasoning).toBe(true)
  expect(m.capabilities.toolcall).toBe(true)
  expect(m.capabilities.input.image).toBe(false)
  expect(Object.keys(m.variants)).toEqual(["low", "medium", "high"])
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

test("entries without an id are dropped", () => {
  const out = modelsFromCatalog([{ name: "x" }, { id: "ok" }, null], "loomy")
  expect(Object.keys(out)).toEqual(["ok"])
})

test("the flat config shape carries limits only when they are known", () => {
  const out = configModelsFrom([
    { id: "a", name: "A", context_window: 1000, max_tokens: 100 },
    { id: "b", name: "B" },
  ])
  expect(out.a.limit).toEqual({ context: 1000, output: 100 })
  // 未给上限：不写 limit，既不是 0 也不是猜的值
  expect(out.b.limit).toBeUndefined()
  expect(out.b.modalities.input).toEqual(["text"])
})
