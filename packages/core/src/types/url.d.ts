/**
 * The part of the WHATWG URL class that the core package uses. The runtime class comes from
 * Node or the browser. Core has no DOM lib, so the shape is declared here.
 */
export interface ParsedUrl {
  readonly href: string;
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly username: string;
  readonly password: string;
  readonly pathname: string;
}

export interface ParsedUrlConstructor {
  new (input: string, base?: string): ParsedUrl;
}
