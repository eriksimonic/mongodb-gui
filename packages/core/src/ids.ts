interface RandomUuidSource {
  randomUUID(): string;
}

export function newId(): string {
  return (globalThis as unknown as { crypto: RandomUuidSource }).crypto.randomUUID();
}
