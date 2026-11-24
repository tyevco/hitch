// `node conformance/server/hitch-check.mjs --adapter conformance/example/toy-check-adapter.mjs`
import { toyAdapter } from './toy-adapter.mjs';
export default () => toyAdapter();
