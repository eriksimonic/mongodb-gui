import { corePackageName } from '@mongo-gui/core';
import { mongoAdapterPackageName } from '@mongo-gui/mongo-adapter';
import { shellRuntimePackageName } from '@mongo-gui/shell-runtime';
import { storagePackageName } from '@mongo-gui/storage';
import { uiPackageName } from '@mongo-gui/ui';

export const appPackageName = '@mongo-gui/app';

export function workspacePackageNames(): readonly string[] {
  return [
    corePackageName,
    mongoAdapterPackageName,
    shellRuntimePackageName,
    storagePackageName,
    uiPackageName,
    appPackageName,
  ];
}
