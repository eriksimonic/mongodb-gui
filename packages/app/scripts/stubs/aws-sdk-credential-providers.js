// Stand-in for an optional driver module that is not installed. See missing-module.js.
import { missingModule } from '../missing-module';

export default missingModule(
  'Optional module `@aws-sdk/credential-providers` not found. Please install it to enable getting aws credentials via the official sdk.',
);
