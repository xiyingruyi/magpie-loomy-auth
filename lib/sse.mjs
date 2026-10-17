// SSE 的阅读工具。
//
// 三件事：
//   1. peekFirst：读第一条记录但不丢字节 —— 上游会把错误塞进 SSE 或 200 的
//      JSON 里，必须先看一眼首条才知道这次请求是不是真的开始了；确认正常后
//      再把首条的原始字节原样放回去。
//   2. sseRecords：把字节流切成 {event, data} 记录（直通时用不到，测试和
//      非流式重组时用）。
//   3. 每条流各持一个 TextDecoder —— 共享会让并发流里的多字节字符互相污染。

const encoder = new TextEncoder()

// 解析一条原始记录文本（不含结尾空行）。
export function parseRecord(raw) {
  let event = ""
  const data = []
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue
    const at = line.indexOf(":")
    const field = at < 0 ? line : line.slice(0, at)
    let value = at < 0 ? "" : line.slice(at + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") event = value
    else if (field === "data") data.push(value)
  }
  if (!event && data.length === 0) return null
  return { event, data: data.join("\n") }
}

// 找第一条记录的边界（\n\n 或 \r\n\r\n），返回 { at, len } 或 null。
function boundary(s) {
  const a = s.indexOf("\n\n")
  const b = s.indexOf("\r\n\r\n")
  if (a < 0 && b < 0) return null
  if (a < 0) return { at: b, len: 4 }
  if (b < 0 || a < b) return { at: a, len: 2 }
  return { at: b, len: 4 }
}

// 读第一条记录。返回 { record, raw, rest, ended }：
//   record  解析后的 {event, data}，没有内容时 null
//   raw     首条的原始文本（含结尾分隔符），用于原样回放
//   rest    首条之后的字节流（一个新的 ReadableStream，从 tail 起续接原流）
export async function peekFirst(stream) {
  if (!stream) return { record: null, raw: "", rest: stream, ended: true }
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let ended = false
  let cut = null
  while ((cut = boundary(buf)) === null) {
    const r = await reader.read()
    if (r.done) {
      ended = true
      break
    }
    buf += decoder.decode(r.value, { stream: true })
  }
  let raw = ""
  let record = null
  let tail = buf
  if (cut) {
    raw = buf.slice(0, cut.at + cut.len)
    record = parseRecord(buf.slice(0, cut.at))
    tail = buf.slice(cut.at + cut.len)
  } else if (buf.trim()) {
    // 没有结尾空行的最后一条
    raw = buf
    record = parseRecord(buf)
    tail = ""
  }
  // 流已结束时把 decoder 里残留的半截多字节字符吐出来（正常不会发生，
  // 但截断的响应不该被静默丢弃）
  if (ended) tail += decoder.decode()
  let done = ended
  const rest = new ReadableStream({
    start(controller) {
      if (tail) controller.enqueue(encoder.encode(tail))
    },
    async pull(controller) {
      if (done) {
        controller.close()
        return
      }
      try {
        const r = await reader.read()
        if (r.done) {
          done = true
          controller.close()
        } else controller.enqueue(r.value)
      } catch (e) {
        controller.error(e)
      }
    },
    cancel(reason) {
      done = true
      return reader.cancel(reason)
    },
  })
  // ended 表示原流在首条之后是否已经结束（tail 仍可能非空）
  return { record, raw, rest, ended: done }
}

// 把回放的原始文本接到 rest 前面，得到一个等价于原响应的流。
export function withPrefix(raw, rest) {
  if (!raw) return rest
  const reader = rest ? rest.getReader() : null
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(raw))
    },
    async pull(controller) {
      if (!reader) {
        controller.close()
        return
      }
      try {
        const r = await reader.read()
        if (r.done) controller.close()
        else controller.enqueue(r.value)
      } catch (e) {
        controller.error(e)
      }
    },
    cancel(reason) {
      return reader?.cancel(reason)
    },
  })
}

// 把字节流切成记录。测试与非流式重组用；直通路径不经过它。
export async function* sseRecords(body) {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let ended = false
  while (!ended) {
    const r = await reader.read()
    if (r.done) ended = true
    else buf += decoder.decode(r.value, { stream: true })
    let cut
    while ((cut = boundary(buf)) !== null) {
      const rec = parseRecord(buf.slice(0, cut.at))
      buf = buf.slice(cut.at + cut.len)
      if (rec) yield rec
    }
  }
  buf += decoder.decode()
  if (buf.trim()) {
    const rec = parseRecord(buf)
    if (rec) yield rec
  }
}
