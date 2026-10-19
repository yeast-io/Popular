<script setup lang="ts">
import type {
  OpenAIConfiguration,
  ConversationMessageResponse,
  ConversationMessagesResponse,
  ConversationThreadResponse,
  ConversationThreadsResponse,
  ConversationTurnStreamEvent,
} from '@movie-hub/contract';
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedApiError, localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';
import { readSseJsonStream } from './sse';

const emit = defineEmits<{ 'open-settings': [] }>();
const configured = ref(false);
const loadingConfiguration = ref(true);
const { apiBaseUrl } = loadWebConfig();
const { t } = useI18n();
const threads = ref<ConversationThreadResponse[]>([]);
const selectedThreadId = ref<string | null>(null);
const messages = ref<ConversationMessageResponse[]>([]);
const draft = ref('');
const loadingThreads = ref(true);
const loadingMessages = ref(false);
const creating = ref(false);
const sending = ref(false);
const receiving = ref(false);
const errorMessage = ref('');
const messageList = ref<HTMLElement | null>(null);
let messageRequest = 0;
let activeTurn: AbortController | null = null;

onMounted(async () => {
  await loadThreads();
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/openai`, { credentials: 'include' });
    if (!response.ok) throw await localizedResponseError(response);
    configured.value = ((await response.json()) as OpenAIConfiguration).configured;
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally {
    loadingConfiguration.value = false;
  }
});
onBeforeUnmount(() => activeTurn?.abort());

async function loadThreads() {
  loadingThreads.value = true;
  errorMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/conversations`, { credentials: 'include' });
    if (!response.ok) throw await localizedResponseError(response);
    threads.value = ((await response.json()) as ConversationThreadsResponse).items;
    const first = threads.value[0];
    if (first) await selectThread(first.id);
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'ai.errors.loadConversations');
  } finally {
    loadingThreads.value = false;
  }
}

async function createThread(): Promise<ConversationThreadResponse | null> {
  if (creating.value || !configured.value) return null;
  creating.value = true;
  errorMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/conversations`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) throw await localizedResponseError(response);
    const thread = (await response.json()) as ConversationThreadResponse;
    threads.value = [thread, ...threads.value];
    selectedThreadId.value = thread.id;
    messages.value = [];
    return thread;
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'ai.errors.createConversation');
    return null;
  } finally {
    creating.value = false;
  }
}

async function selectThread(threadId: string, force = false) {
  if (!force && selectedThreadId.value === threadId && messages.value.length > 0) return;
  selectedThreadId.value = threadId;
  messages.value = [];
  errorMessage.value = '';
  loadingMessages.value = true;
  const request = ++messageRequest;
  try {
    const response = await fetch(`${apiBaseUrl}/conversations/${threadId}/messages?limit=100`, {
      credentials: 'include',
    });
    if (!response.ok) throw await localizedResponseError(response);
    const result = (await response.json()) as ConversationMessagesResponse;
    if (request !== messageRequest || selectedThreadId.value !== threadId) return;
    messages.value = result.items;
    await scrollToLatest();
  } catch (error) {
    if (request === messageRequest) {
      errorMessage.value = localizedErrorMessage(error, 'ai.errors.loadMessages');
    }
  } finally {
    if (request === messageRequest) loadingMessages.value = false;
  }
}

async function sendMessage() {
  const content = draft.value.trim();
  if (!content || sending.value || !configured.value) return;

  let threadId = selectedThreadId.value;
  if (!threadId) threadId = (await createThread())?.id ?? null;
  if (!threadId) return;

  const clientRequestId = crypto.randomUUID();
  const optimistic: ConversationMessageResponse = {
    id: `pending-${clientRequestId}`,
    threadId,
    sequence: (messages.value.at(-1)?.sequence ?? 0) + 1,
    role: 'user',
    content,
    clientRequestId,
    createdAt: new Date().toISOString(),
  };
  messages.value.push(optimistic);
  draft.value = '';
  sending.value = true;
  receiving.value = false;
  errorMessage.value = '';
  updateThreadPreview(threadId, content, optimistic.createdAt);
  await scrollToLatest();

  try {
    activeTurn = new AbortController();
    const response = await fetch(`${apiBaseUrl}/conversations/${threadId}/turns/stream`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, clientRequestId }),
      signal: activeTurn.signal,
    });
    if (!response.ok) throw await localizedResponseError(response);
    const streamingId = `streaming-${clientRequestId}`;
    for await (const event of readSseJsonStream<ConversationTurnStreamEvent>(response)) {
      if (event.type === 'error') throw localizedApiError(event, 'ai.errors.sendMessage');
      if (event.type === 'user_message') {
        replaceMessage(optimistic.id, event.message);
      } else if (event.type === 'delta') {
        receiving.value = true;
        const existing = messages.value.find(({ id }) => id === streamingId);
        if (existing) existing.content += event.delta;
        else
          messages.value.push({
            id: streamingId,
            threadId,
            sequence: (messages.value.at(-1)?.sequence ?? optimistic.sequence) + 1,
            role: 'assistant',
            content: event.delta,
            createdAt: new Date().toISOString(),
          });
      } else {
        replaceMessage(streamingId, event.assistantMessage);
        updateThreadPreview(threadId, content, event.assistantMessage.createdAt);
      }
      await scrollToLatest();
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    const failure = localizedErrorMessage(error, 'ai.errors.sendMessage');
    if (failure === t('openai.required')) configured.value = false;
    await selectThread(threadId, true);
    errorMessage.value = failure;
  } finally {
    activeTurn = null;
    sending.value = false;
    receiving.value = false;
  }
}

function replaceMessage(id: string, replacement: ConversationMessageResponse) {
  const withoutPrevious = messages.value.filter((message) => {
    return message.id !== id && message.id !== replacement.id;
  });
  messages.value = [...withoutPrevious, replacement].sort((left, right) => {
    return left.sequence - right.sequence;
  });
}

function updateThreadPreview(threadId: string, content: string, lastMessageAt: string) {
  const index = threads.value.findIndex(({ id }) => id === threadId);
  if (index < 0) return;
  const current = threads.value[index];
  if (!current) return;
  const updated: ConversationThreadResponse = {
    ...current,
    title: current.title || Array.from(content.replace(/\s+/g, ' ').trim()).slice(0, 60).join(''),
    lastMessageAt,
    nextSequence: Math.max(current.nextSequence, (messages.value.at(-1)?.sequence ?? 0) + 1),
  };
  threads.value = [updated, ...threads.value.filter(({ id }) => id !== threadId)];
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  void sendMessage();
}

async function scrollToLatest() {
  await nextTick();
  messageList.value?.scrollTo({ top: messageList.value.scrollHeight, behavior: 'smooth' });
}
</script>

<template>
  <section class="ai-page" aria-labelledby="ai-page-title">
    <aside class="ai-sidebar">
      <div class="ai-sidebar-heading">
        <div>
          <p class="eyebrow">{{ t('ai.eyebrow') }}</p>
          <h1 id="ai-page-title">{{ t('ai.title') }}</h1>
        </div>
        <button
          class="ai-new-chat"
          type="button"
          :disabled="creating || sending || loadingConfiguration || !configured"
          @click="createThread"
        >
          <span aria-hidden="true">＋</span>{{ creating ? t('ai.creating') : t('ai.newConversation') }}
        </button>
      </div>

      <div class="ai-thread-list" :aria-label="t('ai.history')">
        <p v-if="loadingThreads" class="ai-muted">{{ t('ai.loadingConversations') }}</p>
        <p v-else-if="threads.length === 0" class="ai-muted">{{ t('ai.noConversations') }}</p>
        <button
          v-for="thread in threads"
          :key="thread.id"
          type="button"
          class="ai-thread"
          :class="{ active: selectedThreadId === thread.id }"
          :disabled="sending"
          @click="selectThread(thread.id)"
        >
          <span>{{ thread.title || t('ai.untitledConversation') }}</span>
          <small>{{
            thread.nextSequence > 1
              ? t('ai.messageCount', { count: thread.nextSequence - 1 })
              : t('ai.emptyConversation')
          }}</small>
        </button>
      </div>
    </aside>

    <section class="ai-chat-panel" :aria-busy="loadingMessages || sending">
      <div ref="messageList" class="ai-messages" aria-live="polite">
        <div v-if="loadingMessages" class="ai-center-state">
          <span class="ai-loader" aria-hidden="true" />
          <p>{{ t('ai.loadingMessages') }}</p>
        </div>
        <div v-else-if="messages.length === 0" class="ai-welcome">
          <div class="ai-orb" aria-hidden="true">AI</div>
          <p class="eyebrow">{{ t('ai.welcomeEyebrow') }}</p>
          <h2>{{ t('ai.welcomeTitle') }}</h2>
          <p>{{ t('ai.welcomeDescription') }}</p>
        </div>
        <template v-else>
          <article v-for="message in messages" :key="message.id" class="ai-message" :class="`is-${message.role}`">
            <div class="ai-message-avatar" aria-hidden="true">{{ message.role === 'user' ? 'YOU' : 'AI' }}</div>
            <div class="ai-message-content">
              <strong>{{ message.role === 'user' ? t('ai.you') : t('ai.assistant') }}</strong>
              <p>{{ message.content }}</p>
            </div>
          </article>
        </template>
        <article v-if="sending && !receiving" class="ai-message is-assistant ai-thinking">
          <div class="ai-message-avatar" aria-hidden="true">AI</div>
          <div class="ai-message-content">
            <strong>{{ t('ai.assistant') }}</strong>
            <span
              ><i /><i /><i /><span class="sr-only">{{ t('ai.thinking') }}</span></span
            >
          </div>
        </article>
      </div>

      <div class="ai-composer-area">
        <div v-if="!loadingConfiguration && !configured" class="ai-key-required" role="status">
          <p>{{ t('openai.required') }}</p>
          <button type="button" class="secondary" @click="emit('open-settings')">{{ t('nav.settings') }}</button>
        </div>
        <p v-if="errorMessage" class="error ai-error" role="alert">{{ errorMessage }}</p>
        <form class="ai-composer" @submit.prevent="sendMessage">
          <textarea
            v-model="draft"
            rows="1"
            maxlength="20000"
            :placeholder="t('ai.placeholder')"
            :aria-label="t('ai.placeholder')"
            :disabled="sending || loadingConfiguration || !configured"
            @keydown="handleComposerKeydown"
          />
          <button
            type="submit"
            :disabled="sending || !draft.trim() || loadingConfiguration || !configured"
            :aria-label="t('ai.send')"
          >
            <span aria-hidden="true">↑</span>
          </button>
        </form>
        <small>{{ t('ai.composerHint') }}</small>
      </div>
    </section>
  </section>
</template>
