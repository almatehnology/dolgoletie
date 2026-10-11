import unzipper from 'unzipper';
import { XMLValidator } from 'fast-xml-parser';
import { ImportError, LIMITS, checkDeadline } from './limits';

export async function readOfficeArchive(buffer: Buffer, started = Date.now()): Promise<Map<string, string>> {
  if (buffer.length > LIMITS.fileBytes) throw new ImportError('FILE_TOO_LARGE', 'Файл превышает 10 МБ.', 413);
  if (buffer.length < 4) throw new ImportError('FORMAT', 'Файл пуст или повреждён.');
  if (buffer.readUInt16LE(0) !== 0x4b50) throw new ImportError('FORMAT', 'Нужен обычный DOCX/XLSX. Старые форматы и файлы с паролем не поддерживаются.');
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end === -1) throw new ImportError('FORMAT', 'Повреждённый или незавершённый офисный архив.');
  if (buffer.readUInt16LE(end + 10) > LIMITS.entries) throw new ImportError('ARCHIVE_LIMIT', 'Слишком много частей в архиве.', 413);
  let directory: Awaited<ReturnType<typeof unzipper.Open.buffer>>;
  try { directory = await unzipper.Open.buffer(buffer); }
  catch { throw new ImportError('FORMAT', 'Не удалось открыть офисный архив; проверьте формат и отсутствие пароля.'); }
  if (directory.files.length > LIMITS.entries) throw new ImportError('ARCHIVE_LIMIT', 'Слишком много частей в архиве.', 413);
  let declared = 0;
  const names = new Set<string>();
  for (const entry of directory.files) {
    if (entry.path.includes('\\') || entry.path.startsWith('/') || entry.path.split('/').includes('..') || /^[a-z]:/i.test(entry.path) || names.has(entry.path)) throw new ImportError('ARCHIVE_PATH', 'Архив содержит недопустимый или повторный путь.');
    names.add(entry.path);
    if ((entry.flags & 1) !== 0) throw new ImportError('ENCRYPTED', 'Файлы с паролем не поддерживаются.');
    declared += entry.uncompressedSize;
    if (!Number.isSafeInteger(declared) || declared > LIMITS.expandedBytes) throw new ImportError('ARCHIVE_LIMIT', 'Распакованный файл превышает 40 МБ.', 413);
    if (/\.(xml|rels)$/i.test(entry.path) && entry.uncompressedSize > LIMITS.xmlBytes) throw new ImportError('XML_LIMIT', 'Одна часть документа слишком велика.', 413);
  }
  const xml = new Map<string, string>();
  let expanded = 0;
  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    // Read every part through a capped stream; do not trust only ZIP metadata.
    let size = 0;
    const chunks: Buffer[] = [];
    const isXml = /\.(xml|rels)$/i.test(entry.path);
    const stream = entry.stream();
    try {
      for await (const data of stream) {
        const chunk = Buffer.from(data);
        expanded += chunk.length; size += chunk.length;
        if (expanded > LIMITS.expandedBytes || (isXml && size > LIMITS.xmlBytes)) throw new ImportError('ARCHIVE_LIMIT', 'Превышен предел распаковки.', 413);
        if (isXml) chunks.push(chunk);
        checkDeadline(started);
      }
    } finally { stream.destroy(); }
    if (size !== entry.uncompressedSize) throw new ImportError('ARCHIVE_SIZE', 'Повреждённый размер части архива.');
    if (isXml) {
      const text = Buffer.concat(chunks).toString('utf8');
      if (/<!\s*(DOCTYPE|ENTITY)/i.test(text)) throw new ImportError('XML_ENTITY', 'DTD и XML-сущности запрещены.');
      let depth = 0;
      for (const tag of text.matchAll(/<\/?[\w:.-]+\b[^>]*>/g)) {
        if (tag[0].startsWith('</')) depth--;
        else if (!tag[0].endsWith('/>')) depth++;
        if (depth > 100) throw new ImportError('XML_DEPTH', 'Слишком глубокая структура документа.');
      }
      if (XMLValidator.validate(text) !== true) throw new ImportError('XML_INVALID', 'Повреждённая XML-структура документа.');
      xml.set(entry.path, text);
    }
  }
  if (!xml.has('[Content_Types].xml')) throw new ImportError('FORMAT', 'Отсутствует описание офисного формата.');
  checkDeadline(started);
  return xml;
}
