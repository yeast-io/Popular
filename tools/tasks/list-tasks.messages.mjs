export const messages = {
  'zh-CN': {
    help: '用法：pnpm tasks:stats [--date=YYYY-MM-DD] [--locale=zh-CN|en-US] [--json]\n默认查看今天（UTC）的累计执行次数。',
    empty: '暂无任务统计', poll: '轮询', job: '任务', started: '执行', success: '成功', failure: '失败', cancelled: '取消', running: '运行中约',
    note: '日期按 UTC；运行中为近 5 分钟启动且未结束的执行，异常退出会暂时残留。统计保留 8 天，缓存故障可能漏计。成功指执行完成，不等同于通知送达。',
    error: '读取任务统计失败，请检查参数及 Redis 连接配置。',
    names: { 'resource-notifications': '资源提醒', 'download-notifications': '下载通知', 'remote-downloads': '远程下载', 'remote-client-maintenance': '客户端维护', 'external-usage-aggregation': '用量汇总', 'preferences': '偏好更新', 'assistant': 'AI 助手' },
  },
  'en-US': {
    help: 'Usage: pnpm tasks:stats [--date=YYYY-MM-DD] [--locale=zh-CN|en-US] [--json]\nDefaults to today (UTC).',
    empty: 'No task statistics yet', poll: 'polls', job: 'jobs', started: 'runs', success: 'success', failure: 'failed', cancelled: 'cancelled', running: 'approx. running',
    note: 'UTC dates; running means started within five minutes and unfinished, including recent crashed executions. Eight-day retention; cache outages may lose counts. Success means execution completed, not notification delivery.',
    error: 'Unable to read task statistics. Check arguments and Redis connection settings.',
    names: { 'resource-notifications': 'Resource notifications', 'download-notifications': 'Download notifications', 'remote-downloads': 'Remote downloads', 'remote-client-maintenance': 'Client maintenance', 'external-usage-aggregation': 'Usage aggregation', 'preferences': 'Preferences', 'assistant': 'AI assistant' },
  },
};
