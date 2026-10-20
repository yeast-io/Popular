export function replacementSecret(value: string, savedMask?: string): string | undefined {
  return value && value !== savedMask ? value : undefined;
}
