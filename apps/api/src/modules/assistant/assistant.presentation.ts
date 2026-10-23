import { remoteDownloadMessages } from '../remote-downloads/remote-download.messages.js';
import type { MessageKey } from './assistant.types.js';
import type { DownloaderChoice, Locale, MovieDownload, MovieDownloadStatus } from '@movie-hub/contract';

export const messages = {
  'zh-CN': {
    noRetry: '没有可重试的已选下载，请先选择资源。',
    cancelled: '已取消本次下载选择流程；已提交的下载任务不会被取消。',
    clarify: '请说明要执行的下载操作；如果要选择资源，请提供资源编号。',
    selectRelease: '请选择要下载的资源编号，例如“下载第 2 个”；也可查看详情、翻页或筛选。',
    selectMovie: '请先选择电影，再从资源列表选择版本。',
    expired: '资源列表无效或已过期，请重新查询或发送“刷新资源”，再选择版本。',
    invalidIndex: '资源编号无效，请从当前列表的 1–{count} 中选择。',
    unsupportedSource: '该资源来源暂不支持下载，请选择 M-Team 资源。',
    selectFirst: '请先选择要下载的资源编号。',
    failed: '下载提交未能确认成功（{code}）。不会自动换下载器。可回复“重试”；若已创建任务，重试会先尝试恢复原任务。',
    noProvider: '尚未配置下载器，请先在网页配置 qBittorrent 或 Transmission，然后回复要使用的下载器名称。',
    providers: '已选资源：{title}\n请选择下载器：\n{providers}',
    submitted: '下载任务：{id}\n下载器：{provider}\n状态：{status}\n进度：{progress}%',
    recommendationFailed: '本次电影推荐查询未完成，请稍后重试。我没有确认到符合条件的推荐结果。',
    resourcesFailed: '本次资源查询未完成，暂时无法判断是否有可用资源，请稍后重试。',
    recommendUnavailable: '已识别为电影推荐请求。个性化推荐尚未接通，目前可以继续讨论电影或其他话题。',
    resourcesUnavailable: '已识别为电影资源查询请求。资源查询尚未接通，我目前无法查看真实资源或判断是否可下载。',
    downloadUnavailable: '已识别为下载相关请求。远程下载尚未接通，本次没有创建、修改或取消任何下载任务。',
    ambiguousTasks: '资源查询和电影推荐会话都有效。你想继续查资源，还是继续推荐电影？',
    unclear: '你希望我聊聊这个话题、推荐电影、查电影资源，还是处理下载？请补充一下具体需求。',
  },
  'en-US': {
    noRetry: 'There is no selected download to retry. Please select a release first.',
    cancelled: 'The pending download selection has been cancelled. Already submitted download tasks are unchanged.',
    clarify: 'Please clarify the download action; to choose a release, provide its number.',
    selectRelease:
      'Choose a release to download, for example “download release 2”. You can also view details, change pages or filter releases.',
    selectMovie: 'Please choose a film first, then select a release from its resource list.',
    expired: 'The resource list is missing or expired. Search again or say “refresh resources”, then select a release.',
    invalidIndex: 'Invalid release number. Choose from 1–{count} in the current list.',
    unsupportedSource: 'Downloads from this source are not supported yet. Please choose an M-Team release.',
    selectFirst: 'Please select a release number to download first.',
    failed:
      'Download submission could not be confirmed ({code}). I will not switch downloaders automatically. Reply “retry”; if a task was already created, retry will first attempt to recover it.',
    noProvider:
      'No downloader is configured. Configure qBittorrent or Transmission on the website, then reply with the downloader name.',
    providers: 'Selected release: {title}\nChoose a downloader:\n{providers}',
    submitted: 'Download task: {id}\nDownloader: {provider}\nStatus: {status}\nProgress: {progress}%',
    recommendationFailed:
      'The movie recommendation query did not complete. Please try again later. No matching recommendations have been confirmed.',
    resourcesFailed: 'The resource query did not complete. Resource availability is unknown; please try again later.',
    recommendUnavailable:
      'This is a movie recommendation request. Personalized recommendations are not connected yet; we can still discuss films or other topics.',
    resourcesUnavailable:
      'This is a movie resource query. Resource lookup is not connected yet; I cannot check actual releases or download availability.',
    downloadUnavailable:
      'This is a download request. Remote downloads are not connected yet. No download task was created, changed or cancelled.',
    ambiguousTasks:
      'Both a resource query and a movie recommendation session are active. Would you like to continue finding releases or getting recommendations?',
    unclear:
      'Would you like to discuss this, get movie recommendations, find releases or handle a download? Please clarify your request.',
  },
} satisfies Record<Locale, Record<string, string>>;
const statuses: Record<Locale, Record<MovieDownloadStatus, string>> = {
  'zh-CN': {
    submitting: '正在提交',
    downloading: '正在下载',
    paused: '已暂停',
    seeding: '做种中',
    completed: '已完成',
    failed: '失败',
    missing: '任务不存在',
  },
  'en-US': {
    submitting: 'Submitting',
    downloading: 'Downloading',
    paused: 'Paused',
    seeding: 'Seeding',
    completed: 'Completed',
    failed: 'Failed',
    missing: 'Missing',
  },
};
export function assistantText(locale: Locale, key: MessageKey, values: Record<string, string | number> = {}): string {
  return messages[locale][key].replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match));
}
export function downloadProvidersText(locale: Locale, title: string, providers: DownloaderChoice[]): string {
  if (!providers.length) return assistantText(locale, 'noProvider');
  return assistantText(locale, 'providers', {
    title: title.replace(/\p{Cc}/gu, ' ').slice(0, 300),
    providers: providers.map((provider, index) => `${index + 1}. ${provider.name} (${provider.provider})`).join('\n'),
  });
}
export function downloadSubmittedText(locale: Locale, result: MovieDownload): string {
  return assistantText(locale, 'submitted', {
    id: result.id,
    provider: result.downloaderName ?? result.provider ?? remoteDownloadMessages[locale].agent,
    status: statuses[locale][result.status],
    progress: result.progress,
  });
}
