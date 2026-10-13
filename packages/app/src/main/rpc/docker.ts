import { appError, AppErrorException, rpcContract, type RpcEvent } from '@mongo-gui/core';
import type { DockerRuntime } from '../docker/runtime';
import { entry, type Operation } from './operation';

export interface DockerDeps {
  /** Local Docker discovery and forwarders. Calls to the docker namespace fail without it. */
  readonly docker: DockerRuntime | undefined;
  readonly emit: (event: RpcEvent) => void;
}

/** Returns the Docker runtime, or fails with INTERNAL when Docker support is not wired in. */
export function requireDocker(runtime: DockerRuntime | undefined): DockerRuntime {
  if (runtime === undefined) {
    throw new AppErrorException(appError('INTERNAL', 'Docker support is not available.'));
  }
  return runtime;
}

export function dockerOperations(deps: DockerDeps): [string, Operation][] {
  const docker = (): DockerRuntime => requireDocker(deps.docker);
  return [
    entry('docker.status', rpcContract.docker.status, () => docker().status()),
    entry('docker.list', rpcContract.docker.list, () => docker().list()),
    entry('docker.connect', rpcContract.docker.connect, (input) =>
      docker().connect(input.containerId),
    ),
    entry('docker.connectWithCredentials', rpcContract.docker.connectWithCredentials, (input) =>
      docker().connectWithCredentials(input),
    ),
    entry('docker.disconnect', rpcContract.docker.disconnect, (input) =>
      docker().disconnect(input.containerId),
    ),
    entry('docker.setAutoConnect', rpcContract.docker.setAutoConnect, (input) =>
      docker().setAutoConnect(input.enabled),
    ),
    entry('docker.watch', rpcContract.docker.watch, (input) => {
      docker().watch(input.enabled, deps.emit);
    }),
  ];
}
