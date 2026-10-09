// Typing for the one form of Vite's import.meta.glob that the explain fixture tests use. Core does
// not depend on vite, so the signature is declared here instead of imported. This file has no
// imports or exports, so the declaration is global.
interface ImportMeta {
  glob<T>(pattern: string, options: { eager: true; import: 'default' }): Record<string, T>;
}
