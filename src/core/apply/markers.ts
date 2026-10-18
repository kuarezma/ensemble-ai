export const BEGIN = '<!-- ENSEMBLE:BEGIN v1 -->';
export const END = '<!-- ENSEMBLE:END -->';
export function managedBlock(content: string, beginMarker = BEGIN, endMarker = END): string | null {
  const begin = content.indexOf(beginMarker),
    end = content.indexOf(endMarker);
  const begins = content.split(beginMarker).length - 1,
    ends = content.split(endMarker).length - 1;
  if (!begins && !ends) return null;
  if (begins !== 1 || ends !== 1 || end < begin || /<!-- ENSEMBLE:BEGIN (?!v1 -->)/.test(content))
    throw new Error('Ambiguous or damaged Ensemble markers');
  return content.slice(begin, end + endMarker.length);
}
export function updateManagedBlock(
  before: string | null,
  body: string,
  beginMarker = BEGIN,
  endMarker = END,
): string {
  const content = before ?? '';
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  if (body.includes('<!-- ENSEMBLE:')) throw new Error('Reserved marker in rules');
  if (/<!-- ENSEMBLE:BEGIN (?!v1 -->)/.test(content))
    throw new Error('Unsupported Ensemble marker version');
  const block = beginMarker + eol + body.replace(/\r?\n/g, eol) + eol + endMarker;
  const existing = managedBlock(content, beginMarker, endMarker);
  if (existing !== null) return content.replace(existing, () => block);
  return content + (content && !content.endsWith('\n') ? eol : '') + block + eol;
}

/** Reconstruct the proposal using only managed-block edits before accepting it. */
export function assertManagedOnlyChange(
  before: string | null,
  after: string,
  agentFile = false,
): void {
  const markdown = managedBlock(after);
  if (!markdown) throw new Error('Managed block required');
  const body = markdown.slice(BEGIN.length, -END.length).replace(/^\r?\n|\r?\n$/g, '');
  const yamlBegin = '# ENSEMBLE:BEGIN v1',
    yamlEnd = '# ENSEMBLE:END';
  let expected = before;
  const yaml = managedBlock(after, yamlBegin, yamlEnd);
  if (yaml) {
    if (!agentFile) throw new Error('YAML managed block only permitted in subagent files');
    const yamlBody = yaml.slice(yamlBegin.length, -yamlEnd.length).replace(/^\r?\n|\r?\n$/g, '');
    if (before === null)
      expected = '---\n' + updateManagedBlock(null, yamlBody, yamlBegin, yamlEnd) + '---\n';
    else {
      if (!managedBlock(before, yamlBegin, yamlEnd))
        throw new Error('Unmanaged subagent frontmatter');
      expected = updateManagedBlock(before, yamlBody, yamlBegin, yamlEnd);
    }
  }
  if (updateManagedBlock(expected, body) !== after)
    throw new Error('Change modifies content outside managed blocks');
}
