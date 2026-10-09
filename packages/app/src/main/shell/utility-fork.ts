import { utilityProcess } from 'electron';
import { fromUtilityProcess, type ForkFunction } from './child';

// Starts one shell runtime as an Electron utility process. The environment and the heap cap come
// from the supervisor, so the process never sees the main process environment.
export const utilityFork: ForkFunction = (request) =>
  fromUtilityProcess(
    utilityProcess.fork(request.entryPath, [], {
      env: { ...request.env },
      execArgv: [...request.execArgv],
      serviceName: request.serviceName,
    }),
  );
