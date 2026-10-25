export class MovieReleaseCacheError extends Error {
  constructor(stage: 'read' | 'write', cause: unknown) {
    super(`Movie release cache ${stage} failed`, { cause });
    this.name = 'MovieReleaseCacheError';
  }
}
