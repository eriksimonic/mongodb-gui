// Checks the host list of a connection string before the driver sees it. The driver's topology
// monitor throws an unhandled error for some malformed lists, such as an empty entry after a
// comma. The problem text names the defect and never includes the URI.
const MAX_PORT = 65535;
const SCHEME = /^mongodb(\+srv)?:\/\//i;
const HOST_ENTRY = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/;

// Returns the first problem with the URI's host list, or undefined when the list is usable.
export function findHostListProblem(uri: string): string | undefined {
  const scheme = SCHEME.exec(uri);
  if (scheme === null) {
    return 'The connection string must start with mongodb:// or mongodb+srv://';
  }
  let authority = uri.slice(scheme[0].length);
  const pathStart = authority.search(/[/?]/);
  if (pathStart !== -1) {
    authority = authority.slice(0, pathStart);
  }
  const userInfoEnd = authority.lastIndexOf('@');
  if (userInfoEnd !== -1) {
    authority = authority.slice(userInfoEnd + 1);
  }
  for (const entry of authority.split(',')) {
    const problem = hostEntryProblem(entry);
    if (problem !== undefined) {
      return problem;
    }
  }
  return undefined;
}

function hostEntryProblem(entry: string): string | undefined {
  const match = HOST_ENTRY.exec(entry);
  const name = match?.[1] ?? '';
  const port = match?.[2];
  if (name === '' || name === '[]') {
    return 'The connection string lists an empty host';
  }
  if (port !== undefined && !isValidPort(port)) {
    return 'The connection string lists an invalid port';
  }
  return undefined;
}

function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) {
    return false;
  }
  const value = Number(port);
  return value >= 1 && value <= MAX_PORT;
}
