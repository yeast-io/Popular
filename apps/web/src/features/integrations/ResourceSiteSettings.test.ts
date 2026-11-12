// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import ResourceSiteSettings from './ResourceSiteSettings.vue';
import MTeamSettings from './MTeamSettings.vue';
import { setLocale } from '../../i18n';

afterEach(() => vi.unstubAllGlobals());
for (const locale of ['zh-CN', 'en-US'] as const) {
  it(`verifies API Key without a Passkey while leaving search outside the settings card in ${locale}`, async () => {
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
        init?.method === 'PUT' ? { site: 'hdarea', baseUrl: 'https://custom-hdarea.example/', status: 'configured_valid', apiKeyMasked: '••••••••', passkeyMasked: '••••••••' } : { site: 'hdarea', baseUrl: 'https://custom-hdarea.example/', status: 'unconfigured' }
      );
    })
    );
    const wrapper = mount(ResourceSiteSettings);
    await flushPromises();
    expect((wrapper.get('#hdarea-base-url').element as HTMLInputElement).value).toBe('https://custom-hdarea.example/');
    expect(wrapper.get('#hdarea-base-url').attributes('readonly')).toBeDefined();
    expect(wrapper.text()).toContain(locale === 'zh-CN'
      ? '由服务器配置。'
      : 'Configured by the server.');
    await wrapper.get('#hdarea-api-key').setValue('a'.repeat(32));
    expect(wrapper.find('#hdarea-passkey').exists()).toBe(false);
    await wrapper.findAll('form')[0]!.trigger('submit');
    await flushPromises();
    expect((wrapper.get('#hdarea-api-key').element as HTMLInputElement).value).toBe('••••••••');
    expect(JSON.parse(String(calls.find((c) => c.init?.method === 'PUT')!.init!.body))).toEqual(
      { apiKey: 'a'.repeat(32) }
    );
    expect(wrapper.find('#hdarea-passkey').exists()).toBe(false);
    await wrapper.findAll('form')[0]!.trigger('submit');
    await flushPromises();
    expect(JSON.parse(String(calls.filter((c) => c.init?.method === 'PUT').at(-1)!.init!.body))).toEqual({});
    expect(wrapper.find('#hdarea-query').exists()).toBe(false);
    expect(wrapper.findAll('form')).toHaveLength(1);
    expect(wrapper.emitted('configuration-changed')).toHaveLength(2);
    expect(wrapper.get('#hdarea-api-url').element).toHaveProperty('value', 'https://custom-hdarea.example/api/v1/');
    const actions = wrapper.findAll('button:not([role=switch])');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.text()).toBe(locale === 'zh-CN' ? '测试并保存' : 'Test and save');
    expect(calls.some((call) => call.init?.method === 'POST' || call.init?.method === 'DELETE')).toBe(false);
    expect(wrapper.text()).not.toContain('uid=secret');
    wrapper.unmount();
  });
}

for (const locale of ['zh-CN', 'en-US'] as const) {
  for (const [site, component, field] of [
    ['hdarea', ResourceSiteSettings, '#hdarea-api-key'],
    ['mteam', MTeamSettings, '#mteam-api-key'],
  ] as const) {
    it(`shows the shared duplicate credential message when adding ${site} in ${locale}`, async () => {
      setLocale(locale);
      vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') return Response.json({
          error: { code: 'RESOURCE_SITE_ACCOUNT_IN_USE', message: 'private server details' },
        }, { status: 409 });
        return Response.json({ site, provider: site, status: 'unconfigured' });
      }));
      const wrapper = mount(component);
      await flushPromises();
      await wrapper.get(field).setValue('test-credential');
      await wrapper.get('form').trigger('submit');
      await flushPromises();
      expect(wrapper.text()).toContain(locale === 'zh-CN'
        ? '密钥或认证信息无法重复绑定'
        : 'Keys or authentication credentials cannot be linked more than once.');
      expect(wrapper.text()).not.toContain('private server details');
      expect(wrapper.emitted('configuration-changed')).toBeUndefined();
      wrapper.unmount();
    });
  }
}

for (const locale of ['zh-CN', 'en-US'] as const) {
  it(`keeps HDWing and HDArea credentials independent and hides Passkey fields in ${locale}`, async () => {
    setLocale(locale);
    const calls: Array<{ url: string; body: string | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const site = url.includes('/hdwing') ? 'hdwing' : 'hdarea';
      calls.push({ url, body: init?.body as string | undefined });
      return Response.json({ site, requiresPasskey: site === 'hdarea', baseUrl: `https://${site}.example/`,
        status: init?.method === 'PUT' ? 'configured_valid' : 'unconfigured',
        ...(init?.method === 'PUT' ? { cookieMasked: '••••••••' } : {}) });
    }));
    const area = mount(ResourceSiteSettings);
    const wing = mount(ResourceSiteSettings, { props: { site: 'hdwing', name: 'HDWing' } });
    await flushPromises();
    expect(area.find('#hdarea-passkey').exists()).toBe(false);
    expect(wing.find('#hdwing-passkey').exists()).toBe(false);
    expect(wing.text()).toContain('HDWing');
    expect(wing.find('#hdwing-api-url').exists()).toBe(false);
    expect(wing.findAll('input[type=url]')).toHaveLength(1);
    expect(area.findAll('input[type=url]')).toHaveLength(2);
    expect(wing.text()).not.toContain('HDArea');
    await wing.get('#hdwing-cookie').setValue('hdchina=private-cookie');
    await wing.get('form').trigger('submit');
    await flushPromises();
    const saved = calls.find((call) => call.body);
    expect(saved?.url).toContain('/resource-sites/hdwing');
    expect(JSON.parse(saved!.body!)).toEqual({ cookie: 'hdchina=private-cookie' });
    expect((area.get('#hdarea-api-key').element as HTMLInputElement).value).toBe('');
    expect(wing.text()).not.toContain('private-cookie');
    area.unmount();
    wing.unmount();
  });
}

for (const locale of ['en-US', 'zh-CN'] as const) {
  it(`requires a new API Key for a legacy HDArea Cookie in ${locale}`, async () => {
    setLocale(locale);
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init) calls.push(init);
      return Response.json(init?.method === 'PUT'
        ? { site: 'hdarea', status: 'configured_valid', apiKeyMasked: '•'.repeat(32) }
        : { site: 'hdarea', status: 'configured_invalid', credentialUpdateRequired: true });
    }));
    const wrapper = mount(ResourceSiteSettings);
    await flushPromises();
    expect(wrapper.text()).toContain(locale === 'zh-CN' ? '请将旧 Cookie 替换' : 'Replace the saved Cookie');
    expect(wrapper.find('#hdarea-cookie').exists()).toBe(false);
    expect(wrapper.get('#hdarea-api-key').attributes('required')).toBeDefined();
    await wrapper.get('#hdarea-api-key').setValue('b'.repeat(32));
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(JSON.parse(String(calls.find((x) => x.method === 'PUT')!.body))).toEqual({ apiKey: 'b'.repeat(32) });
    expect(wrapper.text()).not.toContain('Replace the saved Cookie');
    wrapper.unmount();
  });
}

for (const locale of ['en-US', 'zh-CN'] as const) {
  it(`retains saved configuration and the user's draft after a failed test in ${locale}`, async () => {
    setLocale(locale);
    const saved = { site: 'hdarea', status: 'configured_valid', baseUrl: 'https://hdarea.example/',
      apiKeyMasked: '•'.repeat(32), verifiedAt: '2026-11-12T00:00:00Z' };
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      return init?.method === 'PUT'
        ? Response.json({ error: { code: 'RESOURCE_SITE_FAILED', details: { reason: 'authentication' }, message: 'private error' } }, { status: 502 })
        : Response.json(saved);
    }));
    const wrapper = mount(ResourceSiteSettings);
    await flushPromises();
    await wrapper.get('#hdarea-api-key').setValue('b'.repeat(32));
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('.integration-status').classes()).toContain('configured_valid');
    expect(wrapper.get<HTMLInputElement>('#hdarea-api-key').element.value).toBe('b'.repeat(32));
    expect(wrapper.get<HTMLInputElement>('#hdarea-base-url').element.value).toBe(saved.baseUrl);
    expect(wrapper.get<HTMLButtonElement>('button[type=submit]').element.disabled).toBe(false);
    expect(wrapper.text()).not.toContain('private error');
    expect(wrapper.emitted('configuration-changed')).toBeUndefined();
    wrapper.unmount();
  });
}
