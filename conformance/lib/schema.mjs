// A small JSON Schema (2020-12 subset) validator, no deps. It covers exactly the
// keywords the hitch/1 pack uses: type, enum, const, required, properties,
// additionalProperties, items, min/maxItems, min/maxLength, pattern,
// minimum/maximum, $ref (local and cross-file), oneOf, anyOf, allOf,
// format date-time. Any other keyword in a pack schema is an error, so the
// pack cannot silently rely on something this validator ignores.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const TYPES_DIR = fileURLToPath(new URL('../../types/', import.meta.url));

const KNOWN = new Set(['$schema', '$id', '$defs', '$comment', 'title', 'description', 'examples', 'default',
  'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', '$ref', 'oneOf', 'anyOf', 'allOf', 'format',
  'x-hitch']);

export function loadPack(dir = TYPES_DIR) {
  const schemas = new Map();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.schema.json')) continue;
    const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    schemas.set(f, s);
  }
  return schemas;
}

const typeOf = (v) => v === null ? 'null' : Array.isArray(v) ? 'array'
  : (typeof v === 'number' && Number.isInteger(v)) ? 'integer' : typeof v;

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function makeValidator(pack = loadPack()) {
  function resolve(ref, file) {
    const [f, frag = ''] = ref.split('#');
    const target = f || file;
    let node = pack.get(target);
    if (!node) throw new Error(`$ref to unknown schema ${target}`);
    for (const p of frag.split('/').filter(Boolean)) node = node?.[p];
    if (!node) throw new Error(`$ref ${ref} does not resolve`);
    return { node, file: target };
  }

  function check(s, v, path, file, errs) {
    if (s === true) return;
    if (s === false) { errs.push(`${path}: not allowed`); return; }
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`${file}: unsupported keyword "${k}" at ${path}`);
    if (s.$ref) { const r = resolve(s.$ref, file); check(r.node, v, path, r.file, errs); }
    if (s.type) {
      const t = typeOf(v), ok = [].concat(s.type).some((x) => x === t || (x === 'number' && t === 'integer'));
      if (!ok) { errs.push(`${path}: expected ${[].concat(s.type).join('|')}, got ${t}`); return; }
    }
    if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(v)) errs.push(`${path}: must be ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${path}: must be one of ${s.enum.join(', ')}`);
    if (typeof v === 'string') {
      if (s.minLength != null && [...v].length < s.minLength) errs.push(`${path}: shorter than ${s.minLength}`);
      if (s.maxLength != null && [...v].length > s.maxLength) errs.push(`${path}: longer than ${s.maxLength}`);
      if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) errs.push(`${path}: does not match ${s.pattern}`);
      if (s.format === 'date-time' && !DATE_TIME.test(v)) errs.push(`${path}: not a date-time`);
    }
    if (typeof v === 'number') {
      if (s.minimum != null && v < s.minimum) errs.push(`${path}: below ${s.minimum}`);
      if (s.maximum != null && v > s.maximum) errs.push(`${path}: above ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems != null && v.length < s.minItems) errs.push(`${path}: fewer than ${s.minItems} items`);
      if (s.maxItems != null && v.length > s.maxItems) errs.push(`${path}: more than ${s.maxItems} items`);
      if (s.items) v.forEach((x, i) => check(s.items, x, `${path}[${i}]`, file, errs));
    }
    if (typeOf(v) === 'object') {
      for (const r of s.required ?? []) if (!(r in v)) errs.push(`${path}: missing "${r}"`);
      const props = s.properties ?? {};
      for (const [k, x] of Object.entries(v)) {
        if (k in props) check(props[k], x, `${path}.${k}`, file, errs);
        else if (s.additionalProperties === false) errs.push(`${path}: unexpected "${k}"`);
        else if (typeof s.additionalProperties === 'object') check(s.additionalProperties, x, `${path}.${k}`, file, errs);
      }
    }
    if (s.allOf) for (const x of s.allOf) check(x, v, path, file, errs);
    if (s.anyOf && !s.anyOf.some((x) => { const e = []; check(x, v, path, file, e); return !e.length; }))
      errs.push(`${path}: matches none of anyOf`);
    if (s.oneOf) {
      const n = s.oneOf.filter((x) => { const e = []; check(x, v, path, file, e); return !e.length; }).length;
      if (n !== 1) errs.push(`${path}: matches ${n} of oneOf (need exactly 1)`);
    }
  }

  // validate(name, value) -> [] or list of error strings. name is a file in the pack.
  function validate(name, value) {
    const file = name.endsWith('.schema.json') ? name : `${name}.schema.json`;
    const s = pack.get(file);
    if (!s) throw new Error(`no schema ${file}`);
    const errs = [];
    check(s, value, '$', file, errs);
    return errs;
  }

  // Validate an envelope, and its data against the type's schema when the pack has one.
  function validateEnvelope(env) {
    const errs = validate('hitch.envelope', env);
    if (errs.length) return errs;
    if (Buffer.byteLength(JSON.stringify(env.data ?? {})) > 8192) errs.push('$.data: larger than 8 KB; use ref');
    const redacted = env.data && Object.keys(env.data).length === 1 && env.data.withheld === true; // privacy redaction
    if (!redacted && pack.has(`${env.type}.schema.json`)) errs.push(...validate(env.type, env.data ?? {}).map((e) => e.replace(/^\$/, '$.data')));
    return errs;
  }

  return { validate, validateEnvelope, has: (n) => pack.has(`${n}.schema.json`), pack };
}
