import { z } from 'zod';

// Zod 4 tries `new Function("")` once to decide whether it may build faster parsers with eval.
// The renderer's Content Security Policy blocks that call and reports it as a violation, so the
// fast path is switched off. Parsing results do not change, only the speed of some schemas.
z.config({ jitless: true });
