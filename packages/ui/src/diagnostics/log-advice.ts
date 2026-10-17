const ADVICE: readonly { readonly pattern: RegExp; readonly advice: string }[] = [
  {
    pattern: /rlimits.*too low/i,
    advice: 'Raise ulimit -n to at least 64000 for the mongod process.',
  },
  {
    pattern: /transparent_hugepage/i,
    advice: 'Set it to "never" and restart mongod. Transparent huge pages hurt latency.',
  },
  {
    pattern: /vm\.max_map_count/i,
    advice: 'Set vm.max_map_count to at least 102400 with sysctl.',
  },
  {
    pattern: /access control is not enabled/i,
    advice:
      'Read and write access to data and configuration is unrestricted. Enable authorization.',
  },
];

/** What to do about a known startup warning, or undefined when the message is not one we know. */
export function warningAdvice(message: string): string | undefined {
  return ADVICE.find((entry) => entry.pattern.test(message))?.advice;
}

/** The warning text without the server's own suggestion, which the advice line replaces. */
export function warningTitle(message: string): string {
  const quoted = message.replace(/'(\w+)'/g, '"$1"');
  const sentence = quoted.indexOf('. ');
  return warningAdvice(message) !== undefined && sentence > 0 ? quoted.slice(0, sentence) : quoted;
}
