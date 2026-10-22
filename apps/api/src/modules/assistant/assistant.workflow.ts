import type { AssistantSession } from './assistant-session.types.js';
import type { DownloaderChoice } from '@movie-hub/contract';
import type { AssistantDownloadAction, AssistantWorkflowTurn } from './assistant-workflow.types.js';
import { RESOURCE_PAGE_SIZE } from '../resource-query/resource-query.presentation.js';
import { buildAssistantPreferenceContext } from '../../config/system-prompts/assistant.prompts.js';
import { profileText } from '../preferences/preference.domain.js';
import { assistantText, downloadProvidersText, downloadSubmittedText } from './assistant.presentation.js';
import { randomUUID } from 'node:crypto';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { AiTrace, aiStep, currentAiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { LlmClient, LlmMessage } from '../llm/llm.types.js';
import { RESOURCE_SESSION_MS } from '../resource-query/resource-query.domain.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { AssistantAgent } from './agents/assistant.agent.js';
import { AssistantInputSchema } from './assistant.schema.js';
import { ASSISTANT_SESSION_MS, emptyAssistantSession } from './assistant-session.domain.js';
import type {
  AssistantRequestClassification,
  AssistantInputWorkflowMessage,
  AssistantWorkflowContract,
  AssistantWorkflowOptions,
  AssistantWorkflowResult,
  AssistantIntent,
} from './assistant.types.js';

const GraphState = Annotation.Root({
  classification: Annotation<AssistantRequestClassification>(),
  intent: Annotation<AssistantIntent>(),
  ambiguousTasks: Annotation<boolean>(),
  resumeSubmission: Annotation<boolean>(),
  action: Annotation<AssistantDownloadAction>(),
  result: Annotation<AssistantWorkflowResult>(),
});

/** The graph owns conversational transitions; tools own resource lookup and download side effects. */
export class AssistantWorkflow implements AssistantWorkflowContract {
  constructor(
    private readonly createLlm: (
      ownerId: string
    ) => Promise<Pick<LlmClient, 'generate'> & Partial<Pick<LlmClient, 'stream'>>>,
    private readonly options: AssistantWorkflowOptions
  ) {}

  async run(
    raw: AssistantInputWorkflowMessage,
    history: LlmMessage[] = [],
    signal?: AbortSignal,
    streamDiscussion = false
  ): Promise<AssistantWorkflowResult> {
    const input = AssistantInputSchema.parse(raw);
    signal?.throwIfAborted();
    const trace = new AiTrace(
      this.options.diagnostics?.logger,
      {
        correlationId: currentAiTrace()?.correlationId ?? randomUUID(),
        ownerId: input.ownerId,
        eventId: `${input.channel}:${input.chatId}:${input.messageId}`,
      },
      input.text,
      'assistant.workflow',
      this.options.diagnostics?.verbose ?? false
    );
    for (const message of history) trace.sensitive(message.content);
    return withAiTrace(trace, async () => {
      try {
        const result = await aiStep('assistant.workflow', () => this.execute(input, history, signal, streamDiscussion));
        trace.event('assistant.workflow.completed', { outcome: 'success', intent: result.intent });
        return result;
      } catch (error) {
        trace.fail(error);
        throw error;
      }
    });
  }

  private async execute(
    input: AssistantInputWorkflowMessage,
    history: LlmMessage[],
    signal: AbortSignal | undefined,
    streamDiscussion: boolean
  ): Promise<AssistantWorkflowResult> {
    const conversation = `${input.channel}:${input.chatId}`;
    const eventId = `${conversation}:${input.messageId}`;
    const store = this.options.sessions;
    if (this.options.downloads && (!store || !this.options.resources?.context))
      throw new Error('Downloads require durable workflow sessions and resource context');
    const leaseId = randomUUID();
    let acquired = false;
    try {
      if (store) {
        await aiStep('assistant.session.ensure', () => store.ensure(input.ownerId, conversation));
        acquired = await aiStep('assistant.session.acquire', () => store.acquire(input.ownerId, conversation, leaseId));
        if (!acquired) throw new Error('Assistant workflow conversation is busy');
      }
      const previous = store
        ? await aiStep('assistant.session.read', () => {
            return store.read(input.ownerId, conversation);
          })
        : null;
      const replay = previous?.events.find((event) => event.id === eventId);
      if (replay) return this.format(input, { intent: replay.intent, replyText: replay.replyText });
      const session
        = previous && Date.now() - Date.parse(previous.updatedAt) < ASSISTANT_SESSION_MS
          ? previous
          : emptyAssistantSession();
      session.events = previous?.events ?? [];
      if (session.selection) currentAiTrace()?.sensitive(session.selection.title);
      // Persisted submission checkpoint survives a process crash; replay only the same authorized message.
      if (previous?.stage === 'submitting' && previous.submissionEventId === eventId) Object.assign(session, previous);
      const executionSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000);
      const save = async () => {
        session.updatedAt = new Date().toISOString();
        if (
          store
          && !(await aiStep('assistant.session.save', () => store.save(input.ownerId, conversation, leaseId, session)))
        )
          throw new Error('Assistant workflow lease lost');
      };
      const llm = await aiStep('assistant.credentials.load', () => this.createLlm(input.ownerId));
      const agent = new AssistantAgent(llm, {
        systemPrompt: this.options.systemPrompt,
        maxContextTokens: this.options.maxContextTokens,
        maxOutputTokens: this.options.maxOutputTokens,
      });
      const turn: AssistantWorkflowTurn = {
        locale: session.locale ?? this.options.locale ?? 'zh-CN',
        input,
        conversation,
        eventId,
        session,
        save,
        agent,
        history,
        signal: executionSignal,
      };
      const graph = new StateGraph(GraphState)
        .addNode('classify_request', async () => {
          return {
            classification: await aiStep('assistant.request.classify', () => {
              return agent.classifyRequest(input, history, executionSignal);
            }),
          };
        })
        .addNode('record_preference', async (state) => {
          turn.locale = state.classification.locale ?? session.locale ?? this.options.locale ?? 'zh-CN';
          session.locale = turn.locale;
          await this.preference(input, state.classification, history);
          return {};
        })
        .addNode('plan_download_action', async () => {
          const context
            = session.stage === 'idle' || session.stage === 'await_resource'
              ? await aiStep('assistant.download.context', () => {
                  return this.options.resources!.context!(input.ownerId, conversation);
                })
              : null;
          executionSignal.throwIfAborted();
          const hasSnapshot = Boolean(
            context?.movie
            && context.snapshot
            && Date.now() - Date.parse(context.snapshot.createdAt) < RESOURCE_SESSION_MS
          );
          const releaseCount = hasSnapshot ? context!.releases.length : 0;
          currentAiTrace()?.event('assistant.download.context.loaded', {
            sessionStage: session.stage,
            hasSnapshot,
            releaseCount,
            outcome: 'success',
          }
          );
          const action = await aiStep('assistant.download.plan', () => {
            return agent.planDownload(
              input,
              history,
              {
                stage: session.stage,
                providers: session.providers ?? [],
                hasSelection: Boolean(session.selection),
                resources: {
                  hasSnapshot,
                  releaseCount,
                  page: hasSnapshot ? (context!.page ?? 1) : 1,
                  pageCount: Math.ceil(releaseCount / RESOURCE_PAGE_SIZE),
                },
              },
              executionSignal
            );
          });
          currentAiTrace()?.event('assistant.download.action.selected', {
            action: action.action,
            releaseIndex: action.releaseIndex,
            provider: action.provider,
            outcome: 'success',
          }
          );
          return { action };
        })
        .addNode('discuss', async () => ({ result: await this.discuss(turn, streamDiscussion) }))
        .addNode('answer_request', async (state) => {
          return {
            result: {
              ...(await this.discuss(turn, streamDiscussion && state.classification.intent === 'discuss')),
              intent: state.classification.intent,
            },
          };
        })
        .addNode('recommend_movies', async () => ({ result: await this.recommendMovies(turn) }))
        .addNode('query_resources', async (state) => {
          return { result: await this.queryResources(turn, state.action?.action === 'query') };
        })
        .addNode('clarify_request', (state) => {
          return { result: this.clarifyRequest(turn, state.intent, state.ambiguousTasks) };
        })
        .addNode('select_resource', async (state) => {
          const result = await this.selectResource(turn, state.action);
          return result ? { result } : {};
        })
        .addNode('select_provider', async (state) => {
          const result = await this.selectProvider(turn, state.action);
          return result ? { result } : {};
        })
        .addNode('retry_submission', async () => {
          if (!session.selection || !session.provider)
            return { result: this.downloadReply(assistantText(turn.locale, 'noRetry')) };
          session.stage = 'submitting';
          session.submissionEventId = eventId;
          return {};
        })
        .addNode('submit_download', async () => ({ result: await this.submitDownload(turn) }))
        .addNode('cancel_download', async () => {
          this.reset(session);
          return { result: this.downloadReply(assistantText(turn.locale, 'cancelled')) };
        })
        .addNode('clarify_download', () => {
          return {
            result: this.downloadReply(
              session.stage === 'await_provider'
                ? downloadProvidersText(turn.locale, session.selection?.title ?? '', session.providers ?? [])
                : assistantText(turn.locale, 'clarify')
            ),
          };
        })
        .addNode('resolve_route', async (state) => {
          return aiStep('assistant.route.resolve', () => {
            return this.resolveRoute(
              turn,
              state.classification.intent,
              state.action?.action === 'other',
              state.classification.handling
            );
          });
        })
        .addEdge(START, 'classify_request')
        .addEdge('classify_request', 'record_preference')
        .addEdge('record_preference', 'resolve_route')
        .addConditionalEdges(
          'plan_download_action',
          (state) => {
            return {
              query: 'query_resources',
              select_resource: 'select_resource',
              select_provider: 'select_provider',
              cancel: 'cancel_download',
              retry: 'retry_submission',
              status: 'answer_request',
              answer: 'answer_request',
              other: 'resolve_route',
              clarify: 'clarify_download',
            }[state.action.action];
          },
          [
            'query_resources',
            'select_resource',
            'select_provider',
            'cancel_download',
            'retry_submission',
            'clarify_download',
            'answer_request',
            'resolve_route',
          ]
        )
        .addConditionalEdges(
          'resolve_route',
          (state) => {
            currentAiTrace()?.event('assistant.route.selected', {
              intent: state.intent,
              handling: state.classification.handling,
              resumeSubmission: state.resumeSubmission,
              ambiguousTasks: state.ambiguousTasks,
              outcome: 'success',
            }
            );
            if (state.resumeSubmission) return 'submit_download';
            if (state.classification.handling === 'answer' || state.classification.handling === 'clarify')
              return 'answer_request';
            if (state.intent === 'download' && this.options.downloads) return 'plan_download_action';
            if (state.intent === 'discuss') return 'discuss';
            if (state.intent === 'recommend' && this.options.recommendations) return 'recommend_movies';
            if (state.intent === 'resources' && this.options.resources) return 'query_resources';
            if (state.intent !== 'unclear') return 'answer_request';
            return 'clarify_request';
          },
          [
            'submit_download',
            'plan_download_action',
            'discuss',
            'recommend_movies',
            'query_resources',
            'clarify_request',
            'answer_request',
          ]
        )
        .addConditionalEdges(
          'select_resource',
          (state) => {
            return state.result ? END : 'submit_download';
          },
          [END, 'submit_download']
        )
        .addConditionalEdges(
          'select_provider',
          (state) => {
            return state.result ? END : 'submit_download';
          },
          [END, 'submit_download']
        )
        .addConditionalEdges(
          'retry_submission',
          (state) => {
            return state.result ? END : 'submit_download';
          },
          [END, 'submit_download']
        )
        .addEdge('query_resources', END)
        .addEdge('submit_download', END)
        .addEdge('cancel_download', END)
        .addEdge('clarify_download', END)
        .addEdge('clarify_request', END)
        .addEdge('discuss', END)
        .addEdge('answer_request', END)
        .addEdge('recommend_movies', END)
        .compile();
      const { result } = await graph.invoke({}, { signal: executionSignal, recursionLimit: 12 });
      const formatted = this.format(input, result);
      currentAiTrace()?.sensitive(formatted.replyText);
      if (result.intent === 'download')
        session.events = [
          ...session.events,
          { id: eventId, replyText: formatted.replyText, intent: 'download' as const },
        ].slice(-20);
      await save();
      return formatted;
    } finally {
      if (acquired) {
        try {
          await aiStep('assistant.session.release', () => store!.release(input.ownerId, conversation, leaseId));
        } catch (error) {
          currentAiTrace()?.fail(error, { stage: 'assistant.session.release' });
          // Lease expiry releases the lock; a cleanup failure must not replay a completed side effect.
        }
      }
    }
  }

  private async resolveRoute(
    turn: AssistantWorkflowTurn,
    requested: AssistantIntent,
    leavingDownload: boolean,
    handling?: AssistantRequestClassification['handling']
  ): Promise<{ intent: AssistantIntent; ambiguousTasks: boolean; resumeSubmission: boolean }> {
    turn.signal.throwIfAborted();
    if (leavingDownload) this.reset(turn.session);
    // Recover the same authorized submission before planning any new response.
    if (
      this.options.downloads
      && turn.session.stage === 'submitting'
      && turn.session.submissionEventId === turn.eventId
    )
      return { intent: 'download', ambiguousTasks: false, resumeSubmission: true };
    if (handling === 'answer' || handling === 'clarify')
      return { intent: requested, ambiguousTasks: false, resumeSubmission: false };
    // Pending stages guide tool continuations, but must not intercept information questions.
    if (!leavingDownload && this.options.downloads && (turn.session.stage !== 'idle' || requested === 'download'))
      return { intent: 'download', ambiguousTasks: false, resumeSubmission: false };
    // Never send an explicit exit back into download planning when model decisions disagree.
    if (leavingDownload && requested === 'download')
      return { intent: 'unclear', ambiguousTasks: false, resumeSubmission: false };
    if (requested !== 'unclear') return { intent: requested, ambiguousTasks: false, resumeSubmission: false };
    const { ownerId } = turn.input;
    const [resources, recommendations] = await Promise.all([
      aiStep('assistant.route.resources.active', async () => {
        return Boolean(await this.options.resources?.active(ownerId, turn.conversation));
      }),
      aiStep('assistant.route.recommendations.active', async () => {
        return Boolean(await this.options.recommendations?.active(ownerId, turn.conversation));
      }),
    ]);
    turn.signal.throwIfAborted();
    return {
      intent: resources === recommendations ? 'unclear' : resources ? 'resources' : 'recommend',
      ambiguousTasks: resources && recommendations,
      resumeSubmission: false,
    };
  }

  private clarifyRequest(
    turn: AssistantWorkflowTurn,
    intent: AssistantIntent,
    ambiguousTasks: boolean
  ): AssistantWorkflowResult {
    const key = ambiguousTasks
      ? 'ambiguousTasks'
      : intent === 'recommend'
        ? 'recommendUnavailable'
        : intent === 'resources'
          ? 'resourcesUnavailable'
          : intent === 'download'
            ? 'downloadUnavailable'
            : 'unclear';
    return { intent, replyText: assistantText(turn.locale, key) };
  }

  private async discuss(turn: AssistantWorkflowTurn, streaming: boolean): Promise<AssistantWorkflowResult> {
    const { input, history, agent, signal } = turn;
    let context = '';
    const profileStore = this.options.preferences?.store;
    if (profileStore) {
      const profile = await aiStep('assistant.profile.read', () => profileStore.read(input.ownerId));
      const text = profileText(profile);
      currentAiTrace()?.sensitive(text);
      if (profile.entries.length) context = buildAssistantPreferenceContext(text);
    }
    signal.throwIfAborted();
    const responseContext = JSON.stringify({
      responseLocale: turn.locale,
      capabilities: {
        resourceLookup: Boolean(this.options.resources),
        movieRecommendations: Boolean(this.options.recommendations),
        submitDownload: Boolean(this.options.downloads),
        liveDownloadStatus: false,
        pauseSubmittedDownload: false,
        deleteSubmittedDownload: false,
        cancelPendingSelection: Boolean(this.options.downloads),
      },
      pendingDownload: {
        stage: turn.session.stage,
        selectedRelease: turn.session.selection?.title,
        selectedProvider: turn.session.provider,
        offeredProviders: turn.session.providers,
      },
      historicalDownloadReplies: turn.session.events.slice(-3).map((event) => {
        return {
          reply: event.replyText.slice(0, 1_800),
          currentStateVerified: false,
        };
      }),
    });
    if (streaming && input.channel === 'web')
      return {
        intent: 'discuss',
        replyText: '',
        stream: agent.streamDiscuss(input, history, signal, context, responseContext),
      };
    return aiStep('assistant.discuss', () => agent.discuss(input, history, signal, context, responseContext));
  }

  private async recommendMovies(turn: AssistantWorkflowTurn): Promise<AssistantWorkflowResult> {
    const { input, conversation, eventId, agent, history, signal } = turn;
    signal.throwIfAborted();
    try {
      const result = await aiStep('assistant.tool.recommendations', () => {
        return this.options.recommendations!.runResult(
          input.ownerId,
          conversation,
          eventId,
          input.text,
          history,
          { plan: agent.planRecommendation.bind(agent), rank: agent.rankRecommendations.bind(agent) },
          signal,
          turn.locale
        );
      });
      return { ...result, intent: 'recommend' };
    } catch (error) {
      // The tool records the original error with its model/provider redaction context.
      currentAiTrace()?.event('assistant.tool.recommendations.failed', { outcome: 'failure' });
      currentAiTrace()?.clearFailure();
      if (signal.aborted) throw error;
      return { intent: 'recommend', replyText: assistantText(turn.locale, 'recommendationFailed') };
    }
  }

  private async queryResources(turn: AssistantWorkflowTurn, forDownload: boolean): Promise<AssistantWorkflowResult> {
    const { input, conversation, eventId, agent, history, signal, session } = turn;
    const intent = forDownload ? 'download' : 'resources';
    signal.throwIfAborted();
    if (forDownload) {
      // Reset the pinned choice before changing the movie/list, retaining the download goal.
      this.reset(session);
      session.stage = 'await_movie';
      await turn.save();
    }
    let result: { replyText: string };
    try {
      result = await aiStep(
        'assistant.tool.resources',
        () => {
          return this.options.resources!.run(
            input.ownerId,
            conversation,
            eventId,
            input.text,
            history,
            { plan: agent.planResources.bind(agent) },
            signal,
            turn.locale
          );
        },
        { intent }
      );
    } catch (error) {
      // The tool records the original error with its model/provider redaction context.
      currentAiTrace()?.event('assistant.tool.resources.failed', { outcome: 'failure' });
      currentAiTrace()?.clearFailure();
      if (signal.aborted) throw error;
      return { intent, replyText: assistantText(turn.locale, 'resourcesFailed') };
    }
    if (!forDownload) return { ...result, intent };
    const context = await aiStep('assistant.download.context', () => {
      return this.options.resources!.context!(input.ownerId, conversation);
    });
    session.stage = context?.movie ? 'await_resource' : 'await_movie';
    return this.downloadReply(
      `${result.replyText}${context?.releases.length ? '\n' + assistantText(turn.locale, 'selectRelease') : ''}`
    );
  }

  private async selectResource(
    turn: AssistantWorkflowTurn,
    action: AssistantDownloadAction
  ): Promise<AssistantWorkflowResult | undefined> {
    const { session, input, conversation } = turn;
    if (session.stage === 'await_movie') return this.downloadReply(assistantText(turn.locale, 'selectMovie'));
    const context = await aiStep('assistant.download.snapshot', () => {
      return this.options.resources!.context!(input.ownerId, conversation);
    });
    if (
      !context?.snapshot
      || Date.now() - Date.parse(context.snapshot.createdAt) >= RESOURCE_SESSION_MS
      || !context.movie
    ) {
      this.reset(session);
      session.stage = 'await_movie';
      return this.downloadReply(assistantText(turn.locale, 'expired'));
    }
    const release = action.releaseIndex === null ? undefined : context.releases[action.releaseIndex - 1];
    if (!release)
      return this.downloadReply(assistantText(turn.locale, 'invalidIndex', { count: context.releases.length }));
    if (release.provider !== 'mteam') return this.downloadReply(assistantText(turn.locale, 'unsupportedSource'));
    session.selection = {
      tmdbId: context.movie.tmdbId,
      source: release.provider,
      releaseId: release.id,
      title: release.title,
      selectedAt: new Date().toISOString(),
    };
    currentAiTrace()?.sensitive(release.title);
    delete session.provider;
    session.providers = await aiStep('assistant.download.providers', async () => {
      if (this.options.downloads!.instancesFor) return this.options.downloads!.instancesFor(input.ownerId);
      return (await this.options.downloads!.providersFor(input.ownerId)).map((provider) => ({ downloaderInstanceId: provider, provider, name: provider }));
    });
    session.stage = 'await_provider';
    const preferred = action.provider ?? (await aiStep('assistant.download.default', async () => {
      return (await this.options.downloads!.defaultInstanceFor?.(input.ownerId))?.downloaderInstanceId
        ?? await this.options.downloads!.defaultProviderFor?.(input.ownerId);
    }));
    const selected = preferred ? resolveDownloader(session.providers, preferred) : undefined;
    if (selected) session.provider = selected.downloaderInstanceId;
    else if (session.providers.length === 1) session.provider = session.providers[0]!.downloaderInstanceId;
    else
      return this.downloadReply(
        downloadProvidersText(turn.locale, session.selection?.title ?? '', session.providers ?? [])
      );
    session.stage = 'submitting';
    session.submissionEventId = turn.eventId;
    return undefined;
  }

  private async selectProvider(
    turn: AssistantWorkflowTurn,
    action: AssistantDownloadAction
  ): Promise<AssistantWorkflowResult | undefined> {
    const { session } = turn;
    if (!session.selection || session.stage !== 'await_provider')
      return this.downloadReply(assistantText(turn.locale, 'selectFirst'));
    // Re-read configuration; the offered list is context, never authority to use a removed downloader.
    session.providers = await aiStep('assistant.download.providers', async () => {
      if (this.options.downloads!.instancesFor) return this.options.downloads!.instancesFor(turn.input.ownerId);
      return (await this.options.downloads!.providersFor(turn.input.ownerId)).map((provider) => ({ downloaderInstanceId: provider, provider, name: provider }));
    });
    const selected = action.provider ? resolveDownloader(session.providers, action.provider) : undefined;
    if (!selected)
      return this.downloadReply(
        downloadProvidersText(turn.locale, session.selection?.title ?? '', session.providers ?? [])
      );
    session.provider = selected.downloaderInstanceId;
    session.stage = 'submitting';
    session.submissionEventId = turn.eventId;
    return undefined;
  }

  private async submitDownload(turn: AssistantWorkflowTurn): Promise<AssistantWorkflowResult> {
    const { session, signal } = turn;
    if (!session.selection || !session.provider)
      throw new Error('Download submission requires a pinned release and downloader');
    signal.throwIfAborted();
    // A durable checkpoint precedes the external side effect. Retries reuse the selected IDs and service claim.
    await turn.save();
    const selection = session.selection;
    currentAiTrace()?.sensitive(selection.title);
    try {
      const downloader = (await this.options.downloads!.instancesFor?.(turn.input.ownerId))?.find((choice) => choice.downloaderInstanceId === session.provider);
      if (this.options.downloads!.instancesFor && !downloader)
        throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', 'Selected downloader is unavailable');
      const provider = downloader?.provider ?? (session.provider as 'qbittorrent' | 'transmission');
      const result = await aiStep(
        'assistant.download.submit',
        () => {
          return this.options.downloads!.createForOwner(
            turn.input.ownerId,
            selection.tmdbId,
            selection.releaseId,
            provider,
            'mteam',
            downloader?.downloaderInstanceId
          );
        },
        { provider, tmdbId: selection.tmdbId }
      );
      this.reset(session);
      currentAiTrace()?.event('assistant.download.submitted', { taskId: result.id, provider, outcome: result.status });
      return this.downloadReply(downloadSubmittedText(turn.locale, result));
    } catch (error) {
      currentAiTrace()?.fail(error, { stage: 'assistant.download.submit' });
      currentAiTrace()?.clearFailure();
      if (signal.aborted) throw error;
      const code = error instanceof AppError ? error.code : 'DOWNLOAD_SUBMISSION_FAILED';
      // Keep the pinned selection for an explicit retry. Never fail over to another downloader.
      return this.downloadReply(assistantText(turn.locale, 'failed', { code }));
    }
  }

  private reset(session: AssistantSession): void {
    session.stage = 'idle';
    delete session.selection;
    delete session.providers;
    delete session.provider;
    delete session.submissionEventId;
  }

  private downloadReply(replyText: string): AssistantWorkflowResult {
    return { intent: 'download', replyText };
  }

  private format(input: AssistantInputWorkflowMessage, result: AssistantWorkflowResult): AssistantWorkflowResult {
    if (!result?.replyText?.trim() && !result?.stream) throw new Error('Assistant returned an empty reply');
    const resourceReply = result.intent === 'resources' || result.intent === 'download';
    if (resourceReply && result.replyText.length > 4_000)
      throw new Error('Resource reply exceeds the messaging text limit');
    const movies = input.channel === 'web' ? undefined : result.movies;
    const replyText
      = input.channel === 'web' || movies?.length || resourceReply
        ? result.replyText
        : [...result.replyText].slice(0, 1_800).join('');
    return {
      replyText,
      ...(result.intent ? { intent: result.intent } : {}),
      ...(movies?.length ? { movies } : {}),
      ...(result.stream ? { stream: result.stream } : {}),
    };
  }

  private async preference(
    input: AssistantInputWorkflowMessage,
    detected: AssistantRequestClassification,
    history: LlmMessage[]
  ): Promise<void> {
    if (detected.preferenceSignal !== 'explicit' || !this.options.preferences) return;
    try {
      await aiStep('assistant.preference.enqueue', () => {
        return this.options.preferences!.chatEvidence(
          input.ownerId,
          `${input.channel}:${input.chatId}:${input.messageId}`,
          input.text,
          history.map((message) => `${message.role}: ${message.content}`)
        );
      });
    } catch (error) {
      currentAiTrace()?.fail(error, { stage: 'assistant.preference.enqueue' });
      currentAiTrace()?.clearFailure();
      this.options.report?.('preference_enqueue_failed');
    }
  }
}

function resolveDownloader(choices: DownloaderChoice[], requested: string): DownloaderChoice | undefined {
  const direct = choices.find((choice) => choice.downloaderInstanceId === requested);
  if (direct) return direct;
  const byName = choices.filter((choice) => choice.name.toLocaleLowerCase() === requested.toLocaleLowerCase());
  if (byName.length === 1) return byName[0];
  const byProvider = choices.filter((choice) => choice.provider === requested);
  if (byProvider.length === 1) return byProvider[0];
  const index = Number(requested);
  return Number.isInteger(index) && index >= 1 && index <= choices.length ? choices[index - 1] : undefined;
}
