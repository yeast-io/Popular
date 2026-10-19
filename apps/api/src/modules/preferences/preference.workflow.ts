import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { applyProposal } from './preference.domain.js';
import type { PreferenceAgent } from './agents/preference.agent.js';
import type { PreferenceEnricher, PreferenceJob, PreferenceStore } from './preference.types.js';

/** One maintenance attempt. Scheduling, leases, deadlines and retries belong to the worker. */
export class PreferenceWorkflow {
  constructor(
    private readonly store: PreferenceStore,
    private readonly agent: Pick<PreferenceAgent, 'run'>,
    private readonly enrich?: PreferenceEnricher
  ) {}

  async run(job: PreferenceJob, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (
      await aiStep('preference.profile.check_applied', () => {
        return this.store.applied(job.ownerId, job.id);
      })
    )
      return true;
    const profile = await aiStep('preference.profile.read', () => this.store.read(job.ownerId));
    for (const entry of profile.entries) currentAiTrace()?.sensitive(entry.content);
    if (job.kind === 'chat' && !profile.autoMaintain) return true;
    const evidenceJob =
      this.enrich && job.kind === 'manual'
        ? await aiStep('preference.evidence.enrich', () => {
            return this.enrich!(job, signal);
          })
        : job;
    signal.throwIfAborted();
    for (const item of evidenceJob.evidence) currentAiTrace()?.sensitive(item.text);
    const proposal = await aiStep('preference.agent.run', () => {
      return this.agent.run(evidenceJob, profile, signal);
    });
    for (const change of proposal.changes) {
      currentAiTrace()?.sensitive(change.content);
      currentAiTrace()?.sensitive(change.reason);
    }
    signal.throwIfAborted();
    const next = await aiStep('preference.proposal.apply', async () => {
      return applyProposal(
        profile,
        proposal,
        job.evidence.map((item) => item.ref),
        job.kind,
        job.id,
      );
    });
    if (job.kind === 'manual') {
      next.generatedAt = new Date().toISOString();
      next.generatedFingerprint = job.fingerprint;
    }
    if (!(await aiStep('preference.task.check_lease', () => this.store.owns(job)))) return false;
    await aiStep('preference.profile.save', async () => {
      if (!(await this.store.save(job.ownerId, profile.version, next, job.id)))
        throw new Error('Preference version conflict');
    });
    return true;
  }
}
