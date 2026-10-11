import { ImportWizard } from '@/components/batch-import/import-wizard';

export default function PeopleImportPage() {
  return <div className="mx-auto flex max-w-7xl flex-col gap-4 py-5">
    <header><h1 className="text-2xl font-semibold">Пакетная загрузка людей</h1><p className="mt-1 text-sm text-default-500">Сопоставление DOCX/XLSX с карточками и сохранение после проверки.</p></header>
    <ImportWizard />
  </div>;
}
