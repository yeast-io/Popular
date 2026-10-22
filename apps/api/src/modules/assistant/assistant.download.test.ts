import assert from 'node:assert/strict';
import test from 'node:test';
import type { DownloadProvider, DownloaderChoice, Locale, MovieDownload } from '@movie-hub/contract';
import { AssistantWorkflow } from './assistant.workflow.js';
import { emptyAssistantSession } from './assistant-session.domain.js';
import type { AssistantSession, AssistantSessionStore, AssistantDownloadContext } from './assistant-session.types.js';
import { emptyResourceState } from '../resource-query/resource-query.domain.js';
import type { ResourceQueryState, ResourcePlan } from '../resource-query/resource-query.types.js';
import type { LlmGenerateInput, LlmMessage } from '../llm/llm.types.js';
import type { AssistantRequestClassification, AssistantInputWorkflowMessage } from './assistant.types.js';

class Sessions implements AssistantSessionStore {
  rows = new Map<string, AssistantSession>();
  locks = new Map<string, string>();
  failFinalSave = false;

  key(owner: string, chat: string) {
    return JSON.stringify([owner, chat]);
  }

  async ensure(owner: string, chat: string) {
    const key = this.key(owner, chat);
    if (!this.rows.has(key)) this.rows.set(key, emptyAssistantSession());
  }

  async read(owner: string, chat: string) {
    return structuredClone(this.rows.get(this.key(owner, chat)) ?? null);
  }

  async acquire(owner: string, chat: string, lease: string) {
    const key = this.key(owner, chat);
    if (this.locks.has(key)) return false;
    this.locks.set(key, lease);
    return true;
  }

  async save(owner: string, chat: string, lease: string, state: AssistantSession) {
    if (this.failFinalSave && state.stage === 'idle' && state.events.length > 0) {
      this.failFinalSave = false;
      throw new Error('save crashed');
    }
    const key = this.key(owner, chat);
    if (this.locks.get(key) !== lease) return false;
    this.rows.set(key, structuredClone(state));
    return true;
  }

  async release(owner: string, chat: string, lease: string) {
    const key = this.key(owner, chat);
    if (this.locks.get(key) === lease) this.locks.delete(key);
  }
}
const input: AssistantInputWorkflowMessage = {
  ownerId: 'alice',
  channel: 'telegram',
  chatId: 'chat',
  messageId: '1',
  text: '下载星际穿越',
  receivedAt: new Date().toISOString(),
};
const basePlan: ResourcePlan = {
  title: null,
  year: null,
  candidateId: null,
  resolution: null,
  providers: null,
  releaseIndex: null,
  page: null,
  refresh: false,
  question: null,
  unsupported: [],
};
function fixture(
  providers: DownloadProvider[] = ['qbittorrent', 'transmission'],
  locale: Locale = 'zh-CN',
  defaultProvider?: DownloadProvider,
  instances?: DownloaderChoice[]
) {
  let handling: AssistantRequestClassification['handling'];
  const requests: LlmGenerateInput[] = [];
  let detectedLocale: Locale | null = null;
  const planningContexts: AssistantDownloadContext[] = [];
  const resourceLocales: Locale[] = [];
  const sessions = new Sessions();
  let action = { action: 'query', releaseIndex: null as number | null, provider: null as string | null };
  let intent = 'download';
  let plan: ResourcePlan = { ...basePlan, title: '星际穿越' };
  let context: ResourceQueryState | null = null;
  let failSubmit = false;
  let movieCandidates = false;
  let calls = 0;
  let resourceCalls = 0;
  const submissions: Array<{ owner: string; movie: number; release: string; provider: DownloadProvider; downloaderInstanceId?: string }> = [];
  const logs: unknown[] = [];
  const create = () => {
    return new AssistantWorkflow(
      async () => {
        return {
          generate: async (request) => {
            calls++;
            requests.push(request);
            if (request.operation === 'assistant.download.plan') {
              const payload = JSON.parse(request.messages.at(-1)!.content) as { context: AssistantDownloadContext };
              planningContexts.push(payload.context);
            }
            const content
              = request.operation === 'assistant.intent'
                ? { intent, handling, preferenceSignal: 'none', locale: detectedLocale }
                : request.operation === 'assistant.download.plan'
                  ? action
                  : request.operation === 'assistant.resources.plan'
                    ? plan
                    : 'Discussion reply';
            return {
              content: typeof content === 'string' ? content : JSON.stringify(content),
              inputTokens: 1,
              outputTokens: 1,
            };
          },
        };
      },
      {
        locale,
        systemPrompt: 'Brief',
        maxContextTokens: 8_000,
        maxOutputTokens: 500,
        sessions,
        diagnostics: { verbose: false, logger: { error: (...args: unknown[]) => logs.push(args) } },
        resources: {
          active: async () => Boolean(context),
          context: async (owner) => (owner === 'alice' ? structuredClone(context) : null),
          run: async (_owner, _conversation, _event, text, history, decisions, signal, replyLocale = 'zh-CN') => {
            resourceLocales.push(replyLocale);
            resourceCalls++;
            await decisions.plan(
              text,
              history,
              { ...emptyResourceState(), sources: [], releaseCount: 0, page: 1, pageCount: 0 },
              replyLocale,
              signal!
            );
            context = {
              ...emptyResourceState(),
              updatedAt: new Date().toISOString(),
              movie: movieCandidates ? null : { tmdbId: 157336, title: '星际穿越' },
              candidates: movieCandidates ? [{ tmdbId: 157336, title: '星际穿越' }] : [],
              releases: movieCandidates
                ? []
                : [
                    { provider: 'mteam', id: 'release-1', title: 'secret-release-title.1080p' },
                    { provider: 'mteam', id: 'release-2', title: 'secret-release-title.2160p' },
                  ],
              snapshot: { createdAt: new Date().toISOString(), results: [] },
            };
            return {
              replyText: movieCandidates
                ? replyLocale === 'zh-CN'
                  ? '请选择电影'
                  : 'Choose a film'
                : '1. 1080p\n2. 4K',
            };
          },
        },
        downloads: {
          providersFor: async () => [...providers],
          ...(instances ? { instancesFor: async () => [...instances] } : {}),
          defaultProviderFor: async () => defaultProvider,
          createForOwner: async (owner, movie, release, provider, _source, downloaderInstanceId) => {
            const persisted = await sessions.read(owner, 'telegram:chat');
            assert.equal(persisted?.stage, 'submitting', 'checkpoint must precede external submission');
            assert.equal(persisted?.selection?.releaseId, release);
            submissions.push({ owner, movie, release, provider, ...(downloaderInstanceId ? { downloaderInstanceId } : {}) });
            if (failSubmit) throw new Error('upstream secret-release-title.2160p failed');
            return {
              id: 'task-1',
              tmdbId: movie,
              sourceProvider: 'mteam',
              sourceReleaseId: release,
              provider,
              status: 'downloading',
              progress: 12,
            } satisfies MovieDownload;
          },
        },
      }
    );
  };
  let message = 0;
  const send = (text: string, overrides: Partial<AssistantInputWorkflowMessage> = {}, history: LlmMessage[] = []) => {
    return create().run({ ...input, messageId: String(++message), text, ...overrides }, history);
  };
  return {
    sessions,
    create,
    send,
    submissions,
    logs,
    providers,
    resourceLocales,
    planningContexts,
    requests,
    handling(value: AssistantRequestClassification['handling']) {
      handling = value;
    },
    language(value: Locale | null) {
      detectedLocale = value;
    },
    action(value: string, index: number | null = null, provider: string | null = null) {
      action = { action: value, releaseIndex: index, provider };
    },
    intent(value: string) {
      intent = value;
    },
    plan(value: Partial<ResourcePlan>) {
      plan = { ...basePlan, title: null, ...value };
    },
    candidates(value: boolean) {
      movieCandidates = value;
    },
    fail(value: boolean) {
      failSubmit = value;
    },
    context() {
      return context!;
    },
    state: () => sessions.read('alice', 'telegram:chat'),
    counts: () => ({ calls, resourceCalls }),
  };
}

test('direct film download queries resources, selects no version, and resumes across workflow instances', async () => {
  const f = fixture();
  assert.match((await f.send('下载星际穿越')).replyText, /请选择要下载的资源/);
  assert.equal((await f.state())?.stage, 'await_resource');
  assert.equal(f.submissions.length, 0);
  f.intent('resources'); // Standalone classification cannot override the persisted download goal.
  f.action('select_resource', 2);
  assert.match((await f.send('第 2 个')).replyText, /请选择下载器/);
  assert.equal((await f.state())?.stage, 'await_provider');
  assert.equal(f.submissions.length, 0);
  // Numbering/list changes after selection cannot change the pinned release.
  f.context().releases.reverse();
  f.action('select_provider', null, 'transmission');
  assert.match((await f.send('用 Transmission')).replyText, /task-1/);
  assert.deepEqual(f.submissions, [{ owner: 'alice', movie: 157336, release: 'release-2', provider: 'transmission' }]);
  assert.equal((await f.state())?.stage, 'idle');
});

test('one downloader auto-selects only after the user chooses a resource; duplicate messages replay without model or business calls', async () => {
  const f = fixture(['qbittorrent']);
  await f.send('下载星际穿越');
  f.action('select_resource', 2);
  const result = await f.send('下载第2个', { messageId: 'selected' });
  const count = f.counts().calls;
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(await f.send('下载第2个', { messageId: 'selected' }), result);
  assert.equal(f.counts().calls, count);
  assert.equal(f.submissions.length, 1);
});

test('movie candidate choices remain movie queries; paging and details retain the download goal', async () => {
  const f = fixture();
  f.candidates(true);
  await f.send('下载星际穿越');
  assert.equal((await f.state())?.stage, 'await_movie');
  f.action('select_resource', 1); // Even an incorrect model decision cannot submit a movie candidate.
  assert.match((await f.send('1')).replyText, /先选择电影/);
  assert.equal(f.submissions.length, 0);
  f.candidates(false);
  f.action('query');
  f.plan({ candidateId: 157336 });
  await f.send('2014年的');
  assert.equal((await f.state())?.stage, 'await_resource');
  f.plan({ page: 'next' });
  await f.send('下一页');
  f.plan({ releaseIndex: 2 });
  await f.send('详情2');
  assert.equal(f.submissions.length, 0);
  assert.equal((await f.state())?.stage, 'await_resource');
});

test('expired snapshots, invalid indices, and unsupported sources never submit', async () => {
  const f = fixture(['transmission']);
  await f.send('下载星际穿越');
  f.action('select_resource', 99);
  assert.match((await f.send('下载99')).replyText, /编号无效/);
  f.context().releases[0]!.provider = 'other';
  f.action('select_resource', 1);
  assert.match((await f.send('下载1')).replyText, /暂不支持/);
  f.context().snapshot!.createdAt = new Date(Date.now() - 31 * 60_000).toISOString();
  assert.match((await f.send('下载1')).replyText, /已过期/);
  assert.equal(f.submissions.length, 0);
});

test('configuration changes are checked and no downloader choice is invented', async () => {
  const f = fixture([]);
  await f.send('下载星际穿越');
  f.action('select_resource', 1);
  assert.match((await f.send('下载1')).replyText, /尚未配置/);
  f.action('select_provider', null, 'transmission');
  assert.match((await f.send('Transmission')).replyText, /尚未配置/);
  f.providers.push('transmission');
  assert.match((await f.send('用Transmission')).replyText, /task-1/);
  assert.equal(f.submissions.length, 1);
});

test('a removed downloader is rejected and the previously selected resource is retained', async () => {
  const f = fixture();
  await f.send('下载星际穿越');
  f.action('select_resource', 2);
  await f.send('2');
  f.providers.splice(1, 1);
  f.action('select_provider', null, 'transmission');
  assert.match((await f.send('用Transmission')).replyText, /请选择下载器/);
  assert.equal(f.submissions.length, 0);
  assert.equal((await f.state())?.selection?.releaseId, 'release-2');
});

test('cancel and explicit topic switches discard pending selections without submitting', async () => {
  for (const action of ['cancel', 'other']) {
    const f = fixture();
    await f.send('下载星际穿越');
    f.action('select_resource', 2);
    await f.send('2');
    f.action(action);
    if (action === 'other') f.intent('discuss');
    await f.send(action === 'cancel' ? '取消' : '聊聊导演');
    assert.equal((await f.state())?.stage, 'idle');
    assert.equal((await f.state())?.selection, undefined);
    assert.equal(f.submissions.length, 0);
  }
});

test('failed submission retains the pinned selection, logs errors with verbose off, and requires an explicit retry', async () => {
  const f = fixture(['transmission']);
  await f.send('下载星际穿越');
  f.action('select_resource', 2);
  f.fail(true);
  assert.match((await f.send('2')).replyText, /未能确认成功/);
  assert.equal((await f.state())?.stage, 'submitting');
  f.action('status');
  await f.send('成功了吗');
  assert.equal(f.submissions.length, 1);
  assert.ok(f.logs.length > 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /secret-release-title/);
  f.fail(false);
  f.action('retry');
  assert.match((await f.send('重试')).replyText, /task-1/);
  assert.equal(f.submissions.length, 2);
  assert.ok(f.submissions.every((entry) => entry.provider === 'transmission' && entry.release === 'release-2'));
});

test('crash after submission preserves a checkpoint and message replay recovers with the same IDs', async () => {
  const f = fixture(['transmission']);
  await f.send('下载星际穿越');
  f.action('select_resource', 2);
  f.sessions.failFinalSave = true;
  await assert.rejects(f.send('2', { messageId: 'checkpoint' }), /save crashed/);
  assert.equal((await f.state())?.stage, 'submitting');
  f.action('cancel'); // Recovery does not re-plan the authorized side effect.
  assert.match((await f.send('2', { messageId: 'checkpoint' })).replyText, /task-1/);
  assert.deepEqual(f.submissions[0], f.submissions[1]);
});

test('owner isolation, expired sessions, and busy leases cannot reuse another active selection', async () => {
  const f = fixture();
  await f.send('下载星际穿越');
  f.action('select_resource', 2);
  await f.send('2');
  f.action('select_provider', null, 'transmission');
  assert.match((await f.send('用Transmission', { ownerId: 'bob' })).replyText, /先选择/);
  const state = f.sessions.rows.get(f.sessions.key('alice', 'telegram:chat'))!;
  state.updatedAt = new Date(Date.now() - 31 * 60_000).toISOString();
  assert.match((await f.send('用Transmission')).replyText, /先选择/);
  f.sessions.locks.set(f.sessions.key('alice', 'telegram:chat'), 'other');
  await assert.rejects(f.send('用Transmission'), /busy/);
  assert.equal(f.submissions.length, 0);
});

for (const channel of ['web', 'telegram', 'whatsapp'] as const) {
  test(`direct download lookup is shared on ${channel}`, async () => {
    const f = fixture();
    assert.equal((await f.send('下载星际穿越', { channel })).intent, 'download');
    const state = await f.sessions.read('alice', `${channel}:chat`);
    assert.equal(state?.stage, 'await_resource');
    assert.equal(f.submissions.length, 0);
  });
}

test('an explicit numbered download can reuse a prior standalone resource query', async () => {
  const f = fixture(['qbittorrent']);
  f.intent('resources');
  await f.send('查找星际穿越资源');
  assert.equal((await f.state())?.stage, 'idle');
  f.intent('download');
  f.action('select_resource', 2);
  await f.send('下载第2个');
  assert.equal(f.counts().resourceCalls, 1);
  assert.equal(f.submissions[0]?.release, 'release-2');
});

test('cancellation before a turn never reaches model or download operations', async () => {
  const f = fixture(['transmission']);
  await f.send('下载星际穿越');
  f.action('select_resource', 2);
  const calls = f.counts().calls;
  await assert.rejects(f.create().run({ ...input, messageId: 'aborted', text: '2' }, [], AbortSignal.abort()), {
    name: 'AbortError',
  }
  );
  assert.equal(f.counts().calls, calls);
  assert.equal(f.submissions.length, 0);
});

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`download replies follow ${locale} and neutral follow-ups retain the conversation language`, async () => {
    const f = fixture(['qbittorrent', 'transmission'], locale === 'en-US' ? 'zh-CN' : 'en-US');
    f.language(locale);
    const queried = await f.send(locale === 'en-US' ? 'Download Interstellar' : '下载星际穿越');
    assert.match(queried.replyText, locale === 'en-US' ? /Choose a release/ : /请选择要下载的资源/);
    assert.deepEqual(f.resourceLocales, [locale]);
    f.language(null);
    f.action('select_resource', 2);
    const selected = await f.send('2');
    assert.match(selected.replyText, locale === 'en-US' ? /Choose a downloader/ : /请选择下载器/);
    f.action('select_provider', null, 'transmission');
    const submitted = await f.send('Transmission');
    assert.match(submitted.replyText, locale === 'en-US' ? /Status: Downloading/ : /状态：正在下载/);
    if (locale === 'en-US')
      assert.doesNotMatch(queried.replyText + selected.replyText + submitted.replyText, /\p{Script=Han}/u);
    assert.equal((await f.state())?.locale, locale);
    const calls = f.counts().calls;
    assert.deepEqual(await f.send('Transmission', { messageId: '3' }), submitted);
    assert.equal(f.counts().calls, calls);
  });
}

test('English validation, failure, cancellation and clarification replies do not fall back to Chinese', async () => {
  const f = fixture([], 'en-US');
  await f.send('Download Interstellar');
  f.action('select_resource', 99);
  assert.match((await f.send('99')).replyText, /Invalid release number/);
  f.action('select_resource', 2);
  assert.match((await f.send('2')).replyText, /No downloader is configured/);
  f.providers.push('transmission');
  f.fail(true);
  f.action('select_provider', null, 'transmission');
  const failure = await f.send('Transmission');
  assert.match(failure.replyText, /submission could not be confirmed/);
  assert.doesNotMatch(failure.replyText, /\p{Script=Han}/u);
  f.action('cancel');
  assert.match((await f.send('cancel')).replyText, /selection has been cancelled/);
  f.action('retry');
  assert.match((await f.send('retry')).replyText, /no selected download to retry/);
  f.action('status');
  assert.equal((await f.send('progress?')).replyText, 'Discussion reply');
});

test('switching the user language updates a pending download without losing its pinned release', async () => {
  const f = fixture();
  f.language('zh-CN');
  await f.send('下载星际穿越');
  f.action('select_resource', 2);
  await f.send('2');
  f.language('en-US');
  f.action('clarify');
  assert.match((await f.send('Please reply in English')).replyText, /Choose a downloader/);
  assert.equal((await f.state())?.selection?.releaseId, 'release-2');
  f.language(null);
  f.action('select_provider', null, 'transmission');
  assert.match((await f.send('Transmission')).replyText, /Status: Downloading/);
});

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`a numbered download from page two receives the full snapshot at idle and selects global release three (${locale})`, async () => {
    const f = fixture(['qbittorrent', 'transmission'], locale);
    f.intent('resources');
    await f.send(locale === 'zh-CN' ? '查找火星救援资源' : 'Find releases for The Martian');
    // Resource state persists separately from the idle download session, including off-page releases.
    f.context().page = 2;
    f.context().releases = Array.from({ length: 64 }, (_, index) => {
      return {
        provider: 'mteam',
        id: `global-${index + 1}`,
        title: `Movie.2160p-${index + 1}`,
      };
    });
    assert.equal((await f.state())?.stage, 'idle');
    f.intent('download');
    f.action('select_resource', 3);
    const reply = await f.send(locale === 'zh-CN' ? '下载 3' : 'download 3');
    assert.deepEqual(f.planningContexts.at(-1), {
      stage: 'idle',
      providers: [],
      hasSelection: false,
      resources: { hasSnapshot: true, releaseCount: 64, page: 2, pageCount: 7 },
    }
    );
    assert.match(reply.replyText, locale === 'zh-CN' ? /请选择下载器/ : /Choose a downloader/);
    assert.equal((await f.state())?.selection?.releaseId, 'global-3');
    assert.equal(f.submissions.length, 0);
    f.action('select_provider', null, 'transmission');
    await f.send('Transmission');
    assert.equal(f.submissions[0]?.release, 'global-3');
    assert.equal(f.submissions[0]?.provider, 'transmission');
    assert.equal(f.counts().resourceCalls, 1);
  });

  test(`an expired standalone snapshot is not offered as valid download context (${locale})`, async () => {
    const f = fixture(['qbittorrent'], locale);
    f.intent('resources');
    await f.send('Find movie resources');
    f.context().snapshot!.createdAt = new Date(Date.now() - 31 * 60_000).toISOString();
    f.intent('download');
    f.action('select_resource', 2);
    const reply = await f.send(locale === 'zh-CN' ? '下载 2' : 'download 2');
    assert.equal(f.planningContexts.at(-1)?.resources.hasSnapshot, false);
    assert.equal(f.planningContexts.at(-1)?.resources.releaseCount, 0);
    assert.match(reply.replyText, locale === 'zh-CN' ? /已过期/ : /expired/);
    assert.equal(f.submissions.length, 0);
  });
}

test('information handling preserves download intent, historical evidence and live capability limits in both languages', async () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    for (const channel of ['telegram', 'whatsapp', 'web'] as const) {
      const f = fixture(['qbittorrent'], locale);
      f.language(locale);
      await f.send('下载星际穿越');
      f.action('select_resource', 2);
      await f.send('下载2');
      const before = f.counts();
      f.handling('answer');
      const question = locale === 'zh-CN' ? '刚才的电影用了哪个下载器？' : 'Which downloader did that film use?';
      const history: LlmMessage[] = [
        { role: 'assistant', content: 'Download submitted to qbittorrent; progress at submission: 12%' },
      ];
      const result = await f.send(question, { channel }, history);
      assert.equal(result.intent, 'download');
      assert.equal(result.replyText, 'Discussion reply');
      assert.equal(f.submissions.length, 1);
      assert.equal(f.counts().resourceCalls, before.resourceCalls);
      const request = f.requests.at(-1)!;
      assert.equal(request.operation, 'assistant.discuss');
      assert.ok(request.messages.some((message) => message.content === history[0]!.content));
      const system = request.messages[0]!.content;
      assert.ok(system.includes(`"responseLocale":"${locale}"`));
      assert.match(system, /"liveDownloadStatus":false/);
      assert.match(system, /Historical progress\/status is a past observation/);
      assert.equal(
        f.requests.slice(-2).some((item) => item.operation === 'assistant.download.plan'),
        false
      );
    }
  }
});

test('answering or clarifying a question retains a pending release and still permits a later explicit provider choice', async () => {
  const f = fixture();
  await f.send('下载星际穿越');
  f.action('select_resource', 2);
  await f.send('下载2');
  const pending = await f.state();
  for (const handling of ['answer', 'clarify'] as const) {
    f.handling(handling);
    await f.send(handling === 'answer' ? '刚才选了什么版本？' : '那个是什么意思？');
    assert.equal((await f.state())?.stage, 'await_provider');
    assert.deepEqual((await f.state())?.selection, pending?.selection);
    assert.equal(f.submissions.length, 0);
    assert.match(f.requests.at(-1)!.messages[0]!.content, /secret-release-title.2160p/);
  }
  f.handling('tool');
  f.action('select_provider', null, 'transmission');
  await f.send('使用 transmission');
  assert.equal(f.submissions.length, 1);
});

test('status and unsupported-operation answer actions generate a grounded reply without submitting or searching', async () => {
  for (const action of ['status', 'answer']) {
    const f = fixture(['qbittorrent']);
    await f.send('下载星际穿越');
    f.action('select_resource', 2);
    await f.send('下载2');
    const before = f.counts();
    f.handling('tool');
    f.action(action);
    assert.equal((await f.send(action === 'status' ? '现在多少了？' : '暂停刚才的任务')).replyText, 'Discussion reply');
    assert.equal(f.submissions.length, 1);
    assert.equal(f.counts().resourceCalls, before.resourceCalls);
    const system = f.requests.at(-1)!.messages[0]!.content;
    assert.match(system, /"historicalDownloadReplies":.*qbittorrent/);
    assert.match(system, /"currentStateVerified":false/);
    assert.match(system, /"pauseSubmittedDownload":false/);
  }
});

test('web download answers stay complete and replayable when streaming was requested', async () => {
  const f = fixture();
  f.handling('answer');
  const message = { ...input, channel: 'web' as const, text: '刚才用了哪个下载器？' };
  const result = await f.create().run(message, [], undefined, true);
  assert.equal(result.replyText, 'Discussion reply');
  assert.equal(result.intent, 'download');
  assert.equal(result.stream, undefined);
  const calls = f.counts().calls;
  assert.deepEqual(await f.create().run(message, [], undefined, true), result);
  assert.equal(f.counts().calls, calls);
  assert.equal(f.submissions.length, 0);
});

test('the configured default downloader is used after resource selection; explicit downloader choices still win', async () => {
  for (const explicit of [null, 'qbittorrent'] as const) {
    const f = fixture(['qbittorrent', 'transmission'], 'en-US', 'transmission');
    await f.send('Download Interstellar');
    assert.equal(f.submissions.length, 0);
    f.action('select_resource', 2, explicit);
    await f.send(explicit ? 'Download release 2 with qBittorrent' : 'Download release 2');
    assert.equal(f.submissions[0]?.release, 'release-2');
    assert.equal(f.submissions[0]?.provider, explicit ?? 'transmission');
    assert.equal((await f.state())?.stage, 'idle');
  }
});

test('assistant distinguishes two instances of the same downloader type', async () => {
  const instances: DownloaderChoice[] = [
    { downloaderInstanceId: '00000000-0000-4000-8000-000000000001', provider: 'qbittorrent', name: 'Home' },
    { downloaderInstanceId: '00000000-0000-4000-8000-000000000002', provider: 'qbittorrent', name: 'Seedbox' },
  ];
  const f = fixture(['qbittorrent'], 'en-US', undefined, instances);
  await f.send('Download Interstellar');
  f.action('select_resource', 2);
  const choice = await f.send('Download release 2');
  assert.match(choice.replyText, /Home/);
  assert.match(choice.replyText, /Seedbox/);
  assert.equal(f.submissions.length, 0);
  f.action('select_provider', null, '2');
  await f.send('Use the second downloader');
  assert.deepEqual(f.submissions, [{
    owner: 'alice', movie: 157336, release: 'release-2', provider: 'qbittorrent',
    downloaderInstanceId: instances[1]!.downloaderInstanceId,
  }]);
});
