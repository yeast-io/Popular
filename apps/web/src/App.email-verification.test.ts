// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App.vue';
import { setLocale } from './i18n';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const locale of ['zh-CN', 'en-US'] as const) {
  it(`keeps registration signed out until a valid code is accepted (${locale})`, async () => {
    window.history.replaceState({}, '', '/register');
    setLocale(locale);
    vi.stubGlobal('scrollTo', vi.fn());
    let codeAccepted = false;
    const requests: { url: string; options: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      requests.push({ url, options });
      if (url.endsWith('/config')) return Response.json({ aiAssistantEnabled: false, notificationTestEnabled: false });
      if (url.endsWith('/auth/me')) return new Response(null, { status: 401 });
      if (url.endsWith('/auth/register')) return Response.json({ email: 'person@example.com', expiresAt: new Date(Date.now() + 86400000).toISOString() }, { status: 202 });
      if (url.endsWith('/auth/verify-email')) {
        if (!codeAccepted) return Response.json({ error: { code: 'EMAIL_VERIFICATION_INVALID', message: 'Invalid code', requestId: 'test' } }, { status: 400 });
        return Response.json({ user: { id: 'verified-user', email: 'person@example.com', displayName: 'Person', locale } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const wrapper = mount(App, { global: { stubs: { MovieBrowser: true } } });
    try {
      await flushPromises();
      await wrapper.get('#auth-display-name').setValue('Person');
      await wrapper.get('#auth-email').setValue('person@example.com');
      await wrapper.get('#auth-password').setValue('secure password for registration');
      await wrapper.get('.auth-card form').trigger('submit');
      await flushPromises();
      expect(wrapper.find('#auth-code').exists()).toBe(true);
      expect(wrapper.find('#auth-password').exists()).toBe(false);
      expect(wrapper.find('.account-menu').exists()).toBe(false);
      expect(wrapper.text()).toContain(locale === 'zh-CN' ? '24 小时' : '24 hours');
      const registration = requests.find(({ url }) => url.endsWith('/auth/register'))!;
      expect(registration.options?.headers).toMatchObject({ 'accept-language': locale });
      await wrapper.get('#auth-code').setValue('12');
      await wrapper.get('.auth-card form').trigger('submit');
      expect(requests.filter(({ url }) => url.endsWith('/auth/verify-email'))).toHaveLength(0);
      await wrapper.get('#auth-code').setValue('123456');
      await wrapper.get('.auth-card form').trigger('submit');
      await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toContain(locale === 'zh-CN' ? '验证码错误' : 'incorrect');
      expect(wrapper.find('.account-menu').exists()).toBe(false);
      codeAccepted = true;
      await wrapper.get('.auth-card form').trigger('submit');
      await flushPromises();
      expect(wrapper.find('.account-menu').exists()).toBe(true);
      expect(wrapper.find('.auth-page').exists()).toBe(false);
      const verification = requests.find(({ url }) => url.endsWith('/auth/verify-email'))!;
      expect(JSON.parse(String(verification.options?.body))).toEqual({ email: 'person@example.com', code: '123456', password: 'secure password for registration' });
    } finally {
      wrapper.unmount();
    }
  });
}
