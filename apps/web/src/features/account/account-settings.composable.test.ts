// @vitest-environment happy-dom
import type { AuthUser } from '@movie-hub/contract';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import { useAccountSettings } from './account-settings.composable';

const wrappers: ReturnType<typeof mount>[] = [];
function createAccount() {
  const user = ref<AuthUser | null>({ id: 'account', displayName: 'Owner', email: 'owner@example.com', locale: 'en-US' });
  let account!: ReturnType<typeof useAccountSettings>;
  const updateUser = vi.fn((updated: AuthUser) => {
    user.value = updated;
  });
  const wrapper = mount(defineComponent({
    setup() {
      account = useAccountSettings({ user, onUserUpdated: updateUser });
      return () => h('div');
    },
  }));
  wrappers.push(wrapper);
  return { account, user, updateUser, wrapper };
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['en-US', 'zh-CN'] as const)('keeps the profile draft and avatar preview when language is saved (%s)', async (locale) => {
  setLocale('en-US');
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:avatar-draft');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
  const { account, user, wrapper } = createAccount();
  account.profileName.value = 'Unsaved name';
  const input = document.createElement('input');
  Object.defineProperty(input, 'files', { value: [new File(['image'], 'avatar.png', { type: 'image/png' })] });
  account.chooseAvatar({ target: input } as unknown as Event);
  account.chooseLocale(locale);
  await flushPromises();

  expect(user.value?.locale).toBe(locale);
  expect(user.value?.displayName).toBe('Owner');
  expect(account.profileName.value).toBe('Unsaved name');
  expect(account.avatarSource.value).toBe('blob:avatar-draft');
  expect(account.profileDirty.value).toBe(true);
  expect(createUrl).toHaveBeenCalledOnce();
  expect(revokeUrl).not.toHaveBeenCalled();
  wrapper.unmount();
  expect(revokeUrl).toHaveBeenCalledWith('blob:avatar-draft');
});

it('owns draft state per instance and resets it when the signed-in account changes', () => {
  const first = createAccount();
  const second = createAccount();
  first.account.profileName.value = 'First draft';
  expect(second.account.profileName.value).toBe('Owner');
  first.user.value = { id: 'another-account', displayName: 'Another owner', email: 'another@example.com', locale: 'en-US' };
  expect(first.account.profileName.value).toBe('Another owner');
  expect(first.account.profileDirty.value).toBe(false);
  expect(second.user.value?.id).toBe('account');
});

it('does not publish a pending language response after the module is unmounted', async () => {
  let respond!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
    respond = resolve;
  })));
  const { account, updateUser, wrapper } = createAccount();
  account.chooseLocale('zh-CN');
  await flushPromises();
  wrapper.unmount();
  respond(Response.json({}));
  await flushPromises();
  expect(updateUser).not.toHaveBeenCalled();
});
