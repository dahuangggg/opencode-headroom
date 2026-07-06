export const CCR_HASH_RE = /\b[0-9a-fA-F]{24}\b/;

const CCR_HASH_FULL_RE = /^[0-9a-fA-F]{24}$/;
const SMART_CCR_MARKER_RE = /<<ccr:[0-9a-fA-F]{12,24}\b[^>]*>>/;
const RETRIEVE_MARKER_RE =
  /\[[^\]]*(?:Retrieve more:|Retrieve original:)\s*hash=[0-9a-fA-F]{24}[^\]]*\]/i;
const COMPRESSED_HASH_MARKER_RE =
  /\[[^\]]*compressed[^\]]*hash=[0-9a-fA-F]{24}[^\]]*\]/i;

export function isValidCCRHash(hash: string): boolean {
  return CCR_HASH_FULL_RE.test(hash);
}

export function containsCCRMarker(content: string): boolean {
  return (
    SMART_CCR_MARKER_RE.test(content) ||
    RETRIEVE_MARKER_RE.test(content) ||
    COMPRESSED_HASH_MARKER_RE.test(content)
  );
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
