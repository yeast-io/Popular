// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PendingTasks from './PendingTasks.vue';
import type { QueueView } from './queue.types';
import { queueRemaining } from './queue.presentation';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  invoke.mockReset();
});

for (const locale of ['en-US', 'zh-CN'] as const) {
  describe(locale, () => {
    it('shows offline metadata and deadlines without submitting a download; pagination requests metadata only', async () => {
      const now = Date.now();
      const view: QueueView = { stale: true, loading: false, snapshot: { observedAt: now, total: 51,
        nextCursor: `${now + 3600000}:command`, items: [{ commandId: 'command', resourceId: '991',
          source: 'hdarea', title: 'Movie · 电影', enqueuedAt: now - 60000, expiresAt: now + 3600000,
          reason: 'downloader_unavailable' }] } };
      invoke.mockImplementation(async (command: string) => command === 'queue_status' ? view : undefined);
      const wrapper = mount(PendingTasks, { props: { locale } });
      await flushPromises();
      expect(wrapper.text()).toContain('51');
      expect(wrapper.text()).toContain('Movie · 电影');
      expect(wrapper.text()).toContain(locale === 'zh-CN' ? '缓存快照' : 'Cached snapshot');
      expect(wrapper.text()).toContain(locale === 'zh-CN' ? '下载器不可用' : 'Download tool unavailable');
      expect(wrapper.text()).toContain(locale === 'zh-CN' ? '过期时间' : 'Expires');
      await wrapper.get('.queue-pagination button:last-child').trigger('click');
      await flushPromises();
      expect(invoke).toHaveBeenCalledWith('queue_page', { cursor: view.snapshot!.nextCursor });
      expect(invoke.mock.calls.every(([command]) => ['queue_status', 'queue_page'].includes(command))).toBe(true);
      const calls = invoke.mock.calls.length;
      wrapper.unmount();
      await vi.advanceTimersByTimeAsync(4000);
      expect(invoke.mock.calls.length).toBe(calls);
    });
    it('removes successful or expired tasks when the server returns an empty snapshot', async () => {
      let view: QueueView = { stale: false, loading: false, snapshot: { observedAt: Date.now(), total: 1,
        nextCursor: null, items: [{ commandId: 'command', resourceId: '991', source: 'mteam', title: 'Pending movie',
          enqueuedAt: 1000, expiresAt: Date.now() + 1000, reason: 'queued' }] } };
      invoke.mockImplementation(async () => view);
      const wrapper = mount(PendingTasks, { props: { locale } });
      await flushPromises();
      expect(wrapper.findAll('.queue-card')).toHaveLength(1);
      view = { stale: false, loading: false, snapshot: { observedAt: Date.now(), total: 0, nextCursor: null, items: [] } };
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      expect(wrapper.findAll('.queue-card')).toHaveLength(0);
      expect(wrapper.text()).toContain(locale === 'zh-CN' ? '暂无待处理任务' : 'No pending tasks');
      wrapper.unmount();
    });
    it('formats expiry rather than showing a negative countdown', () => {
      expect(queueRemaining(1000, 2000, locale)).toBe(locale === 'zh-CN' ? '已过期' : 'Expired');
      expect(queueRemaining(61000, 1000, locale)).toContain('1');
    });
  });
}
