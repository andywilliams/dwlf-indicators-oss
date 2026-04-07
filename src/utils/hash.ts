type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

const stableStringify = (value: JsonLike): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  const entries = keys.map((key) => `"${key}":${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
};

const toJsonLike = (value: unknown): JsonLike => {
  if (value === null || typeof value === 'undefined') {
    return null;
  }

  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((item) => toJsonLike(item));
    }

    const result: { [key: string]: JsonLike } = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = toJsonLike(entry);
    }
    return result;
  }

  if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return value;
  }

  return String(value) as JsonLike;
};

export const hashParams = (value: unknown): string => {
  const json = stableStringify(toJsonLike(value));
  let hash = 0x811c9dc5;

  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }

  return hash.toString(16).padStart(8, '0');
};

