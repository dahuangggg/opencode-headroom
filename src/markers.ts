export const CCR_HASH_RE = /\b[0-9a-fA-F]{24}\b/;

const CCR_HASH_FULL_RE = /^[0-9a-fA-F]{24}$/;
const JSON_SENTINEL_RE = /<<ccr:[0-9a-fA-F]{24}\s+\d+_rows_offloaded>>/;
const RETRIEVE_MARKER_RE = /\[Retrieve more:\s*hash=[0-9a-fA-F]{24}\]/;

export function isValidCCRHash(hash: string): boolean {
  return CCR_HASH_FULL_RE.test(hash);
}

export function containsCCRMarker(content: string): boolean {
  return JSON_SENTINEL_RE.test(content) || RETRIEVE_MARKER_RE.test(content);
}

export function formatJsonSentinel(
  hash: string,
  rowsOffloaded: number,
): { _ccr_dropped: string } {
  return {
    _ccr_dropped: `<<ccr:${hash} ${rowsOffloaded}_rows_offloaded>>`,
  };
}

export function formatRetrieveMarker(hash: string): string {
  return `[Retrieve more: hash=${hash}]`;
}
