// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ResourceReleaseFilter from './ResourceReleaseFilter.vue';
import { resourceReleaseTags } from './resource-release-tags.presentation';
import { setLocale } from '../../i18n';

const releases = [
  { id: '1', title: 'Film 2160p DoVi', resolution: '2160p', releaseGroup: 'GroupA', tags: ['中字', 'chinese-subtitles'] },
  { id: '2', title: 'Film 1080p', resolution: '1080p', releaseGroup: 'GroupA', tags: ['中字'] },
  { id: '3', title: 'Film 4K', resolution: '4K', releaseGroup: 'GroupB', tags: [] },
];

describe('resource tag filtering', () => {
  it('extracts structured metadata and title hints, normalizing aliases without duplicate tags', () => {
    expect(resourceReleaseTags(releases[0]!)).toEqual(['4K', 'GroupA', 'chinese-subtitles', 'DoVi']);
    expect(resourceReleaseTags({ id: '4', title: 'Film.2160p.Dolby.Vision.HDR10+', description: '中英字幕', medium: 'WEB-DL', videoCodec: 'H.265', audioCodec: 'Atmos' }))
      .toEqual(['4K', 'WEB-DL', 'H.265', 'Atmos', 'DoVi', 'HDR10+', 'chinese-subtitles']);
    expect(resourceReleaseTags({ id: '5', title: 'Film' })).toEqual([]);
  });

  it.each(['en-US', 'zh-CN'] as const)('starts unselected and combines tags with AND in %s', async (locale) => {
    setLocale(locale);
    const wrapper = mount(ResourceReleaseFilter, {
      props: { releases },
      slots: { default: ({ releases: visible }) => visible.map((release: { id: string }) => release.id).join(',') },
    });
    const button = (label: string) => wrapper.findAll('button').find((item) => item.text() === label)!;
    expect(wrapper.findAll('[aria-pressed="true"]')).toHaveLength(0);
    expect(wrapper.text()).toContain('1,2,3');
    const subtitle = locale === 'en-US' ? 'Chinese subtitles' : '中字';
    expect(wrapper.findAll('button').filter((item) => item.text() === subtitle)).toHaveLength(1);
    await button('4K').trigger('click');
    expect(wrapper.text()).toContain('1,3');
    await button(subtitle).trigger('click');
    expect(wrapper.text()).toContain('1 / 3');
    expect(wrapper.text()).not.toContain('1,3');
    await button('GroupB').trigger('click');
    expect(wrapper.text()).toContain(locale === 'en-US' ? 'No resources match all selected tags.' : '没有同时满足所选标签的资源。');
    await button('GroupB').trigger('click');
    await button('4K').trigger('click');
    await button(subtitle).trigger('click');
    expect(wrapper.text()).toContain('1,2,3');
    wrapper.unmount();
  });

  it('filters appended results and clears unavailable selections after refresh', async () => {
    setLocale('en-US');
    const wrapper = mount(ResourceReleaseFilter, { props: { releases } });
    await wrapper.findAll('button').find((item) => item.text() === 'DoVi')!.trigger('click');
    await wrapper.setProps({ releases: [...releases, { id: '4', title: 'Film DV', tags: [] }] });
    expect(wrapper.text()).toContain('2 / 4');
    await wrapper.setProps({ releases: [releases[2]!] });
    expect(wrapper.findAll('[aria-pressed="true"]')).toHaveLength(0);
    expect(wrapper.find('.release-filter-count').exists()).toBe(false);
    wrapper.unmount();
  });
});
