<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{ modelValue: string; saved: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const focused = ref(false);
// A display-only mask: the actual credential never crosses the native boundary.
const display = computed(() => props.modelValue || (props.saved && !focused.value ? '********' : ''));
function input(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
}
</script>

<template>
  <input type="password" autocomplete="new-password" :value="display" maxlength="4096"
    @focus="focused = true" @blur="focused = false" @input="input" />
</template>
