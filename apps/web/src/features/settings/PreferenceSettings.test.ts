// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, it, expect, vi } from 'vitest';
import PreferenceSettings from './PreferenceSettings.vue';
import { setLocale } from '../../i18n';
import type { TasteProfileResponse } from '@movie-hub/contract';

const profile = (): TasteProfileResponse => {
  return {
    version: 2,
    autoMaintain: true,
    entries: [],
    withdrawn: [],
    revisions: [],
    generatedAt: null,
    generatedFingerprint: null,
    updatedAt: null,
    text: '',
    ratedCount: 4,
    minimumRatings: 5,
    marksChanged: false,
    task: null,
  };
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('requires five ratings before generation and never starts analysis on page load', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init?: RequestInit) => {
      requests.push(init?.method ?? 'GET');
      return Response.json(profile());
    })
  );
  const wrapper = mount(PreferenceSettings);
  await flushPromises();
  expect(wrapper.get('button.primary').attributes('disabled')).toBeDefined();
  expect(requests).toEqual(['GET']);
  wrapper.unmount();
});
it('manual generation is explicit and sends no client-selected user identity', async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      }
      );
      return Response.json({ ...profile(), ratedCount: 5 });
    })
  );
  const wrapper = mount(PreferenceSettings);
  await flushPromises();
  await wrapper.get('button.primary').trigger('click');
  await flushPromises();
  expect(requests.at(-1)?.url).toMatch(/me\/preferences\/generate$/);
  expect(requests.at(-1)?.method).toBe('POST');
  expect(requests.at(-1)?.body).toBeNull();
  wrapper.unmount();
});
it('corrections submit the current version and deletion requires a separate confirmation', async () => {
  const requests: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init?: RequestInit) => {
      if (init?.body) requests.push(JSON.parse(String(init.body)));
      return Response.json({
        ...profile(),
        entries: [
          {
            id: 'p1',
            section: 'inferred',
            content: 'Maybe likes war movies',
            evidenceRefs: ['movie:1:liked'],
            updatedAt: new Date().toISOString(),
            protected: false,
          },
        ],
      }
      );
    })
  );
  const wrapper = mount(PreferenceSettings);
  await flushPromises();
  await wrapper.get('textarea').setValue('I like history movies');
  await wrapper.get('.preference-entry .preference-actions button').trigger('click');
  await flushPromises();
  expect(requests[0]).toEqual({ expectedVersion: 2, entryId: 'p1', content: 'I like history movies' });
  const deleteButton = wrapper.get('.preference-entry .preference-actions').findAll('button')[1]!;
  await deleteButton.trigger('click');
  expect(requests).toHaveLength(1);
  await wrapper.get('.preference-entry .preference-actions').findAll('button')[1]!.trigger('click');
  await flushPromises();
  expect(requests[1]).toEqual({ expectedVersion: 2, entryId: 'p1' });
  wrapper.unmount();
});

it('keeps revision content out of the list and restores focus after closing or cancelling its dialog', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return Response.json({
        ...profile(),
        revisions: [
          {
            version: 1,
            at: '2026-10-18T12:00:00Z',
            source: 'job1',
            entries: [
              {
                id: 'old',
                section: 'inferred',
                content: 'Historical preference content',
                evidenceRefs: ['movie:1:liked'],
                updatedAt: '2026-10-18T12:00:00Z',
                protected: false,
              },
            ],
          },
        ],
      }
      );
    })
  );
  const wrapper = mount(PreferenceSettings, { attachTo: document.body });
  try {
    await flushPromises();
    expect(wrapper.get('.preference-history').text()).not.toContain('Historical preference content');
    const trigger = wrapper.get('.preference-revision button');
    await trigger.trigger('click');
    await flushPromises();
    const dialog = document.querySelector<HTMLDialogElement>('.preference-version-dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('Historical preference content');
    dialog.querySelector<HTMLButtonElement>('button')!.click();
    await flushPromises();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    await trigger.trigger('click');
    await flushPromises();
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    await flushPromises();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
  } finally {
    wrapper.unmount();
  }
});

it('shows empty revision content without incorrectly treating it as a generation failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return Response.json({
        ...profile(),
        revisions: [{ version: 0, at: '2026-10-18T12:00:00Z', source: 'user-edit', entries: [] }],
      }
      );
    })
  );
  const wrapper = mount(PreferenceSettings, { attachTo: document.body });
  try {
    await flushPromises();
    await wrapper.get('.preference-revision button').trigger('click');
    await flushPromises();
    const dialog = document.querySelector<HTMLDialogElement>('.preference-version-dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('.preference-dialog-empty')?.textContent).toBeTruthy();
    expect(dialog.querySelectorAll('.preference-dialog-group')).toHaveLength(0);
    wrapper.unmount();
    expect(document.querySelector('.preference-version-dialog')).toBeNull();
  } finally {
    if (wrapper.exists()) wrapper.unmount();
  }
});

it.each(['en-US', 'zh-CN'] as const)('expands only the first visible entry and preserves disclosure choices and drafts in %s', async (locale) => {
  setLocale(locale);
  const entries = [
    { id: 'inferred', section: 'inferred', content: 'Possibly likes crime movies' },
    { id: 'first', section: 'explicit', content: 'Likes science fiction' },
    { id: 'second', section: 'explicit', content: 'Dislikes musicals' },
  ].map(
    (entry) => ({ ...entry, evidenceRefs: ['source'], updatedAt: '2026-10-20T00:00:00Z', protected: false })
  );
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...profile(), entries })));
  const wrapper = mount(PreferenceSettings);
  try {
    await flushPromises();
    const cards = wrapper.findAll('.preference-entry');
    expect(cards.map((card) => card.get('.preference-entry-summary').attributes('aria-expanded') === 'true')).toEqual(
      [true, false, false]
    );
    expect(cards.map((card) => card.get('.preference-entry-number').text())).toEqual(['1', '2', '3']);
    const second = cards[1]!;
    await second.get('.preference-entry-summary').trigger('click');
    await second.get('textarea').setValue('Avoids musicals');
    await second.get('.preference-entry-summary').trigger('click');
    await second.get('.preference-entry-summary').trigger('click');
    expect(second.get<HTMLTextAreaElement>('textarea').element.value).toBe('Avoids musicals');
    expect(second.get('.preference-entry-preview').attributes('aria-hidden')).toBe('true');
    expect(second.get('.preference-entry-reveal').attributes('aria-hidden')).toBe('false');
    expect(cards[2]!.get('.preference-entry-reveal').attributes('inert')).toBeDefined();
    await cards[0]!.get('.preference-entry-summary').trigger('click');
    await second.get('.preference-actions button').trigger('click');
    await flushPromises();
    expect(cards.map((card) => card.get('.preference-entry-summary').attributes('aria-expanded') === 'true')).toEqual(
      [false, true, false]
    );
  } finally { wrapper.unmount(); }
});
