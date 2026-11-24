// `node conformance/client/hitch-client-check.mjs --client conformance/example/naive-client-adapter.mjs`
import { naiveClient } from './naive-client.mjs';
export default (env) => naiveClient(env);
