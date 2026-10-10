import { join } from 'node:path';

export type ToolName = 'mongodump' | 'mongorestore';

export interface ToolsRootsInput {
  readonly isPackaged: boolean;
  // process.resourcesPath in a packaged app.
  readonly resourcesPath: string;
  // The packages/app folder in development.
  readonly appRoot: string;
  readonly userDataDir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

export interface ToolsRoots {
  // The install shipped with the app. It may not exist, for example on macOS.
  readonly bundled: string;
  // Holds one folder per downloaded version, plus staging folders and partial downloads.
  readonly downloaded: string;
  // Holds the private tools-<uuid> folders with the temporary config files.
  readonly tmp: string;
}

export function toolsRoots(input: ToolsRootsInput): ToolsRoots {
  const bundled = input.isPackaged
    ? join(input.resourcesPath, 'mongo-tools')
    : join(input.appRoot, 'resources', 'mongo-tools', `${input.platform}-${input.arch}`);
  return {
    bundled,
    downloaded: join(input.userDataDir, 'mongo-tools'),
    tmp: join(input.userDataDir, 'tmp'),
  };
}

export function binaryName(tool: ToolName, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${tool}.exe` : tool;
}
