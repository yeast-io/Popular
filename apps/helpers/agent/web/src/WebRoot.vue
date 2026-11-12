<script setup lang="ts">
import { AgentRoot } from '@movie-hub/helper-agent-ui';
import { useManagement } from './management.composable';

const {
  locale,
  t,
  text,
  password,
  username,
  usernameRequired,
  authenticated,
  loading,
  busy,
  error,
  host,
  client,
  checkSession,
  login,
} = useManagement();
</script>
<template>
  <AgentRoot v-if="authenticated" :client="client" :host="host" />
  <main v-else class="management-shell">
    <section class="management-card">
      <p class="eyebrow">{{ t.productName }}</p>
      <h1>{{ t.managementTitle }}</h1>
      <p class="management-intro">{{ t.managementDescription }}</p>
      <p v-if="loading" role="status">{{ t.managementChecking }}</p>
      <form v-else @submit.prevent="login">
        <label v-if="usernameRequired" for="management-username">
          {{ t.managementUsername }}
          <input
            id="management-username"
            v-model="username"
            type="text"
            autocomplete="username"
            maxlength="128"
            :disabled="busy"
            required
          />
        </label>
        <label for="management-password"
          >{{ t.managementPassword
          }}<input
            id="management-password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            maxlength="4096"
            :disabled="busy"
            required
        /></label>
        <p v-if="error" class="error" role="alert">{{ text(error) }}</p>
        <button type="submit" class="primary" :disabled="busy || !password || (usernameRequired && !username)">
          {{ busy ? t.busy : t.managementSignIn }}
        </button>
        <button v-if="error === 'networkError'" type="button" class="quiet" :disabled="busy" @click="checkSession">
          {{ t.retry }}
        </button>
      </form>
      <p v-if="!usernameRequired" class="management-hint">{{ t.managementPasswordHint }}</p>
      <label class="management-language"
        >{{ t.language
        }}<select v-model="locale" :disabled="busy">
          <option value="zh-CN">{{ t.chineseLanguage }}</option>
          <option value="en-US">{{ t.englishLanguage }}</option>
        </select></label
      >
    </section>
  </main>
</template>
