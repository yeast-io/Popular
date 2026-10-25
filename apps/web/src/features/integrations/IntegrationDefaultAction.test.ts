// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import IntegrationDefaultAction from './IntegrationDefaultAction.vue';

afterEach(() => vi.unstubAllGlobals());
it.each([
  ['en-US', 'resource', 'mteam', 'hdarea'],
  ['zh-CN', 'resource', 'mteam', 'hdarea'],
  ['en-US', 'downloader', 'qbittorrent', 'transmission'],
  ['zh-CN', 'downloader', 'qbittorrent', 'transmission'],
] as const)('switches the account default in %s for %s', async (locale, category, initial, target) => {
  setLocale(locale);
  let selected = initial;
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') selected = JSON.parse(String(init.body)).id;
    return Response.json(
      { defaults: { [category]: selected }, selectedSites: [], effectiveSites: category === 'resource' ? [selected] : ['mteam'], choices: [] }
    );
  });
  vi.stubGlobal('fetch', fetch);
  const wrapper = mount(
    IntegrationDefaultAction,
    { props: { id: target, category, status: 'configured_valid' } }
  );
  await flushPromises();
  expect(wrapper.get('.integration-default-button').classes()).toContain('integration-default-badge');
  expect(wrapper.get('.integration-default-button').classes()).toContain('integration-default-button');
  await wrapper.get('.integration-default-button').trigger('click');
  await flushPromises();
  const submitted = fetch.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(String(submitted?.[1]?.body))).toEqual({ category, id: target });
  expect(wrapper.find('.integration-default-button').exists()).toBe(false);
  expect(wrapper.get('.integration-default-badge').classes()).not.toContain('integration-default-button');
  expect(wrapper.get('.integration-default-badge').text()).toBe(locale === 'zh-CN' ? '默认' : 'Default');
  expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(3);
  wrapper.unmount();
});

it.each(['en-US', 'zh-CN'] as const)('persists the source switch and locks the default in %s', async (locale) => {
  setLocale(locale);
  let sites = ['mteam'];
  let primary = 'mteam';
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') sites = JSON.parse(String(init.body)).sites;
    return Response.json({ defaults: { resource: primary }, selectedSites: sites, effectiveSites: sites, choices: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(IntegrationDefaultAction, { props: { id: 'hdarea', category: 'resource', status: 'configured_valid' } });
  await flushPromises();
  expect(wrapper.get('[role=switch]').attributes('aria-checked')).toBe('false');
  await wrapper.get('[role=switch]').trigger('click');
  await flushPromises();
  expect(sites).toEqual(['mteam', 'hdarea']);
  expect(wrapper.get('[role=switch]').attributes('aria-checked')).toBe('true');
  await wrapper.get('[role=switch]').trigger('click');
  await flushPromises();
  expect(sites).toEqual(['mteam']);
  sites = ['mteam', 'hdarea'];
  primary = 'hdarea';
  window.dispatchEvent(new Event('integration-preferences-changed'));
  await flushPromises();
  expect(wrapper.get<HTMLButtonElement>('[role=switch]').element.disabled).toBe(true);
  expect(wrapper.get('[role=switch]').attributes('aria-checked')).toBe('true');
  wrapper.unmount();
});
