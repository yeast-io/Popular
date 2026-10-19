

export type Cleanup = { name: string; order: number; close: () => void | Promise<void> };
