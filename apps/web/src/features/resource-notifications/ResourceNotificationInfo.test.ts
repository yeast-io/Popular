// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { expect, it } from 'vitest';
import ResourceNotificationInfo from './ResourceNotificationInfo.vue';

it('supports hover, keyboard focus, Escape and touch clicks without navigating', async () => {
  const wrapper = mount(ResourceNotificationInfo, { props: { label: 'No resources found', icon: 'search' }, attachTo: document.body });
  try {
    const button = wrapper.get('button');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    expect(button.attributes('aria-label')).toBe('No resources found');
    await wrapper.trigger('mouseenter');
    expect(wrapper.get('[role="tooltip"]').text()).toBe('No resources found');
    expect(button.attributes('aria-describedby')).toBe(wrapper.get('[role="tooltip"]').attributes('id'));
    await wrapper.trigger('mouseleave');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    await button.trigger('focus');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    await button.trigger('blur');
    await button.trigger('click');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
    await button.trigger('click');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    await button.trigger('click');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});
