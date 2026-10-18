// 一次性新手任务（新手福利）。
//
// 8 个 key 来自客户端自己的任务注册表，合计 10000 积分：
//   初识 Loomy: first_message 500 / pick_skill 1000 / generate_ppt 1500
//   打造你的专属 Loomy: set_schedule 1000 / install_skill 1500 / configure_remote 1000
//   遇见你的 AI 搭子: create_soul 1500 / share_soul 2000
//
// 上报只是 { key }，不带行为证明；「完成」由客户端本地判定。上游按 key 幂等
// （重复上报回 alreadyCompleted=true），未登记的 key 会被拒。
//
// 这是**一次性福利**，不是每日任务 —— 不放进定时签到（参照实现的侦察笔记也
// 这么定）。插件把它做成一个默认关闭的开关：打开后签到会补领一次，领完结算
// （onboardingSettled=true）后永不再扫。

export const ONBOARDING_TASKS = [
  { group: "初识 Loomy", key: "first_message", title: "发送你的第一条消息", points: 500 },
  { group: "初识 Loomy", key: "pick_skill", title: "试试选择一个技能", points: 1000 },
  { group: "初识 Loomy", key: "generate_ppt", title: "生成第一份 PPT", points: 1500 },
  { group: "打造你的专属 Loomy", key: "set_schedule", title: "设置定时任务", points: 1000 },
  { group: "打造你的专属 Loomy", key: "install_skill", title: "在技能广场安装一个技能", points: 1500 },
  { group: "打造你的专属 Loomy", key: "configure_remote", title: "配置远程控制", points: 1000 },
  { group: "遇见你的 AI 搭子", key: "create_soul", title: "创建你的第一个搭子", points: 1500 },
  { group: "遇见你的 AI 搭子", key: "share_soul", title: "把搭子分享给朋友", points: 2000 },
]

export const ONBOARDING_TOTAL = ONBOARDING_TASKS.reduce((sum, t) => sum + t.points, 0)

// 账号上一次扫描的结算标记字段名。放在账号记录里而不是单独的文件：
// magpie 的 client.auth.set 会把整条记录写回 plugin-auth.json。
export const SETTLED_FIELD = "onboardingSettled"

export const settledOf = (auth) => auth?.[SETTLED_FIELD] === true

// 每日赠送额度的学习字段。签到接口是唯一会回 `dailyQuota` 的地方（只读的
// points/records 不回），所以签到成功时把它记到账号上，用量页读这里。
export const DAILY_QUOTA_FIELD = "dailyQuota"

export const dailyQuotaOf = (auth) => {
  const n = auth?.[DAILY_QUOTA_FIELD]
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined
}
