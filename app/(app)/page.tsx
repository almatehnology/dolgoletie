import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="text-2xl font-semibold">Долголетие</h1>
        <p className="text-default-500 mt-1">
          Локальная база учёта физлиц и мероприятий. Выберите раздел, чтобы начать.
        </p>
      </section>
      <section className="grid gap-4 md:grid-cols-3">
        <Link
          href="/people"
          className="rounded-large border border-default-200 p-5 transition hover:border-primary"
        >
          <div className="text-sm text-default-500">Раздел</div>
          <div className="mt-1 text-lg font-medium">Люди</div>
          <div className="mt-2 text-sm text-default-500">
            Картотека: ФИО, контакты, паспорт, сканы, связанные мероприятия.
          </div>
        </Link>
        <Link
          href="/events"
          className="rounded-large border border-default-200 p-5 transition hover:border-primary"
        >
          <div className="text-sm text-default-500">Раздел</div>
          <div className="mt-1 text-lg font-medium">Мероприятия</div>
          <div className="mt-2 text-sm text-default-500">
            Даты, место, стоимость, участники, программа, размещение и транспорт для выездных.
          </div>
        </Link>
        <Link
          href="/data"
          className="rounded-large border border-default-200 p-5 transition hover:border-primary"
        >
          <div className="text-sm text-default-500">Раздел</div>
          <div className="mt-1 text-lg font-medium">База данных</div>
          <div className="mt-2 text-sm text-default-500">
            Резервные копии, импорт/экспорт и полная очистка локальной БД.
          </div>
        </Link>
      </section>
    </div>
  );
}
