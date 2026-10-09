// Stand-in for an optional driver module that is not installed. See missing-module.js.
import { missingModule } from '../missing-module';

export default missingModule(
  'Optional module `os-dns-native` not found. Please install it to use OS DNS lookups.',
);
