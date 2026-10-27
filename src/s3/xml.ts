/**
 * Just enough XML reading for S3 responses (ListObjectsV2 and error
 * bodies). They are flat, machine-generated documents, so tag matching is
 * reliable and saves shipping a full XML parser.
 */

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    switch (entity.toLowerCase()) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
    }
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
}

/** Raw inner content of every `<tag>...</tag>` block. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const result: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) result.push(match[1]);
  return result;
}

/** Decoded text of the first `<tag>` element, if present. */
export function xmlValue(xml: string, tag: string): string | undefined {
  const block = xmlBlocks(xml, tag)[0];
  return block === undefined ? undefined : decodeEntities(block);
}

export function xmlValues(xml: string, tag: string): string[] {
  return xmlBlocks(xml, tag).map(decodeEntities);
}
