<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from '../../i18n';
import SettingsIcon from './SettingsIcon.vue';
import type { SettingsSection } from '../../navigation/navigation.types';
import type { SettingsNavigationProps } from './settings-navigation.types';

const props = defineProps<SettingsNavigationProps>();
const emit = defineEmits<{ 'select': [section: SettingsSection]; 'select-mobile': [event: Event] }>();
const { t } = useI18n();
const resourcesExpanded = ref(false);
watch(() => props.section, (section) => {
  if (section === 'resources' || section === 'downloads') resourcesExpanded.value = true;
}, { immediate: true });
</script>

<template>
  <aside class="settings-sidebar">
    <p class="settings-nav-caption">{{ t('settings.workspace') }}</p>
    <nav class="settings-category-nav" :aria-label="t('settings.categories')">
      <template v-for="item in sections" :key="item">
        <div v-if="item === 'resources'" class="settings-resource-group">
          <button type="button" data-settings-group="resources"
            :aria-expanded="resourcesExpanded" aria-controls="settings-resource-children"
            @click="resourcesExpanded = !resourcesExpanded">
            <SettingsIcon name="resources" />
            <span>{{ t('settings.resourcesGroup') }}</span>
            <span class="settings-group-chevron" :class="{ expanded: resourcesExpanded }" aria-hidden="true">›</span>
          </button>
          <div v-show="resourcesExpanded" id="settings-resource-children" class="settings-resource-children">
            <button v-for="child in (['resources', 'downloads'] as const)" :key="child" type="button"
              :class="{ active: section === child }" :aria-current="section === child ? 'page' : undefined"
              :data-settings-section="child" @click="emit('select', child)">
              <SettingsIcon :name="child" />
              <span>{{ t(`settings.${child}`) }}</span>
              <span class="settings-nav-indicator" aria-hidden="true">›</span>
            </button>
          </div>
        </div>
        <button v-else-if="item !== 'downloads'" type="button" :class="{ active: section === item }"
          :aria-current="section === item ? 'page' : undefined" :data-settings-section="item"
          @click="emit('select', item)">
          <SettingsIcon :name="item" />
          <span>{{ t(`settings.${item}`) }}</span>
          <span class="settings-nav-indicator" aria-hidden="true">›</span>
        </button>
      </template>
    </nav>
    <label class="settings-mobile-category" for="settings-category">
      {{ t('settings.categories') }}
      <select id="settings-category" :value="section" @change="emit('select-mobile', $event)">
        <template v-for="item in sections" :key="item">
          <optgroup v-if="item === 'resources'" :label="t('settings.resourcesGroup')">
            <option value="resources">{{ t('settings.resources') }}</option>
            <option value="downloads">{{ t('settings.downloads') }}</option>
          </optgroup>
          <option v-else-if="item !== 'downloads'" :value="item">{{ t(`settings.${item}`) }}</option>
        </template>
      </select>
    </label>
    <div class="settings-sidebar-note">
      <span class="settings-private-dot" aria-hidden="true"></span>{{ t('settings.private') }}
    </div>
  </aside>
</template>
