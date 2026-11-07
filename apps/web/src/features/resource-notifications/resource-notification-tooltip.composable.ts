import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

export function useResourceNotificationTooltip() {
  const root = ref<HTMLElement>();
  const hovered = ref(false);
  const focused = ref(false);
  const pinned = ref(false);
  const dismissed = ref(false);
  const visible = computed(() => !dismissed.value && (hovered.value || focused.value || pinned.value));
  function enter() {
    dismissed.value = false;
    hovered.value = true;
  }
  function focus() {
    dismissed.value = false;
    focused.value = true;
  }
  function blur() {
    focused.value = false;
    pinned.value = false;
  }
  function dismiss() {
    dismissed.value = true;
    pinned.value = false;
  }
  function toggle() {
    pinned.value = !pinned.value;
    dismissed.value = !pinned.value;
  }
  function outside(event: PointerEvent) {
    if (event.target instanceof Node && !root.value?.contains(event.target)) dismiss();
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') dismiss();
  }
  onMounted(() => {
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keydown);
  });
  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', keydown);
  });
  return { root, hovered, visible, enter, focus, blur, toggle };
}
