/** Bounded multipart decoding with a distinct error for truncated transfers. */
export async function readUploadForm(request: Request, limit: number): Promise<FormData> {
  const fail = (code: string, message: string, status = 400): never => {
    throw Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });
  };
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) fail('UPLOAD_FORMAT', 'Выберите файл и повторите загрузку. Ожидается multipart/form-data.');
  const length = request.headers.get('content-length');
  const expected = length === null ? undefined : Number(length);
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) fail('UPLOAD_LENGTH', 'Некорректный размер загрузки.');
  if (expected !== undefined && expected > limit) fail('UPLOAD_LIMIT', 'Файл превышает допустимый размер.', 413);
  const reader = request.body?.getReader();
  if (!reader) return fail('UPLOAD_EMPTY', 'Файл не передан.');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail('UPLOAD_LIMIT', 'Файл превышает допустимый размер.', 413); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  if (expected !== undefined && size !== expected) fail('UPLOAD_INCOMPLETE', 'Файл получен не полностью. Повторите загрузку; если ошибка повторяется, обновите приложение.');
  try {
    const bytes = Buffer.concat(chunks, size);
    chunks.length = 0;
    const body = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    return await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    return fail('UPLOAD_INVALID', 'Не удалось прочитать загрузку файла. Повторите выбор файла и отправку.');
  }
}
