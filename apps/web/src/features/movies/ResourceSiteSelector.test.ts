// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import ResourceSiteSelector from './ResourceSiteSelector.vue';

afterEach(() => { vi.unstubAllGlobals(); });

it.each(['en-US', 'zh-CN'] as const)('keeps status in tooltips and blocks unconfigured sites in %s', async (locale) => {
  setLocale(locale);
  vi.stubGlobal('fetch', vi.fn(async () => {
    return Response.json({
      defaults: { resource: 'mteam' }, selectedSites: ['mteam'], effectiveSites: ['mteam'],
      choices: [
        { id: 'mteam', name: 'M-Team', category: 'resource', status: 'configured_valid' },
        { id: 'hdarea', name: 'HDArea', category: 'resource', status: 'unconfigured' },
      ],
    }
    );
  })
  );
  const wrapper = mount(ResourceSiteSelector, { props: { check: {
    provider: 'all', checking: false, availability: 'available', sources: [
      { provider: 'mteam', checking: false, availability: 'available', lastAttemptStatus: 'error' },
      { provider: 'hdarea', checking: false, availability: 'unchecked' },
    ],
  } } }
  );
  await flushPromises();
  const [mteam, hdarea] = wrapper.findAll('.resource-site-tile');
  expect(mteam!.get('button').attributes('aria-pressed')).toBe('true');
  expect(mteam!.attributes('title')).toContain(locale === 'en-US' ? 'Refresh failed' : '刷新失败');
  expect(hdarea!.get('button').attributes('aria-pressed')).toBe('false');
  expect(hdarea!.get<HTMLButtonElement>('button').element.disabled).toBe(true);
  await mteam!.get('button').trigger('click');
  expect(wrapper.emitted('open')).toBeUndefined();
  expect(wrapper.findAll('input')).toHaveLength(0);
  expect(wrapper.find('.resource-site-menu').exists()).toBe(false);
  await wrapper.setProps({ disabled: true });
  expect(wrapper.get<HTMLFieldSetElement>('fieldset').element.disabled).toBe(true);
  wrapper.unmount();
});
