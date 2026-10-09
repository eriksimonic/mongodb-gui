export interface RingBuffer<T extends { at: string }> {
  push(sample: T): void;
  toArray(): T[];
  // Samples recorded strictly after the given ISO time, oldest first.
  since(at: string): T[];
  latest(): T | undefined;
}

// Keeps samples whose `at` is within retentionMs of the newest pushed sample.
export function createRingBuffer<T extends { at: string }>(retentionMs: number): RingBuffer<T> {
  const samples: T[] = [];

  return {
    push(sample) {
      samples.push(sample);
      const cutoff = timeOf(sample.at) - retentionMs;
      let oldest = samples[0];
      while (oldest !== undefined && timeOf(oldest.at) < cutoff) {
        samples.shift();
        oldest = samples[0];
      }
    },
    toArray() {
      return [...samples];
    },
    since(at) {
      const threshold = timeOf(at);
      return samples.filter((sample) => timeOf(sample.at) > threshold);
    },
    latest() {
      return samples.at(-1);
    },
  };
}

function timeOf(iso: string): number {
  return Date.parse(iso);
}
