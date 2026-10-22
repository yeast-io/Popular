// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import ResourceSiteSettings from './ResourceSiteSettings.vue';
import { setLocale } from '../../i18n';

afterEach(() => vi.unstubAllGlobals());
for (const locale of ['zh-CN', 'en-US'] as const) {
  it(`verifies Cookie and Passkey while leaving search outside the settings card in ${locale}`, async () => {
    setLocale(locale);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes(
        '/releases?'
      )) return Response.json(
        { releases: [{ id: '123', title: 'Interstellar.2014.1080p', seeders: 22 }] }
      );
      return Response.json(
        init?.method === 'PUT' ? { site: 'hdarea', status: 'configured_valid', cookieMasked: '••••••••', passkeyMasked: '••••••••' } : { site: 'hdarea', status: 'unconfigured' }
      );
    })
    );
    const wrapper = mount(ResourceSiteSettings);
    await flushPromises();
    await wrapper.get('.integration-disclosure').trigger('click');
    await wrapper.get('#hdarea-cookie').setValue('uid=secret');
    await wrapper.get('#hdarea-passkey').setValue('private-passkey');
    await wrapper.findAll('form')[0]!.trigger('submit');
    await flushPromises();
    expect((wrapper.get('#hdarea-cookie').element as HTMLInputElement).value).toBe('••••••••');
    expect(JSON.parse(String(calls.find((c) => c.init?.method === 'PUT')!.init!.body))).toEqual(
      { cookie: 'uid=secret', passkey: 'private-passkey' }
    );
    expect((wrapper.get('#hdarea-passkey').element as HTMLInputElement).value).toBe('••••••••');
    await wrapper.findAll('form')[0]!.trigger('submit');
    await flushPromises();
    expect(JSON.parse(String(calls.filter((c) => c.init?.method === 'PUT').at(-1)!.init!.body))).toEqual({});
    expect(wrapper.find('#hdarea-query').exists()).toBe(false);
    expect(wrapper.findAll('form')).toHaveLength(1);
    expect(wrapper.emitted('configuration-changed')).toHaveLength(2);
    await wrapper.get('#hdarea-cookie').setValue('unsaved-cookie-draft');
    const retest = wrapper.findAll('button').find(
      (button) => button.text() === (locale === 'en-US' ? 'Retest configuration' : '重新测试配置')
    )!;
    await retest.trigger('click');
    await flushPromises();
    const tested = calls.find((call) => call.init?.method === 'POST')!;
    expect(tested.url).toContain('/hdarea/test');
    expect(tested.init?.body).toBeUndefined();

    expect(wrapper.text()).not.toContain('uid=secret');
    wrapper.unmount();
  });
}
