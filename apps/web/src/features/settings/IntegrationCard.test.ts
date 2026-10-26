// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { expect, it } from 'vitest';
import IntegrationCard from './IntegrationCard.vue';
import hdareaLine from '../../assets/integrations/hdarea-line.svg';
import mteamLine from '../../assets/integrations/mteam-line.svg';

const props = {
  id: 'telegram',
  title: 'Telegram',
  badge: 'TG',
  description: 'Private notifications',
  statusLabel: 'Not linked',
  statusClass: 'unconfigured',
};

it('uses a bundled logo, falls back to letters after a load error, and retries when the service changes', async () => {
  const wrapper = mount(IntegrationCard, { props });
  const logo = wrapper.get('.connection-badge img');
  const telegramSrc = logo.attributes('src');
  expect(telegramSrc).toMatch(/^(data:image\/|\/)/);
  expect(logo.attributes('alt')).toBe('');
  expect(wrapper.get('.connection-badge').text()).toBe('');
  await logo.trigger('error');
  expect(wrapper.find('.connection-badge img').exists()).toBe(false);
  expect(wrapper.get('.connection-badge').text()).toBe('TG');
  expect(wrapper.get('h3').text()).toBe('Telegram');
  await wrapper.setProps({ id: 'whatsapp', title: 'WhatsApp', badge: 'WA' });
  expect(wrapper.get('.connection-badge img').attributes('src')).not.toBe(telegramSrc);
  wrapper.unmount();
});

it('shows letters for a service without a logo and preserves the card controls', async () => {
  const wrapper = mount(IntegrationCard, { props: { ...props, id: 'other', badge: 'OT' } });
  expect(wrapper.find('.connection-badge img').exists()).toBe(false);
  expect(wrapper.get('.connection-badge').text()).toBe('OT');
  await wrapper.get('button').trigger('click');
  expect(wrapper.get('button').attributes('aria-expanded')).toBe('true');
  expect(wrapper.emitted('open')).toHaveLength(1);
  wrapper.unmount();
});

it.each(['hdarea', 'mteam'])('uses the bundled %s line logo', (id) => {
  const wrapper = mount(IntegrationCard, { props: { ...props, id, title: id, badge: 'HD' } });
  expect(wrapper.get('.connection-badge img').attributes('src')).toBe(id === 'hdarea' ? hdareaLine : mteamLine);
  expect(wrapper.get('.connection-badge').text()).toBe('');
  wrapper.unmount();
});
