// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { expect, it } from 'vitest';
import { setLocale } from '../../i18n';
import TvShowCard from './TvShowCard.vue';

it.each(['en-US', 'zh-CN'] as const)('shows the first air date and rating under the TV poster (%s)', async (locale) => {
  setLocale(locale);
  const wrapper = mount(TvShowCard, { props: { show: { mediaType: 'tv', tmdbId: 42, name: 'Series', firstAirDate: '2021-04-30', voteAverage: 8.25 } } });
  expect(wrapper.get('time').attributes('datetime')).toBe('2021-04-30');
  expect(wrapper.get('time').text()).toBe(locale === 'zh-CN' ? '2021年4月30日' : 'Apr 30, 2021');
  expect(wrapper.get('.rating').text()).toBe('★ 8.3');
  expect(wrapper.get('.rating').attributes('aria-label')).toContain('8.3');
  await wrapper.get('.tv-show-card').trigger('click');
  expect(wrapper.emitted('open')).toEqual([[42]]);
  wrapper.unmount();
});
it('keeps missing dates and unrated shows explicit', () => {
  setLocale('en-US');
  const wrapper = mount(TvShowCard, { props: { show: { mediaType: 'tv', tmdbId: 42, name: 'Series', voteAverage: 0 } } });
  expect(wrapper.get('.movie-meta').text()).toContain('Unknown');
  expect(wrapper.get('.rating').text()).toBe('—');
  wrapper.unmount();
});
