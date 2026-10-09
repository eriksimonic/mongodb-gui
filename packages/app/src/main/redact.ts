import { redactUri } from '@mongo-gui/core';

const EMBEDDED_URI = /mongodb(?:\+srv)?:\/\/\S+/gi;

/**
 * Masks the password in every MongoDB URI found inside free text. redactUri alone only
 * masks a string that starts with the scheme, and driver messages embed URIs mid-sentence.
 */
export function redactText(text: string): string {
  return text.replace(EMBEDDED_URI, (uri) => redactUri(uri));
}
