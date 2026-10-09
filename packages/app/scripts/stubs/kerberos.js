// Stand-in for an optional driver module that is not installed. See missing-module.js.
import { missingModule } from '../missing-module';

export default missingModule(
  'Optional module `kerberos` not found. Please install it to enable kerberos authentication',
);
