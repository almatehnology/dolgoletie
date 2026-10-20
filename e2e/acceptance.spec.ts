import { test, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { createFixtures, syntheticSurname, ADMIN_PASSWORD, USERNAME, USER_PASSWORD } from './fixtures';

const root = process.env.TDB_QA_ROOT!;
const origin = process.env.TDB_QA_ORIGIN ?? 'http://localhost:3327';
let context: BrowserContext;
let page: Page;
let files: Awaited<ReturnType<typeof createFixtures>>;
let conflictId: string;
let manualId: string;
let documentPersonId: string;
let scanId: string;
let scanStoredPath: string;
let eventId: string;
let jobId: string;
let originalScan: Buffer;
const browserErrors: string[] = [];
const network: { method: string; path: string; status: number }[] = [];
const downloads: string[] = [];

async function screenshot(name: string, info: TestInfo) {
  const path = join(root, 'screenshots', `${name}.png`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
  console.log(`QA_SCREENSHOT=${path}`);
}

async function json(path: string, method = 'GET', data?: object) {
  const response = await context.request.fetch(`${origin}${path}`, { method, data, headers: { Origin: origin } });
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}

async function contentSnapshot() {
  const [people, events] = await Promise.all([json('/api/people?pageSize=200'), json('/api/events?pageSize=200')]);
  return { people, events };
}

async function login(username: string, password: string) {
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  // A URL can change before React attaches controlled-input event handlers.
  await page.waitForLoadState('networkidle');
  await page.getByLabel(/Имя пользователя/).fill(username);
  await page.getByLabel(/^Пароль/).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(username === 'admin' ? `${origin}/admin` : `${origin}/`);
  await page.waitForLoadState('networkidle');
}

async function navigate(path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

async function switchToAdmin() {
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await login('admin', ADMIN_PASSWORD);
}

async function switchToPrimary(password = USER_PASSWORD) {
  await page.getByRole('button', { name: 'Вход пользователя', exact: true }).click();
  await login(USERNAME, password);
}

async function forbiddenContent() {
  const gets = ['/api/people', '/api/events', '/api/search?q=Тест', '/api/export', '/api/people/missing', '/api/events/missing', '/api/people/missing/pdf', '/api/events/missing/export', '/api/scans/missing', '/api/scans/missing/thumb'];
  for (const path of gets) {
    const response = await context.request.get(`${origin}${path}`);
    expect(response.status(), `admin GET ${path}`).toBe(403);
  }
  for (const path of ['/api/people', '/api/events', '/api/reports/export', '/api/batch-import/jobs', '/api/people/import', '/api/events/missing/participants', '/api/people/missing/scans']) {
    const response = await context.request.post(`${origin}${path}`, { data: {}, headers: { Origin: origin } });
    expect(response.status(), `admin POST ${path}`).toBe(403);
  }
}

function group(name: string) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

async function exportReport(format: 'pdf' | 'xlsx', name: string, expectedNames: string[], info: TestInfo) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: /^Формат файла/ }).selectOption(format);
  await dialog.getByLabel('Ориентация страницы').selectOption('landscape');
  await screenshot(`${name}-${format}-dialog`, info);
  const requestPromise = page.waitForRequest(request => request.url().endsWith('/api/reports/export') && request.method() === 'POST');
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: `Скачать ${format.toUpperCase()}`, exact: true }).click();
  const request = await requestPromise;
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
  const path = join(root, 'downloads', `${name}.${format}`);
  await download.saveAs(path);
  downloads.push(path);
  const bytes = await readFile(path);
  expect(bytes.length).toBeGreaterThan(500);
  if (format === 'pdf') {
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.toString('latin1')).toMatch(/%%EOF\s*$/);
  } else {
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(path);
    const sheet = book.worksheets[0];
    expect(sheet.pageSetup.orientation).toBe('landscape');
    // ExcelJS reads a serialized auto-filter back as an A1 range string.
    const filter = sheet.autoFilter;
    if (!filter) throw new Error(`Downloaded ${name}.xlsx has no table auto-filter`);
    const first = typeof filter === 'string' ? filter.split(':')[0] : filter.from;
    const header = typeof first === 'string' ? Number(first.replace(/\D/g, '')) : first.row;
    const lines: string[][] = [];
    for (let i = header + 1; i <= sheet.rowCount; i++) {
      const values: string[] = [];
      sheet.getRow(i).eachCell({ includeEmpty: true }, cell => values.push(cell.text));
      if (values.some(Boolean)) lines.push(values);
    }
    if (expectedNames.length) {
      expect(lines).toHaveLength(expectedNames.length);
      const allNames = lines.map(values => values.join(' '));
      for (const name of expectedNames) expect(allNames.some(line => line.includes(name)), `export includes ${name}`).toBeTruthy();
    } else {
      expect(lines.flat().join(' ')).toContain('В мероприятии нет участников.');
    }
    if (name.startsWith('event-details')) expect(sheet.getCell('A3').text).toContain('Место: Вымышленный зал QA');
  }
  await expect(dialog).not.toBeVisible();
  return request.postDataJSON();
}

test.describe.serial('Browser acceptance on synthetic isolated Next dev', () => {
  test.beforeAll(async ({ browser }) => {
    files = await createFixtures(root);
    originalScan = await readFile(files.scan);
    context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(60_000);
    page = await context.newPage();
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/')) network.push({ method: response.request().method(), path: url.pathname, status: response.status() }); });
  });
  test.beforeEach(async () => { await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); });
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) {
      await screenshot(`failure-${info.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 70)}`, info).catch(() => {});
      await writeFile(info.outputPath('browser-body.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable'));
      console.log(`QA_ACTIONABLE_FAILURE=${info.title}: ${info.errors.map(error => error.message).join('\n')}`);
    }
    await context.tracing.stop({ path: info.outputPath('trace.zip') });
    expect(browserErrors, 'Uncaught browser errors').toEqual([]);
  });
  test.afterAll(async () => {
    await writeFile(join(root, 'evidence.json'), JSON.stringify({ network, browserErrors, downloads, fixtures: files }, null, 2));
    await context?.close();
  });

  test('01 first setup, admin, primary creation and content API isolation', async ({}, info) => {
    await navigate('/');
    await expect(page.getByText('Первичная настройка', { exact: true })).toBeVisible();
    await screenshot('01-first-setup', info);
    await page.getByLabel(/Новый пароль admin/).fill(ADMIN_PASSWORD);
    await page.getByLabel(/Повторите пароль admin/).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Создать admin', exact: true }).click();
    await login('admin', ADMIN_PASSWORD);
    await screenshot('02-admin-create-primary', info);
    await page.getByLabel(/Имя пользователя/).fill(USERNAME);
    await page.getByLabel(/^Пароль \(не менее/).fill(USER_PASSWORD);
    await page.getByLabel(/Повторите пароль/).fill(USER_PASSWORD);
    await page.getByRole('button', { name: 'Создать пользователя', exact: true }).click();
    await expect(page.getByText(`Пользователь: ${USERNAME}.`, { exact: false })).toBeVisible();
    await forbiddenContent();
    await screenshot('03-admin-content-forbidden', info);
    await switchToPrimary();
    expect((await json('/api/people')).total).toBe(0);
    expect((await json('/api/auth/status')).role).toBe('user');
    expect((await context.request.get(`${origin}/api/admin/status`)).status()).toBe(403);
    await screenshot('04-primary-login', info);
    await navigate('/data');
    await expect(page.getByRole('link', { name: 'Пакетная загрузка DOCX / XLSX', exact: true })).toHaveAttribute('href', '/people/import');
    await expect(page.getByRole('link', { name: 'Синхронизация через файл', exact: true })).toHaveAttribute('href', '/sync');
    await screenshot('04b-data-workspace-links', info);
  });

  test('02 DOCX and ExcelJS XLSX batch mapping, candidates, conflict, confirmation and no prior writes', async ({}, info) => {
    const existing = await json('/api/people', 'POST', { lastName: 'Конфликтов', firstName: 'Антон', middleName: 'Тестович', phone: '+70000001111', passportNumber: '0001 000001', notes: 'Сохранить исходное примечание' });
    conflictId = existing.id;
    const manual = await json('/api/people', 'POST', { lastName: 'Ручной', firstName: 'Роман', middleName: 'Тестович', phone: '+70000002222' });
    manualId = manual.id;
    const baseline = await contentSnapshot();
    await navigate('/people/import');
    await page.getByLabel('Выберите DOCX/XLSX').setInputFiles([files.xlsx, files.docx]);
    const uploadResponse = page.waitForResponse(response => response.url().endsWith('/api/batch-import/jobs') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Разобрать файлы' }).click();
    const uploaded = await (await uploadResponse).json();
    jobId = uploaded.id;
    expect(uploaded.tables).toHaveLength(2);
    await expect(page.getByLabel('Начало заголовка Синтетика')).toHaveValue('2');
    await expect(page.getByLabel('Конец заголовка Синтетика')).toHaveValue('2');
    await expect(page.getByLabel('Поле колонки 4 Синтетика')).toHaveValue('');
    await page.getByLabel('Поле колонки 4 Синтетика').selectOption('notes');
    await expect(page.getByLabel('Поле колонки 4 Таблица 1')).toHaveValue('passportSeries');
    await expect(page.getByLabel('Поле колонки 5 Таблица 1')).toHaveValue('passportDigits');
    await screenshot('05-header-mappings', info);
    expect(await contentSnapshot(), 'Upload/mapping must not change content').toEqual(baseline);
    await page.getByRole('button', { name: 'Показать план изменений' }).click();
    await expect(page.getByText(/Неразрешённых групп: 1\./)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Подтвердить импорт' })).toBeDisabled();
    await page.getByLabel('Показать', { exact: false }).selectOption('conflict');
    const conflict = group('Конфликтов Антон Тестович');
    await expect(conflict.getByLabel('Решение по человеку')).toContainText('0001 000001');
    await screenshot('06-conflict-blocks-confirmation', info);
    await conflict.getByLabel('Выбор phone', { exact: true }).selectOption('custom');
    await conflict.getByLabel('Итог phone', { exact: true }).fill('+70000009999');
    await page.getByRole('button', { name: 'Пересчитать решения' }).click();
    await expect(page.getByText(/Неразрешённых групп: 0\./)).toBeVisible();
    expect(await contentSnapshot(), 'Conflict resolution must not write content').toEqual(baseline);
    await page.getByLabel('Показать', { exact: false }).selectOption('new');
    await page.getByRole('button', { name: 'Вперёд →', exact: true }).click();
    await expect(page.getByText('2 / 3', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Вперёд →', exact: true }).click();
    const manualGroup = group('Импортный Роман Тестович');
    await manualGroup.getByText('Найти другую карточку, включая архив', { exact: true }).click();
    await manualGroup.getByLabel('Поиск кандидата').fill('Ручной');
    await manualGroup.getByRole('button', { name: 'Найти', exact: true }).click();
    await manualGroup.getByRole('button', { name: /Ручной Роман Тестович/ }).click();
    await page.getByRole('button', { name: 'Пересчитать решения' }).click();
    await page.getByLabel('Показать', { exact: false }).selectOption('conflict');
    const selectedGroup = group('Импортный Роман Тестович');
    await selectedGroup.getByLabel('Выбор lastName', { exact: true }).selectOption('keep');
    await page.getByRole('button', { name: 'Пересчитать решения' }).click();
    await expect(page.getByText(/Неразрешённых групп: 0\./)).toBeVisible();
    expect(await contentSnapshot(), 'Manual candidate/decisions must not write content').toEqual(baseline);
    await page.getByLabel('Показать', { exact: false }).selectOption('all');
    await screenshot('07-final-plan-before-confirmation', info);
    await expect(page.getByRole('button', { name: 'Подтвердить импорт' })).toBeDisabled();
    await page.getByLabel('Я проверил(а) итоговый план и подтверждаю выбранные изменения').check();
    const confirmedVersion = (await json(`/api/batch-import/jobs/${jobId}`)).plan.version;
    await page.getByRole('button', { name: 'Подтвердить импорт' }).click();
    await expect(page.getByRole('heading', { name: 'Импорт сохранён' })).toBeVisible();
    await expect(page.getByText(/Создано: 52; изменено: 2;/)).toBeVisible();
    const result = await json(`/api/batch-import/jobs/${jobId}`);
    const repeat = await json(`/api/batch-import/jobs/${jobId}/apply`, 'POST', { version: confirmedVersion, confirm: true });
    expect(repeat).toEqual(result.result);
    const saved = await contentSnapshot();
    expect(saved.people.total).toBe(54);
    const updated = saved.people.items.find((person: { id: string }) => person.id === conflictId);
    expect(updated.phone).toBe('+70000009999');
    expect(updated.notes).toBe('Сохранить исходное примечание');
    expect(saved.people.items.find((person: { id: string }) => person.id === manualId).lastName).toBe('Ручной');
    documentPersonId = saved.people.items.find((person: { lastName: string }) => person.lastName === 'Документова').id;
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('tdb-batch-import'))).toBeNull();
    await screenshot('08-import-confirmed', info);
  });

  test('03 select people across pages and search, PDF/XLSX reports, event details and participants', async ({}, info) => {
    await navigate('/people');
    await expect(page.getByText('Всего: 54', { exact: true })).toBeVisible();
    await page.getByLabel(`Выбрать ${syntheticSurname(1)} Турист Синтетический`, { exact: true }).check();
    await page.getByLabel(`Выбрать ${syntheticSurname(2)} Турист Синтетический`, { exact: true }).check();
    await page.getByRole('button', { name: 'Вперёд →', exact: true }).click();
    await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Выбрать страницу (4)', exact: true }).click();
    await expect(page.getByText('Выбрано: 6', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Снять выбор на странице (4)', exact: true }).click();
    await page.getByLabel(`Выбрать ${syntheticSurname(51)} Турист Синтетический`, { exact: true }).check();
    await page.getByLabel('Поиск', { exact: false }).fill('Документова');
    await page.getByLabel('Выбрать Документова Анна Тестовна', { exact: true }).check();
    await page.getByLabel('Поиск', { exact: false }).fill('');
    await expect(page.getByText('Выбрано: 4', { exact: true })).toBeVisible();
    await screenshot('09-people-selection-across-pages', info);
    const selectedNames = [syntheticSurname(1), syntheticSurname(2), syntheticSurname(51), 'Документова'];
    await page.getByRole('button', { name: 'Экспортировать (4)', exact: true }).click();
    const dialog = page.getByRole('dialog');
    for (const label of ['Фамилия', 'Имя', 'Отчество', 'Дата рождения', 'Телефон', 'Серия и номер паспорта']) await dialog.getByLabel(label, { exact: true }).uncheck();
    await expect(dialog.getByRole('button', { name: 'Скачать PDF', exact: true })).toBeDisabled();
    await expect(dialog.getByText('Выберите хотя бы одно поле карточки.', { exact: true })).toBeVisible();
    for (const label of ['Фамилия', 'Имя', 'Телефон', 'Серия и номер паспорта']) await dialog.getByLabel(label, { exact: true }).check();
    await dialog.getByRole('button', { name: 'Переместить «Телефон» вверх', exact: true }).click();
    const options = await exportReport('pdf', 'people-selected', selectedNames, info);
    expect(options.personIds).toHaveLength(4);
    expect(options.fields).toEqual(['lastName', 'phone', 'firstName', 'passportNumber']);
    await page.getByRole('button', { name: 'Экспортировать (4)', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('Ориентация страницы')).toHaveValue('landscape');
    const xlsxOptions = await exportReport('xlsx', 'people-selected', selectedNames, info);
    expect(xlsxOptions.personIds).toEqual(options.personIds);
    expect(xlsxOptions.fields).toEqual(options.fields);
    const event = await json('/api/events', 'POST', { title: 'Вымышленное мероприятие QA', startDate: '2026-12-20', endDate: '2026-12-21', location: 'Вымышленный зал QA', program: 'Синтетическая программа', currency: 'RUB', excursions: [{ name: 'Тестовая экскурсия', cost: '123' }] });
    eventId = event.id;
    await navigate(`/events/${eventId}`);
    await expect(page.getByRole('heading', { name: event.title, exact: true })).toBeVisible();
    await page.getByRole('tab', { name: /Участники/ }).click();
    await page.getByRole('button', { name: 'Экспортировать участников (0)', exact: true }).click();
    await exportReport('xlsx', 'event-participants-empty', [], info);
    await page.getByRole('button', { name: 'Добавить участников', exact: true }).click();
    const add = page.getByRole('dialog');
    for (const query of [syntheticSurname(1), 'Документова']) {
      await add.getByLabel(/Поиск человека/).fill(query);
      await add.getByRole('checkbox', { name: new RegExp(query) }).check();
    }
    await add.getByRole('button', { name: 'Добавить выбранных (2)', exact: true }).click();
    await expect(add).not.toBeVisible();
    await expect(page.getByText('Участников: 2', { exact: true })).toBeVisible();
    await screenshot('10-event-participants', info);
    const names = [syntheticSurname(1), 'Документова'];
    for (const format of ['pdf', 'xlsx'] as const) {
      await page.getByRole('button', { name: 'Экспортировать участников (2)', exact: true }).click();
      const request = await exportReport(format, 'event-participants', names, info);
      expect(request.context).toBe('event-participants');
      expect(request.eventId).toBe(eventId);
    }
    await page.getByRole('tab', { name: 'Основные данные', exact: true }).click();
    for (const format of ['pdf', 'xlsx'] as const) {
      await page.getByRole('button', { name: 'Экспортировать сведения', exact: true }).click();
      const request = await exportReport(format, 'event-details', names, info);
      expect(request.context).toBe('event-details');
    }
    await screenshot('11-event-details', info);
  });

  test('04 synthetic document, encryption prepare/code confirmation/enable, re-login and GET docs', async ({}, info) => {
    await navigate(`/people/${documentPersonId}`);
    const uploaded = page.waitForResponse(response => response.url().endsWith(`/people/${documentPersonId}/scans`) && response.request().method() === 'POST');
    await page.locator('input[type=file]').setInputFiles(files.scan);
    const uploadResponse = await uploaded;
    expect(uploadResponse.status()).toBe(201);
    const scan = (await uploadResponse.json()).items[0];
    scanId = scan.id;
    scanStoredPath = scan.storedPath;
    await expect(page.getByRole('button', { name: 'Показать сканы (1)', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Показать сканы (1)', exact: true }).click();
    await expect(page.getByAltText('synthetic-document.png')).toBeVisible();
    await screenshot('12-document-before-encryption', info);
    const before = await contentSnapshot();
    await switchToAdmin();
    const encryption = page.locator('form').filter({ has: page.getByRole('button', { name: 'Подготовить включение', exact: true }) });
    await encryption.getByLabel(/Текущий пароль основного пользователя/).fill(USER_PASSWORD);
    await encryption.getByRole('button', { name: 'Подготовить включение', exact: true }).click();
    await expect(page.getByText('Код восстановления', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Включить шифрование', exact: true })).toBeDisabled();
    expect((await json('/api/admin/status')).encryptionEnabled).toBe(false);
    const preparedCode = await page.locator('code').innerText();
    expect(preparedCode.length).toBeGreaterThan(20);
    await screenshot('13-encryption-recovery-code-confirmation', info);
    await page.getByLabel('Я сохранил код восстановления отдельно от базы').check();
    await page.getByRole('button', { name: 'Включить шифрование', exact: true }).click();
    await expect(page.getByText('Шифрование включено.', { exact: false })).toBeVisible();
    expect((await json('/api/admin/status')).encryptionEnabled).toBe(true);
    await screenshot('14-encryption-enabled', info);
    await forbiddenContent();
    const vault = JSON.parse(await readFile(join(root, 'data', 'vault.json'), 'utf8'));
    const db = await readFile(join(root, 'data', 'vaults', vault.generation, 'data.db'));
    expect(db.subarray(0, 16).toString()).not.toBe('SQLite format 3\u0000');
    const encryptedDoc = await readFile(join(root, 'data', 'vaults', vault.generation, 'uploads', scanStoredPath));
    expect(encryptedDoc.equals(originalScan)).toBe(false);
    await switchToPrimary();
    expect(await contentSnapshot(), 'Encryption preserves content').toEqual(before);
    const response = await context.request.get(`${origin}/api/scans/${scanId}`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('image/png');
    expect((await response.body()).equals(originalScan)).toBe(true);
    const thumbnail = await context.request.get(`${origin}/api/scans/${scanId}/thumb`);
    expect(thumbnail.status()).toBe(200);
    expect((await thumbnail.body()).length).toBeGreaterThan(100);
    expect((await context.request.get(`${origin}/api/people/${documentPersonId}`)).status()).toBe(200);
    expect((await context.request.get(`${origin}/api/events/${eventId}`)).status()).toBe(200);
    await navigate(`/people/${documentPersonId}`);
    await expect(page.getByRole('button', { name: 'Показать сканы (1)', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Показать сканы (1)', exact: true }).click();
    await page.getByRole('button').filter({ has: page.getByAltText('synthetic-document.png') }).click();
    await expect(page.getByRole('dialog').getByAltText('synthetic-document.png')).toBeVisible();
    await screenshot('15-document-after-encryption-and-login', info);
    const attachmentDownload = page.waitForEvent('download');
    await page.getByRole('dialog').getByRole('button', { name: 'Скачать', exact: true }).click();
    const savedAttachment = await attachmentDownload;
    const attachmentPath = join(root, 'downloads', savedAttachment.suggestedFilename());
    await savedAttachment.saveAs(attachmentPath);
    expect((await readFile(attachmentPath)).equals(originalScan)).toBe(true);
    await page.keyboard.press('Escape');
  });

  test('05 role transitions clear selection, dialogs, search, revealed state and unfinished import', async ({}, info) => {
    await navigate('/people/import');
    await page.getByLabel('Выберите DOCX/XLSX').setInputFiles(files.docx);
    await page.getByRole('button', { name: 'Разобрать файлы' }).click();
    await expect(page.getByRole('button', { name: 'Показать план изменений' })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('tdb-batch-import'))).not.toBeNull();
    await navigate('/people');
    await page.getByLabel('Выбрать Документова Анна Тестовна', { exact: true }).check();
    await page.getByRole('button', { name: 'Экспортировать (1)', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await navigate(`/people/${documentPersonId}`);
    // A full navigation starts with hidden scans; explicitly reveal before verifying one-click hide.
    await page.getByRole('button', { name: 'Показать сканы (1)', exact: true }).click();
    await page.getByRole('button', { name: 'Скрыть сканы', exact: true }).click();
    const hiddenButton = page.getByRole('button', { name: 'Показать сканы (1)', exact: true });
    await expect(hiddenButton).toBeVisible();
    await page.getByRole('button', { name: 'Поиск ⌘K', exact: true }).click();
    await page.getByPlaceholder('ФИО, паспорт, название мероприятия…').fill('Документова');
    await expect(page.getByRole('dialog').getByRole('link', { name: /Документова/ })).toBeVisible();
    await screenshot('16-primary-sensitive-search-before-switch', info);
    await page.keyboard.press('Escape');
    await switchToAdmin();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Документова', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Поиск ⌘K', exact: true })).toHaveCount(0);
    // Soft assertions allow the remaining transitions to produce evidence for the parent.
    expect.soft(await page.evaluate(() => sessionStorage.getItem('tdb-batch-import')), 'Role logout must discard unfinished import session state').toBeNull();
    await screenshot('17-admin-after-role-transition', info);
    await switchToPrimary();
    await navigate('/people');
    await expect(page.getByText('Выбрано: 0', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Экспортировать (0)', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Поиск', { exact: false })).toHaveValue('');
    await page.getByRole('button', { name: 'Поиск ⌘K', exact: true }).click();
    await expect(page.getByPlaceholder('ФИО, паспорт, название мероприятия…')).toHaveValue('');
    await page.keyboard.press('Escape');
    await navigate(`/people/${documentPersonId}`);
    await expect(page.getByRole('button', { name: 'Показать сканы (1)', exact: true })).toBeVisible();
    await navigate('/people/import');
    expect.soft(await page.getByLabel('Выберите DOCX/XLSX').count(), 'A new role session must not resume the previous unfinished import').toBe(1);
    await screenshot('18-primary-return-import-state', info);
    await page.getByRole('button', { name: 'Выход', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/login`);
    expect((await json('/api/auth/status')).authenticated).toBe(false);
    expect((await context.request.get(`${origin}/api/scans/${scanId}`)).status()).toBe(401);
  });
  test('06 browser file upload round trips after password change, encrypted and plaintext', async () => {
    const password = 'synthetic-updated-primary-password';
    await json('/api/auth/login', 'POST', { username: USERNAME, password: USER_PASSWORD });
    // Individually valid uploads make both exported files larger than Next's
    // default 10 MiB middleware clone limit. Incompressible bytes matter here.
    for (let index = 0; index < 2; index++) {
      const response = await context.request.post(`${origin}/api/people/${documentPersonId}/scans`, {
        headers: { Origin: origin },
        multipart: { files: { name: `large-synthetic-${index}.png`, mimeType: 'image/png', buffer: Buffer.concat([originalScan, randomBytes(6 * 1024 * 1024)]) } },
      });
      expect(response.status(), await response.text()).toBe(201);
    }
    await json('/api/auth/login', 'POST', { username: 'admin', password: ADMIN_PASSWORD });
    await json('/api/admin/user-password', 'POST', { proof: USER_PASSWORD, password, recovery: false });
    await json('/api/auth/login', 'POST', { username: USERNAME, password });
    await navigate('/data');
    async function roundTrip(encrypted: boolean) {
      const results = await page.evaluate(async ({ password, encrypted }) => {
        const sync = await fetch('/api/sync/export');
        if (!sync.ok) throw new Error(`Sync export ${sync.status}`);
        const form = new FormData();
        form.append('file', await sync.blob(), 'synthetic.tdbsync');
        if (encrypted) form.append('password', password);
        const preview = await fetch('/api/sync/preview', { method: 'POST', body: form });
        const backup = await fetch('/api/export?scope=full');
        if (!backup.ok) throw new Error(`Backup export ${backup.status}`);
        const blob = await backup.blob();
        if (blob.size <= 10 * 1024 * 1024) throw new Error('Regression fixture must exceed the old middleware limit');
        const imports = [];
        for (const [mode, dryRun] of [['merge', true], ['replace', true], ['merge', false], ['replace', false]] as const) {
          const body = new FormData();
          body.append('file', blob, encrypted ? 'synthetic.tdbbackup' : 'synthetic.zip');
          body.append('mode', mode); body.append('dryRun', String(dryRun));
          if (encrypted) body.append('password', password);
          const response = await fetch('/api/import', { method: 'POST', body });
          imports.push({ mode, dryRun, status: response.status, data: await response.json() });
        }
        return { sync: { status: preview.status, data: await preview.json() }, imports };
      }, { password, encrypted });
      expect(results.sync.status, JSON.stringify(results)).toBe(200);
      for (const item of results.imports) expect(item.status, `${item.mode}: ${JSON.stringify(item.data)}`).toBe(200);
      expect((await json('/api/people?pageSize=200')).total).toBe(54);
      const document = await context.request.get(`${origin}/api/scans/${scanId}`);
      expect(document.status()).toBe(200);
      expect((await document.body()).equals(originalScan)).toBe(true);
    }
    await roundTrip(true);
    await json('/api/auth/login', 'POST', { username: 'admin', password: ADMIN_PASSWORD });
    await json('/api/admin/encryption', 'POST', { action: 'disable', proof: password });
    await json('/api/auth/login', 'POST', { username: USERNAME, password });
    await navigate('/data');
    await roundTrip(false);
  });
  test('07 archive bulk restore and delete require confirmation on both tabs', async () => {
    for (const entity of ['people', 'events'] as const) {
      const items: { id: string; label: string }[] = [];
      for (let index = 0; index < 2; index++) {
        const label = `Архив QA ${entity} ${index}`;
        const record = await json(`/api/${entity}`, 'POST', entity === 'people'
          ? { lastName: label, firstName: 'Тест' }
          : { title: label, startDate: '2026-12-20', endDate: '2026-12-21', location: 'Синтетическое место' });
        items.push({ id: record.id, label: entity === 'people' ? `${label} Тест` : label });
        await json(`/api/${entity}/${record.id}`, 'DELETE');
      }
      async function openArchive() {
        await navigate('/archive');
        if (entity === 'events') await page.getByRole('button', { name: 'Мероприятия', exact: true }).click();
        for (const item of items) await page.getByRole('checkbox', { name: `Выбрать: ${item.label}`, exact: true }).check();
        await expect(page.getByText('Выбрано: 2', { exact: true })).toBeVisible();
      }
      await openArchive();
      page.once('dialog', dialog => dialog.dismiss());
      await page.getByRole('button', { name: 'Восстановить выбранные', exact: true }).click();
      for (const item of items) await expect(page.getByRole('checkbox', { name: `Выбрать: ${item.label}`, exact: true })).toBeChecked();
      page.once('dialog', dialog => { expect(dialog.message()).toContain('(2)'); return dialog.accept(); });
      const restored = page.waitForResponse(response => response.url().endsWith('/api/archive') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Восстановить выбранные', exact: true }).click();
      expect((await restored).status()).toBe(200);
      for (const item of items) {
        expect((await json(`/api/${entity}/${item.id}`)).deletedAt).toBeNull();
        await json(`/api/${entity}/${item.id}`, 'DELETE');
      }
      await openArchive();
      page.once('dialog', dialog => dialog.dismiss());
      await page.getByRole('button', { name: 'Удалить выбранные навсегда', exact: true }).click();
      for (const item of items) await expect(page.getByRole('checkbox', { name: `Выбрать: ${item.label}`, exact: true })).toBeChecked();
      page.once('dialog', dialog => { expect(dialog.message()).toContain('(2)'); return dialog.accept(); });
      const deleted = page.waitForResponse(response => response.url().endsWith('/api/archive') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Удалить выбранные навсегда', exact: true }).click();
      expect((await deleted).status()).toBe(200);
      for (const item of items) expect((await context.request.get(`${origin}/api/${entity}/${item.id}`)).status()).toBe(404);
    }
  });
  test('08 admin idle setting expires the browser session and requires fresh login', async () => {
    await switchToAdmin();
    await page.getByLabel('Минуты бездействия (1–1440)', { exact: true }).fill('1');
    await page.getByRole('button', { name: 'Сохранить таймер', exact: true }).click();
    await expect(page.getByText('Настройка сохранена.', { exact: true })).toBeVisible();
    expect((await json('/api/admin/session-settings')).idleTimeoutMinutes).toBe(1);
    await switchToPrimary('synthetic-updated-primary-password');
    // Let the real server timer expire. Browser status polling must not keep it alive.
    await expect(page).toHaveURL(`${origin}/login?expired=1`, { timeout: 80_000 });
    expect((await json('/api/auth/status')).authenticated).toBe(false);
    expect((await context.request.get(`${origin}/api/people`)).status()).toBe(401);
    await login(USERNAME, 'synthetic-updated-primary-password');
    expect((await json('/api/people?pageSize=200')).total).toBe(54);
  });
});
