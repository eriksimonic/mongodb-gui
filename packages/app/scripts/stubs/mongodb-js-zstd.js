// Stand-in for an optional driver module that is not installed. See missing-module.js.
import { missingModule } from '../missing-module';

export default missingModule(
  'Optional module `@mongodb-js/zstd` not found. Please install it to enable zstd compression',
);
