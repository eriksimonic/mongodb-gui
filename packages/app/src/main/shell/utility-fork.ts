import { utilityProcess } from 'electron';
import { fromUtilityProcess, utilityForkOptions, type ForkFunction } from './child';

// Starts one shell runtime as an Electron utility process. The environment, the heap cap and the
// ignored output come from child.ts, so the process never sees the main process environment.
export const utilityFork: ForkFunction = (request) =>
  fromUtilityProcess(utilityProcess.fork(request.entryPath, [], utilityForkOptions(request)));
