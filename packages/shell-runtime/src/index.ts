import { corePackageName } from '@mongo-gui/core';
import { mongoAdapterPackageName } from '@mongo-gui/mongo-adapter';

export const shellRuntimePackageName = '@mongo-gui/shell-runtime';

export const shellRuntimeDependencies = [corePackageName, mongoAdapterPackageName] as const;

export { ShellProcessClient, type ForkFunction, type ShellChild } from './client';
