// Process entry for the shell runtime. It runs as an Electron utility process or as a forked
// Node child process. The module has no exports because importing it starts the host.
import { ShellSession } from './session';
import { installFatalHandlers, startHost } from './host';
import { chooseTransport } from './transport';

const transport = chooseTransport(process);
const exit = (code: number): void => {
  process.exit(code);
};

installFatalHandlers(transport, exit);
startHost(transport, new ShellSession(), exit);
