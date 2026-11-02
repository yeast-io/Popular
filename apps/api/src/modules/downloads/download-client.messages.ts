import type { DownloadProvider, Locale } from '@movie-hub/contract';

export const downloadClientMessages: Record<Locale, {
  instanceRequired: string;
  notConfigured: Record<DownloadProvider, string>;
  accessFailed: Record<DownloadProvider, string>;
}> = {
  'en-US': {
    instanceRequired: 'Historical download has no pinned downloader instance',
    notConfigured: {
      qbittorrent: 'Configure qBittorrent before downloading',
      transmission: 'Configure Transmission before downloading',
    },
    accessFailed: {
      qbittorrent: 'Could not access the qBittorrent download',
      transmission: 'Could not access the Transmission download',
    },
  },
  'zh-CN': {
    instanceRequired: '历史下载任务未绑定具体的下载器实例',
    notConfigured: {
      qbittorrent: '请先配置 qBittorrent 再下载',
      transmission: '请先配置 Transmission 再下载',
    },
    accessFailed: {
      qbittorrent: '无法访问 qBittorrent 下载任务',
      transmission: '无法访问 Transmission 下载任务',
    },
  },
};
