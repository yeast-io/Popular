import type { Locale } from '@movie-hub/contract';

function restrictionLabels(restrictions: string[], separator: string): string {
  return restrictions
    .map((value) => {
      return value.trim().replace(/[。.!！?？;；、,，\s]+$/gu, '');
    })
    .filter(Boolean)
    .join(separator);
}

const messages = {
  'zh-CN': {
    unverifiableRestrictions: (restrictions: string[]) => {
      return `目前的电影资料无法可靠核实这些硬性限制：${restrictionLabels(restrictions, '、')}。本次不返回未经核实的推荐。`;
    },
    noCandidates: '本次没有找到符合条件、且尚未标记已看或不喜欢的电影。可以放宽条件后再试。',
    insufficientEvidence: '没有足够证据支持符合本次限制的推荐，可以调整条件后再试。',
  },
  'en-US': {
    unverifiableRestrictions: (restrictions: string[]) => {
      return `The available movie data cannot reliably verify these strict requirements: ${restrictionLabels(
        restrictions,
        ', '
      )}. No unverified recommendations will be returned.`;
    },
    noCandidates:
      'No movies matched your criteria after excluding movies marked as watched or disliked. Try relaxing your criteria.',
    insufficientEvidence:
      'There is not enough evidence to recommend movies that meet these requirements. Try adjusting your criteria.',
  },
} as const;

export function recommendationMessages(locale: Locale) {
  return messages[locale];
}
