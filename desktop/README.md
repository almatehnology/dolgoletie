# Desktop: этапы 4 и 6

Оболочка запускает production Next standalone в Electron `utilityProcess`. Renderer изолирован: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`; preload требует только Electron и публикует ограниченный файловый мост. Ограничения preload соответствуют [sandbox API Electron](https://www.electronjs.org/docs/latest/tutorial/sandbox). Внешние запросы, окна, iframe/webview, скачивания Chromium и разрешения устройств запрещены. Данные находятся в отдельном `app.getPath('userData')`: `TravelDataBase` внутри системной папки приложений. NSIS сохраняет appData при обычном удалении. Выбор произвольной папки установки выключен; installer.nsh до установки и удаления проверяет пересечение каталога программы с папкой данных текущего пользователя, включая /D и зарегистрированные пути. Фактическая работа guard и install/update/uninstall требуют Windows-приёмки.

## Контракт для parent / UI

Использовать общую библиотеку `lib/desktop-files.ts` во всех новых сценариях таблиц, синхронизации и отчётов:

```ts
import { openLocalFiles, saveLocalFile } from '@/lib/desktop-files';

const files = await openLocalFiles('tables'); // Promise<File[] | null>, несколько DOCX/XLSX
const sync = await openLocalFiles('sync');    // один ZIP/TDBSYNC
const saved = await saveLocalFile(blob, 'Участники.xlsx'); // Promise<boolean>
// null / false — отмена; ошибки I/O/валидации reject и должны отображаться в UI.

// Необязательная отмена между блоками передачи:
const controller = new AbortController();
await saveLocalFile(blob, 'Обмен.tdbsync', { signal: controller.signal });
```

Desktop использует только async `dialog.showOpenDialog/showSaveDialog`. Browser fallback использует `input[type=file]` и Blob download; `true` в браузере означает начало скачивания, а не подтверждённую запись на диск. Родитель должен заменить прямые ссылки скачивания и существующие file inputs в соответствующих UI: оболочка намеренно блокирует скачивания Chromium, чтобы они не обходили системное сохранение. Изменения компонентов/API не входят в этот срез.

`tables`: до 32 `.docx/.xlsx`, 32 МиБ каждый, 128 МиБ суммарно. `sync`: один `.zip/.tdbsync`, до 1 ГиБ. Сохранение `.pdf/.xlsx/.jpg/.jpeg/.png/.webp`: до 64 МиБ; `.zip/.tdbsync/.tdbbackup`: до 1 ГиБ. JPEG имеет MIME `image/jpeg`, PNG — `image/png`, WebP — `image/webp`. Изображения разрешены только для сохранения, import chooser не расширяется. `.tdbbackup` имеет MIME `application/octet-stream` и предназначен для зашифрованного резервного архива; chooser синхронизации его отклоняет. Backup import остаётся отдельным UI с file input `.zip,.tdbbackup`. Эти расширения — транспортный контракт: content sniffing, версия пакета, шифрование и права остаются обязанностью соответствующих API. Старый ZIP не становится новым протоколом синхронизации только из-за выбора через этот диалог.

PDF-вложения в desktop сохраняются через `saveLocalFile`, затем пользователь открывает сохранённый файл во внешнем просмотрщике. UI должен ясно предлагать «Сохранить PDF для просмотра»: встроенный `<object>` заблокирован CSP `object-src 'none'`. В браузере может оставаться встроенный PDF-просмотр. CSP и HTTP origin/token boundary сохраняются; desktop не получает произвольного `shell` API или автоматического открытия внешних программ.

`File[]` требует памяти для выбранных файлов в renderer. Чтение с диска и IPC ограничены блоками по 256 КиБ, по одному запросу одновременно; это не обещание постоянного потребления памяти при импорте большого файла. При сохранении используется `Blob.slice()` с ожиданием подтверждения каждого блока, без полного `arrayBuffer()` и без base64. Сам Blob создаёт вызывающая сторона; streaming HTTP export можно добавить отдельно при необходимости больших пакетов.

`window.travelDesktop` содержит только `version`, `selectFiles`, `readFileChunk`, `releaseFiles`, `beginSave`, `writeSaveChunk`, `finishSave`, `cancelSave`. Низкоуровневые операции принимают случайные 256-bit capability IDs, смещение и ограниченный Uint8Array. Нет `invoke(channel)`, путей, `fs`, `shell`, URL открытия, подписок на IPC или доступа к Node. Использовать библиотеку, а не мост напрямую. Каждый IPC проверяет зарегистрированное окно, main frame и точный origin текущего запуска. Capability IDs принадлежат одному окну; смена документа, авария renderer и завершение приложения их отзывают. Таймаут простоя — 2 минуты, общий срок — 30 минут; новые диалоги/операции при занятом брокере отклоняются.

Сохранение создаёт `wx`-temp с mode `0600` в каталоге, выбранном системным диалогом; фактические права определяются ОС и файловой системой. Проверяются расширение, число полученных байт, последовательность смещений и неизменность ранее существовавшего назначения; затем выполняются file `fsync`, закрытие и rename в той же файловой системе. Назначение не удаляется перед rename. При ошибке/отмене временный файл удаляется, исходный файл сохраняется. Ошибка удаления остаётся видимой, а отменённая capability не может продолжить запись. Заблокированное назначение Windows даёт ошибку без обхода через удаление. Атомарность и поведение при внезапном обесточивании/извлечении флешки зависят также от файловой системы носителя; это требует проверки на целевых устройствах. При принудительном завершении ОС временный файл может остаться в выбранном каталоге: произвольные внешние каталоги на следующем запуске не сканируются.

## Локальный сервер и окружение

Main слушает `powerMonitor` `lock-screen` и `suspend`. `lifecycle.cjs` отправляет фиксированный `POST /api/auth/logout` через session текущего окна с `credentials: include`, явными `Origin` и `X-TDB-Desktop-Token`, без переходов HTTP redirect. Успех отзывает файловые capabilities и загружает `/login`; ошибка или таймаут 5 секунд завершает приложение и его data worker. Parent logout закрывает vault/DB и уничтожает сессию. `resume` и `unlock-screen` не выполняют вход и не восстанавливают ключи. Это main-only control: preload/renderer не получает нового API или произвольного канала. Реальную блокировку/сон ОС и фактическое закрытие разблокированного vault нужно проверять отдельно; автоматическая проверка ниже использует синтетический endpoint и события.

`server-worker.cjs` устанавливает границу HTTP до загрузки `server.js`: единственный HTTP listener принудительно привязывается к `127.0.0.1:0`. В установленном Next 15 `start-server` берёт фактический порт из `server.address()` до создания обработчиков; здесь нет гонки reserve/close/rebind. Нужна повторная проверка этой интеграции при обновлении Next. Worker сообщает origin через приватный канал utilityProcess, main ждёт HTTP-ответа этого процесса и открывает окно только после готовности. WebSocket upgrades запрещены.

Все HTTP-запросы, включая публичные страницы и static, требуют `X-TDB-Desktop-Token` — случайный 256-bit токен на запуск. Main добавляет его только запросам своей изолированной in-memory session на точный origin. Проверяются также Host, loopback remote address, Origin (если есть) и повторные заголовки. Токен не передаётся в URL/preload/renderer, не записывается на диск и не заменяет пользовательскую авторизацию. Внешний браузер/другой локальный процесс без токена получает 403. Отдельный guard в parent API не обязателен для этого транспорта; если его добавлять, согласованные имена — `DESKTOP_MODE=1`, `DESKTOP_LAUNCH_TOKEN`, `DESKTOP_ORIGIN` и `X-TDB-Desktop-Token`. Browser/Docker режим не должен требовать этот токен.

В utilityProcess передаются только необходимые переменные ОС и:

| Переменная | Значение |
| --- | --- |
| `NODE_ENV`, `HOSTNAME`, `PORT` | `production`, `127.0.0.1`, `0` |
| `DATA_DIR` | `<userData>/data` |
| `DATABASE_URL` | Абсолютный file URL `<userData>/data/data.db`, включая Windows paths |
| `UPLOADS_DIR` | `<userData>/uploads` |
| `AUTH_FILE` | `<userData>/data/auth.json` |
| `SESSION_SECRET` | Случайный секрет на запуск; веб-сессии не переживают перезапуск |
| `COOKIE_SECURE` | `false`, локальный HTTP |
| `NEXT_TELEMETRY_DISABLED` | `1` |

Storage вычисляет `vault.json` из `DATA_DIR`; неиспользуемые `VAULT_PATH`/`VaultPath` удалены. Parent должен использовать перечисленные переменные и выполнять свои миграции через runtime после необходимой разблокировки. Desktop не запускает Prisma CLI, seed, `migrate deploy`, `db push` и не открывает пользовательскую базу при проверке драйверов. Старый `APP_PASSWORD` из `.env` не наследуется: этот срез рассчитан на интеграцию новых локальных учётных записей parent. Секреты/пути `.env`, proxy settings, `NODE_OPTIONS`, `NODE_PATH` и `ELECTRON_RUN_AS_NODE` не наследуются. На Windows разрешённые системные переменные передаются с одним каноническим написанием имени.

## Сборка, которую подключает parent

Выбран electron-builder; конфигурация — `desktop/electron-builder.cjs`. Не менялись `package.json`, lock, Next config или Docker. Скрипты/зависимость electron-builder добавляет parent:

1. Собрать Next production standalone на целевых ОС/архитектурах.
2. `node desktop/prepare.cjs` копирует standalone в `desktop/stage/next`, добавляет `.next/static`, доступные `public`, `assets` и runtime-миграции. Поддерживаются корневой `server.js` и вложенный каталог с именем текущего проекта, созданный Next при tracing из workspace root. Общая политика `resource-policy.cjs` исключает env-файлы без учёта регистра, DB/SQLite и WAL/SHM/journal, `prisma/data` на любой глубине, metadata учётных записей/vault/instance и переходов, pending-access/vaults, ZIP/TDBSYNC/TDBBACKUP, root data/uploads и `.git`. Скомпилированные маршруты `.next/server/app/**/data` сохраняются. Политика применяется также к static/public/assets/migrations; содержимое исключаемых файлов не читается. Внутренние ссылки копируются как обычные ресурсы; выход ссылки за собственный исходный каталог приводит к отказу. Сначала проверяется наличие сборки, поэтому её отсутствие не удаляет предыдущий stage; при ошибке во время копирования stage может быть неполным и должен быть подготовлен заново. `desktop/stage/app` содержит только CJS оболочки и минимальный package.json без серверных зависимостей.
3. Локальный запуск: `electron desktop/main.cjs`.
4. Упаковка: `electron-builder --config desktop/electron-builder.cjs`. `directories.app` указывает на минимальную оболочку, main — `main.cjs`; сервер лежит вне ASAR в `resources/next`. `node_modules` сервера имеет отдельное extraResources mapping: builder исключает root `node_modules` при обычном обходе файлов даже в extraResources. `verify-package.cjs` в afterPack проверяет разрешение Next/нативных пакетов/generated Prisma только из поставляемого ресурса, наличие static и отсутствие env/user data. Это проверка файлов, а не загрузка native в Electron.

Убедиться, что Next file tracing включает `better-sqlite3-multiple-ciphers`, `argon2`, `sharp`, Prisma client/generated assets и **все их транзитивные файлы и native prebuilds**, а также ресурсы runtime storage/migrations. Для этих пакетов parent при необходимости добавляет `serverExternalPackages` и `outputFileTracingIncludes` в своей области. Worker явно отказывает при отсутствии нативных пакетов внутри standalone; загрузка из соседнего global/system `node_modules` не считается поставкой. Builder не пересобирает эти ресурсы автоматически (`npmRebuild: false`).

## Нативные драйверы и пределы проверки

Используется Node Electron из [`utilityProcess`](https://www.electronjs.org/docs/latest/api/utility-process), без установленного в системе Node и без `ELECTRON_RUN_AS_NODE`. Нативные зависимости должны подходить целевой ОС/архитектуре и Node-API/ABI Electron; [Electron описывает требования к native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules). На текущем Mac arm64 фактически запущен Electron 44.7.0 utilityProcess: Node 24.21.0, ABI 149, N-API 10. SQLite cipher, Argon2 hash/verify и sharp PNG encode загрузили `.node` из standalone; также загрузился generated Prisma client. Preflight использует отдельную временную encrypted SQLite DB, проверяет отсутствие plaintext SQLite header и чтение после повторного открытия, затем удаляет её. Драйвер запрещает ключи для `:memory:`, поэтому прежний in-memory preflight был исправлен после реального запуска. Пользовательская БД не затрагивается. Разрешённые пакеты и все загруженные native bindings проверяются через realpath внутри поставляемого standalone.

Если реальный utilityProcess выявит несовместимость, нужен target-compatible native build/prebuild. Если драйвер невозможно использовать в utilityProcess, альтернативой будет **собственный поставляемый Node runtime** и зависимости именно для него, с тем же HTTP guard и управлением завершением. Такой runtime сейчас не включён; переключение на системный `node` не выполняется. macOS подпись native libraries, entitlements/Helper, notarization и Windows installer/signing должны быть проверены parent в release-сборках; ослабление `allowLoadingUnsignedLibraries` здесь не включено.

`tsx --test tests/desktop*.test.ts` проверяет IPC/preload, renderer-передачи/отмену, реальные файловые операции, loopback HTTP guard, упаковку и lifecycle control. На 11.10.2026 проходят 31 тест.

## Автоматическая Electron acceptance без видимых окон

```sh
node e2e/desktop-run.cjs
node e2e/desktop-run.cjs --packaged desktop/dist/mac-arm64/TravelDataBase.app
```

Harness из `e2e/desktop-harness.cjs` задаёт временный appData до загрузки неизменённого production main, скрывает окно и перехватывает системные open/save **до** любого IPC. В production shell harness не поставляется, тестовых переключателей в main/preload нет. При `--packaged` копируется `.app` с сохранением относительных framework symlinks, в копии ASAR добавляется только test entrypoint; исходная сборка остаётся неизменённой. Это запуск настоящего macOS executable/helpers и ресурсов с `app.isPackaged=true`, но подпись и notarization изменённой тестовой копии не принимаются этим сценарием. Playwright CDP работает при `devTools: false`; тест не открывает DevTools.

Новая временная папка выводится как `DESKTOP_QA_ARTIFACTS`. `evidence.json`, `electron.log`, `screenshots/desktop-launch.png` фиксируют runtime/native paths, 403 без токена/с неверными Origin/Host, отсутствие Node в renderer, отдельные cookies при реальном Electron Session.fetch, передачу двух блоков с проверкой SHA-256, overwrite/cancel/cleanup, `.tdbbackup` save и отказ sync chooser, сохранность назначения при незавершённом экспорте, exit worker 0 и закрытый порт. Fixtures синтетические, файловая проверка не доказывает XLSX/PDF/backup content parsing. Cleanup ожидает app.quit и завершение принадлежащего worker.

Обычный root startup исправлен через skipMiddlewareUrlNormalize. Последняя скрытая packaged acceptance на 11.10.2026 прошла без --start-setup: Build ID p3rVw2d01CDX_O9IqoxvV, `/var/folders/dg/886yv4xj76x2lv64cvp6nxnr0000gp/T/tdb-desktop-acceptance-2nvQr2/`. Проверены нативные драйверы внутри ресурсов, граница HTTP/IPC, ограниченная передача файлов, отмена/перезапись, synthetic lock-screen, отсутствие автоматического восстановления на unlock/resume и завершение worker. Приложение и диалоги были скрыты. Тестовая копия .app удалена; evidence сохранено. Подпись и notarization этой проверкой не подтверждаются.

Реальные нативные диалоги не приняты: владелец отменил попытки и запретил дальнейший видимый flow. Обе отменённые попытки завершились до записи; в temporary fixtures осталась только тестовая таблица, worker exit 0. Нужна отдельная согласованная приёмка диалогов, removable media, ошибок доступа/извлечения и физических lock/suspend. Windows и macOS x64 runtime на этом Mac не проверены. Функциональная оболочка реализована; приёмка installer/update и подписи/notarization релизной сборки остаётся отдельной.

## Стратегия CI для остальных платформ

Собирать Next, зависимости и desktop stage на **самой целевой ОС/архитектуре**: macOS arm64, macOS x64 и Windows x64 — независимые native runners. Не переносить standalone/native dependencies с Mac в Windows или между архитектурами. На каждом runner выполнить install по lockfile, Prisma generate, typecheck/unit tests, Next build, desktop prepare, скрытый `node e2e/desktop-run.cjs` и builder `--dir` с `--publish never` для своей платформы. На macOS затем выполнить скрытый packaged сценарий; Windows packaged/installer acceptance требует отдельного Windows harness/окружения (нынешний `--packaged` поддерживает только `.app`). Артефакты evidence/screenshots и builder outputs сохранять при провале. Signing/notarization/NSIS install-uninstall/update и physical lock/removable-device QA — отдельные release проверки; `deleteAppDataOnUninstall: false` уже задан в NSIS config, но удаление на Windows фактически не проверено.

## Отчёт ограниченного Windows-аудита, 11.10.2026

Добавлен `.github/workflows/windows-x64.yml`, запускаемый только вручную. Windows 2022 x64 / Node 24 выполняет `npm ci` с загрузкой Electron, Prisma generate, полный единый набор `tests/*.test.ts` и `desktop/*.test.cjs`, typecheck, fresh Next build с parent sanitizer, prepare, скрытую stage acceptance, проверку Windows x64 native evidence, builder `--dir` и NSIS с `--publish never`, независимую проверку ресурсов и загрузку диагностических артефактов. Ошибки unit tests не скрываются: после сбора build/runtime evidence job завершает явный failure gate. Установщик не запускается. Workflow не отправлялся и не запускался внешне.

`scripts/run-tests.cjs` перечисляет и сортирует файлы, передаёт абсолютные пути в Node без shell и загружает tsx через file URL; Windows shell glob не нужен. Рекомендованная parent запись `"test": "node scripts/run-tests.cjs"` уже установлена parent. Отдельный повтор portability suite в CI удалён. Для Next-only Docker install parent уже использует `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`; desktop CI удаляет эту переменную, потому что скрытая acceptance требует Electron executable. `.github/workflows/docker-web.yml` принадлежит parent и этим срезом не изменялся.

Проверены lock/native loader sources: Electron 44.7.0 требует install Node >=22.12; Next 15.5.27, SQLite cipher 13.0.3, Argon2 0.45.1, sharp 0.35.5 и Prisma 6.19.3. SQLite и Argon2 содержат Windows x64 prebuilds, sharp имеет отдельный Windows x64 optional package, Prisma client/engine нужно генерировать на Windows. Это подтверждает наличие пути сборки, а не совместимость конкретных бинарников с Electron: её проверяет настоящий utilityProcess в CI. `npmRebuild:false` не пересобирает native extraResources. [Требования Electron к native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules) требуют проверки целевого runtime.

Локально через CLI прошли 31 выбранный тест из desktop validation/files/packaging/server и auth-store до удаления неиспользуемых vault aliases; финальный новый portability suite прошёл 6/6 и отдельно проверяет runtime environment; parent независимо сообщил о повторном 6/6. `auth-store.test.ts` использует file URL для межпроцессного импорта, сохраняет все проверки данных и concurrency, проверяет POSIX mode только на POSIX и пропускает Windows symlink test только при фактическом отказе создания ссылки из-за прав/поддержки. Никакие реальные user data или env-файлы не читались. Packaging fixtures синтетические. Найденный parent generated DB artifact не исследовался; источник и содержимое неизвестны, утечка клиентских данных не установлена.

Изменённые этим срезом файлы: `desktop/prepare.cjs`, `desktop/verify-package.cjs`, `desktop/resource-policy.cjs`, `desktop/runtime.cjs`, `desktop/validation.cjs`, `desktop/portability.test.cjs`, этот README, `.github/workflows/windows-x64.yml`, `scripts/run-tests.cjs`, `tests/auth-store.test.ts`. `package.json`, lock, e2e, generated stage/dist и Docker workflow изменяет только parent.

Завершённые исправления и оставшиеся ограничения:

- Parent согласовал desktop-server тест с file URL и фактическими storage variables; отдельная проверка прошла.
- Риск пересечения папок закрыт в конфигурации и installer.nsh: произвольный выбор выключен, установочные и удаляющие hooks отклоняют пересечение до файловых операций. Поведение основано на [NSIS scripting reference](https://nsis.sourceforge.io/Docs/Chapter4.html) и [hooks electron-builder 26](https://www.electron.build/v26/docs/nsis/). Макросы успешно скомпилированы NSIS 3.0.4.1 на Mac в отдельном синтетическом сценарии: `/var/folders/dg/886yv4xj76x2lv64cvp6nxnr0000gp/T/tdb-nsis-syntax-l6enht/`. Полученный тестовый exe не запускался. Полная Windows-поставка и реальное удаление остаются непроверенными.
- Права `0600/0700` не доказывают Windows ACL isolation. Junctions, locked-file rename, длинные/UNC пути, removable media, физический lock/suspend и закрытие разблокированного vault остаются Windows QA. Текущий broker оставляет отказ очистки видимым и повторяет её перед следующей передачей; недоступный носитель может блокировать новые операции до успешной очистки.
- Windows packaged executable/installer runtime и подпись не проверены; существующий packaged harness поддерживает только Mac `.app`. Новая CI stage acceptance не заменяет эту проверку. Финальный rebuild, браузерная и packaged Mac acceptance выполнены parent. Docker и Windows здесь не запускались; результаты полного набора тестов зафиксированы в ../docs/IMPLEMENTATION_STATUS.md.
