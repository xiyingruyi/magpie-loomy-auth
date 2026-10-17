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
// 字节与字符串都认（peekFirst 走字节，sseRecords 走已解码的字符串）：
// 分隔符都是 ASCII，两种表示下位置一致。
const NL = 0x0a
const CR = 0x0d
const code = (buf, i) => (typeof buf === "string" ? buf.charCodeAt(i) : buf[i])
function boundary(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (code(buf, i) !== NL) continue
    if (i + 1 < buf.length && code(buf, i + 1) === NL) return { at: i, len: 2 }
    if (i >= 1 && code(buf, i - 1) === CR && i + 2 < buf.length && code(buf, i + 1) === CR && code(buf, i + 2) === NL) {
      return { at: i - 1, len: 4 }
    }
  }
  return null
}

const concat = (a, b) => {
  if (!a.length) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

// 读第一条记录。返回 { record, raw, rest, ended }：
//   record  解析后的 {event, data}，没有内容时 null
//   raw     首条的原始文本（含结尾分隔符），用于原样回放
//   rest    首条之后的字节流（一个新的 ReadableStream，从 tail 起续接原流）
//
// 全程按字节处理：早先的写法把每个 chunk 解码进同一个字符串再按字符串切，
// 当一次读取正好结束在多字节字符中间时，TextDecoder 会把半截字符留在自己的
// 缓冲里，切完首条后那个 decoder 就被丢掉了 —— 下一次读取的续字节单独解码成
// U+FFFD，中文回复里出现「�」。字节切分不会丢任何字节。
export async function peekFirst(stream) {
  if (!stream) return { record: null, raw: "", rest: stream, ended: true }
  const reader = stream.getReader()
  let buf = new Uint8Array(0)
  let ended = false
  let cut = null
  while ((cut = boundary(buf)) === null) {
    const r = await reader.read()
    if (r.done) {
      ended = true
      break
    }
    buf = concat(buf, r.value)
  }
  let raw = ""
  let record = null
  let tail = buf
  if (cut) {
    raw = new TextDecoder().decode(buf.subarray(0, cut.at + cut.len))
    record = parseRecord(new TextDecoder().decode(buf.subarray(0, cut.at)))
    tail = buf.subarray(cut.at + cut.len)
  } else if (ended) {
    // 没有结尾空行的最后一条；流在这里结束，截断的多字节字符按替换符显示
    const text = new TextDecoder().decode(buf)
    if (text.trim()) {
      raw = text
      record = parseRecord(text)
      tail = new Uint8Array(0)
    }
  }
  let done = ended
  const rest = new ReadableStream({
    start(controller) {
      if (tail.length) controller.enqueue(tail)
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
