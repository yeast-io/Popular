import type { Locale } from '@movie-hub/contract';

export const tvShowMessages = (locale: Locale) => locale === 'zh-CN'
  ? {
      invalidSearch: '请输入不超过100个字符的搜索词，并使用有效页码。',
      unavailable: '电视剧资料暂时无法加载，请稍后重试。',
      busy: '电视剧资料正在更新，请稍后重试。',
      snapshot: '此电视剧列表已过期，请刷新列表。',
      notFound: '未找到该电视剧或季。',
    }
  : {
      invalidSearch: 'Enter a search term of up to 100 characters and a valid page number.',
      unavailable: 'TV information is unavailable. Please try again.',
      busy: 'TV information is being updated. Please try again.',
      snapshot: 'This TV list has expired. Please refresh the list.',
      notFound: 'This TV show or season was not found.',
    };
