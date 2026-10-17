// 讯飞 Loomy 的固定事实：三处域名、客户端内置凭据、业务码。
//
// 全部可用环境变量覆盖 —— 上游常量易变，测试与镜像都靠这一点把请求钉在本地
// fake 上（变量名与参照实现 agent2api 一致，便于对照）。

const str = (name, fallback) => {
  const v = process.env[name]?.trim()
  return v ? v.replace(/\/+$/, "") : fallback
}

export const ID = "loomy"
export const NAME = "Loomy（讯飞）"

// 积分/模型/签到网关
export const POINTS_BASE = () => str("LOOMY_POINTS_BASE_URL", "https://loomyad.xunfei.cn")
// 账号域（短信登录），请求要带 HMAC-SHA1 签名
export const ACCOUNT_BASE = () => str("LOOMY_XFYUN_BASE_URL", "https://account.xfinfr.com")

// 客户端安装包里内置的一对常量（不是用户凭据），登录链路靠它复刻客户端签名
export const ACCESS_KEY_ID = () => str("LOOMY_XFYUN_ACCESS_KEY_ID", "2thryby66wxi53sk")
export const ACCESS_KEY_SECRET = () => str("LOOMY_XFYUN_ACCESS_KEY_SECRET", "zsak6eadrbawz683wf5r3m2snrwj868r")
export const APP_ID = () => str("LOOMY_XFYUN_APP_ID", "GM3LOOMY")

export const MODEL_BASE = () => `${POINTS_BASE()}/api/v1`

// 业务码：000000 成功；020002/100002 登录态失效。注意上游对这两类
// **一律回 HTTP 200**（实测），所以只能靠 code 判断，不能看状态码。
export const OK = "000000"
export const AUTH_CODES = new Set(["020002", "100002"])

// 会话有效期：客户端 checkCode 时申请 14 天。
export const SESSION_DAYS = 14

export const NPM = "@ai-sdk/openai-compatible"
export const REQUEST_TIMEOUT = 20_000

// 未登录时的兜底模型表：只为让 provider 在登录前就可见。
// 模型清单登录后来自上游 /api/v1/models，这里的条目只起占位作用。
export const FALLBACK_MODELS = {
  "spark-x": configModel({ name: "Spark X2.5", reasoning: true }),
  "deepseek-v4-flash": configModel({ name: "DeepSeek V4 Flash", reasoning: true, image: true }),
  "glm-5.3-flash": configModel({ name: "GLM 5.3 Flash", image: true }),
}

// 输出上限：上游模型清单里的 max_tokens 有就沿用，没有就不写（0）。
// 这一点和华为 codearts 那个 bug 同源：magpie 把 limit.output 当作**硬上限**
// 下发，自己编一个数字就等于造出一个真实的天花板；0 是「没说」，magpie 会
// 落到 models.dev（provider.replyLimit）。
export const DEFAULT_OUTPUT = 0
export const DEFAULT_CONTEXT = 0

// config 钩子里的扁平模型形状（OpenCode 的写法）。
export function configModel({ name, context, output, reasoning, image }) {
  const input = ["text"]
  if (image) input.push("image")
  const limit = {}
  if (Number.isFinite(context) && context > 0) limit.context = context
  if (Number.isFinite(output) && output > 0) limit.output = output
  return {
    name,
    ...(Object.keys(limit).length ? { limit } : {}),
    reasoning: !!reasoning,
    tool_call: true,
    modalities: { input, output: ["text"] },
  }
}
