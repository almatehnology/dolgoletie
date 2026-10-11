/** Same byte budget as native save dialogs; Unicode code points are never split. */
export function safeDownloadName(input: string, extension: 'pdf' | 'xlsx' | 'zip' | 'tdbsync' | 'tdbbackup' | 'jpg' | 'jpeg' | 'png' | 'webp') {
  let base = input.replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, '_').trim().replace(/\.(?:pdf|xlsx|zip|tdbsync|tdbbackup|jpe?g|png|webp)$/i, '').replace(/^[.]+|[. ]+$/g, '') || 'report';
  if (/^(?:con(?:in\$|out\$)?|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu.test(base)) base = `report-${base}`;
  const encoder = new TextEncoder(), suffix = `.${extension}`, budget = 180 - encoder.encode(suffix).length;
  let result = '', size = 0;
  for (const character of base) { const length = encoder.encode(character).length; if (size + length > budget) break; result += character; size += length; }
  return `${result.replace(/[. ]+$/, '') || 'report'}${suffix}`;
}
