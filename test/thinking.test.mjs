import { test, expect } from "bun:test"
import { foldReasoning, prefersTagFormat, rewriteImagesToTags, adaptBody } from "../lib/thinking.mjs"

test("reasoning efforts fold into the three levels the upstream knows", () => {
  const body = (effort) => ({ model: "m", reasoning_effort: effort })
  const wire = (effort) => {
    const b = body(effort)
    foldReasoning(b)
    return b.reasoning_effort
  }
  expect(wire("minimal")).toBe("low")
  expect(wire("low")).toBe("low")
  expect(wire("medium")).toBe("medium")
  expect(wire("high")).toBe("high")
  expect(wire("xhigh")).toBe("high")
  expect(wire("max")).toBe("high")
  expect(wire("ultra")).toBe("high")
  // 关不掉的档位直接删字段，而不是发一个上游不认识的值
  expect(wire("none")).toBeUndefined()
  expect(wire("off")).toBeUndefined()
  expect(wire("bogus")).toBeUndefined()
})

test("the nested reasoning.effort shape folds too", () => {
  const b = { reasoning: { effort: "minimal" } }
  foldReasoning(b)
  expect(b.reasoning.effort).toBe("low")
  const c = { reasoning: { effort: "none" } }
  foldReasoning(c)
  expect("effort" in c.reasoning).toBe(false)
  // 别的字段不受影响
  const d = { reasoning: { effort: "minimal", summary: "auto" } }
  foldReasoning(d)
  expect(d.reasoning.summary).toBe("auto")
})

test("nothing else in the body is touched", () => {
  const b = { model: "x", temperature: 0.2, reasoning_effort: "max", messages: [{ role: "user", content: "hi" }] }
  foldReasoning(b)
  expect(b.temperature).toBe(0.2)
  expect(b.messages).toEqual([{ role: "user", content: "hi" }])
  expect(b.reasoning_effort).toBe("high")
})

test("deepseek models read images as markers", () => {
  expect(prefersTagFormat("deepseek-v4-flash")).toBe(true)
  expect(prefersTagFormat("DeepSeek-V4.1-Flash")).toBe(true)
  expect(prefersTagFormat("deepseek-r1")).toBe(true)
  expect(prefersTagFormat("glm-5.3-flash")).toBe(false)
  expect(prefersTagFormat("spark-x")).toBe(false)
  expect(prefersTagFormat(undefined)).toBe(false)
})

test("a data-URI image merges into the text before it", () => {
  const b = {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "看这张图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
        { type: "image_url", image_url: { url: "https://example.com/x.png" } },
      ],
    }],
  }
  const n = rewriteImagesToTags(b)
  expect(n).toBe(1)
  const content = b.messages[0].content
  expect(content).toHaveLength(2)
  expect(content[0].text).toBe("看这张图\n<image_base64>data:image/png;base64,QUJD</image_base64>")
  // http(s) URL 保持原样：没有证据表明标记接受 URL
  expect(content[1].type).toBe("image_url")
})

test("an image with no text near it becomes its own text block", () => {
  const b = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] }
  rewriteImagesToTags(b)
  expect(b.messages[0].content).toEqual([{ type: "text", text: "<image_base64>data:image/png;base64,AA</image_base64>" }])
})

test("the string image_url form and input_image are accepted", () => {
  const b = {
    messages: [{ role: "user", content: [{ type: "text", text: "x" }, { type: "image_url", image_url: "data:image/jpeg;base64,QQ" }, { type: "input_image", image_url: { url: "data:image/png;base64,Qg" } }] }],
  }
  expect(rewriteImagesToTags(b)).toBe(2)
  // 顺序保持：文本 → QQ → Qg
  const text = b.messages[0].content.map((p) => p.text).join("\n")
  expect(text.indexOf("QQ")).toBeLessThan(text.indexOf("Qg"))
  expect(b.messages[0].content.every((p) => p.type === "text")).toBe(true)
})

test("string content and other parts are left alone", () => {
  const b = { messages: [{ role: "user", content: "纯文本" }, { role: "user", content: [{ type: "text", text: "x" }] }] }
  expect(rewriteImagesToTags(b)).toBe(0)
  expect(b.messages[0].content).toBe("纯文本")
})

test("adaptBody drops the effort for a model that does not reason", () => {
  const b = { model: "glm-5.3-flash", reasoning_effort: "high", messages: [] }
  adaptBody(b, { reasoning: false })
  expect("reasoning_effort" in b).toBe(false)
})

test("adaptBody keeps and folds the effort for a reasoning model", () => {
  const b = { model: "spark-x", reasoning_effort: "max", messages: [] }
  adaptBody(b, { reasoning: true })
  expect(b.reasoning_effort).toBe("high")
})

test("adaptBody uses the model's image preference when known", () => {
  const b = { model: "spark-x", messages: [{ role: "user", content: [{ type: "text", text: "t" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] }
  // 已知模型不吃标记：保持 OpenAI 形状
  adaptBody(b, { reasoning: false, tagImages: false })
  expect(b.messages[0].content).toHaveLength(2)
  // 未知模型按 id 推断（spark 不是 deepseek → 不改）
  const c = { model: "spark-x", messages: [{ role: "user", content: [{ type: "text", text: "t" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] }
  adaptBody(c, undefined)
  expect(c.messages[0].content).toHaveLength(2)
  // deepseek 按 id 推断也生效
  const d = { model: "deepseek-v4-flash", messages: [{ role: "user", content: [{ type: "text", text: "t" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] }
  adaptBody(d, undefined)
  expect(d.messages[0].content).toHaveLength(1)
})
