import type { ProfileEntry } from '@mongo-gui/core';
import { createUiEventBus } from '../kit/event-bus';

export interface ProfilerEntryRef {
  readonly connectionId: string;
  readonly database: string;
  readonly entry: ProfileEntry;
  /** The command in canonical extended JSON, without the driver's session fields. */
  readonly command: unknown;
}

/**
 * UI-level events from the profiler. The app store bridge subscribes to them.
 */
export type ProfilerUiEvent = { readonly type: 'profiler:explain'; readonly ref: ProfilerEntryRef };

export const profilerUiEvents = createUiEventBus<ProfilerUiEvent>('profiler');
