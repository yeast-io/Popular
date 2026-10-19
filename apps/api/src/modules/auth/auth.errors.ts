

export class DuplicateEmailError extends Error {
  constructor() {
    super('Email is already registered');
    this.name = 'DuplicateEmailError';
  }
}
