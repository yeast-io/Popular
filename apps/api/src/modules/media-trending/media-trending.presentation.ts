import type { Locale } from '@movie-hub/contract';

export const mediaTrendingMessages = (locale: Locale) => locale === 'zh-CN'
  ? {
      expired: '此热门列表已过期，请重新加载首页。',
      busy: '热门列表正在更新，请稍后重试。',
      unavailable: '热门列表暂时无法加载，请稍后重试。',
      noMore: '没有更多热门内容。',
    }
  : {
      expired: 'This trending list has expired. Reload the first page.',
      busy: 'The trending list is being updated. Please retry shortly.',
      unavailable: 'The trending list is unavailable. Please try again.',
      noMore: 'There are no more trending items.',
    };
