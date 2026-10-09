// The editor core and only the parts the JSON editors use. The full `monaco-editor` entry bundles
// every language and contribution, which made the renderer several megabytes larger.
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/language/json/monaco.contribution';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/folding/browser/folding';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController';
import { loader } from '@monaco-editor/react';
// Vite bundles each worker as its own file, so the Electron CSP only needs worker-src blob:
// and no script loads from a CDN.
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';

Object.assign(globalThis, {
  MonacoEnvironment: {
    getWorker(_workerId: string, label: string): Worker {
      return label === 'json' ? new jsonWorker() : new editorWorker();
    },
  },
});

// The default loader fetches Monaco from a CDN. Handing it the bundled instance keeps the
// editor offline and inside the app's Content Security Policy.
loader.config({ monaco });
