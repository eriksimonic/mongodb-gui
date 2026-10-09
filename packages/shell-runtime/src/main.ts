// Process entry for the shell runtime. It runs as an Electron utility process or as a forked
// Node child process. The module has no exports because importing it starts the host.
import { ShellSession } from './session';
import { installFatalHandlers, startHost } from './host';
import { chooseTransport } from './transport';

// mongosh's newer completer (USE_NEW_AUTOCOMPLETE unset or not "0") throws "schema.<name> must be
// defined" for a collection whose sampled documents hold only empty arrays, and it keeps failing for
// the rest of the session. The legacy completer does not have that failure. It is read on each
// completion request, so setting it here, before any runtime exists, applies to every session.
process.env.USE_NEW_AUTOCOMPLETE = '0';

const transport = chooseTransport(process);
const exit = (code: number): void => {
  process.exit(code);
};

installFatalHandlers(transport, exit);
startHost(transport, new ShellSession(), exit);
