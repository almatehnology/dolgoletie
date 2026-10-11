'use client';

import { useState } from 'react';
import { Button, Card } from '@heroui/react';
import { openLocalFiles, saveLocalFile } from '@/lib/desktop-files';
import { api } from '@/lib/store/api';
import { useAppDispatch, useAppStore } from '@/lib/store/hooks';
import { leaveAccount } from '@/lib/auth/client';
import type { Alias, ApplyResult, Decisions, MergePlan, RecordDecision, RecordPlan, Scalar } from '@/lib/sync/types';

type Preview={jobId:string;fingerprint:string;bundleId:string;plan:MergePlan;access:{required:boolean;message:string;requiresProof?:boolean}|null};
const entityNames={Person:'Человек',Event:'Мероприятие',Excursion:'Экскурсия',Participation:'Участие',PassportScan:'Документ или фото'};
const fieldNames:Record<string,string>={lastName:'Фамилия',firstName:'Имя',middleName:'Отчество',phone:'Телефон',birthDate:'Дата рождения',gender:'Пол',birthPlace:'Место рождения',registrationAddress:'Адрес',passportNumber:'Номер паспорта',passportIssuedBy:'Кем выдан паспорт',passportIssuedAt:'Дата выдачи паспорта',passportExpiresAt:'Срок паспорта',passportDepartmentCode:'Код подразделения',passportDetails:'Паспорт',notes:'Примечание',title:'Название',startDate:'Начало',endDate:'Окончание',location:'Место',cost:'Стоимость',currency:'Валюта',program:'Программа',isOutbound:'Выездное',accommodationPlace:'Проживание',accommodationOrder:'Размещение',mealType:'Питание',staysFrom:'Начало проживания',staysTo:'Окончание проживания',accommodationCost:'Стоимость проживания',transportType:'Транспорт',transportInfo:'Сведения о транспорте',transportCost:'Стоимость транспорта',eventId:'Мероприятие',personId:'Человек',name:'Название',paymentStatus:'Оплата',prepaidAmount:'Предоплата',totalDue:'К оплате',filename:'Имя файла',storedPath:'Оригинал файла',mimeType:'Тип файла',sizeBytes:'Размер файла',uploadedAt:'Дата загрузки',deletedAt:'В архиве',$exists:'Запись'};
function show(value:Scalar|undefined,field?:string) {
  if(field==='$exists') return value ? 'Сохранить запись' : 'Удалить запись';
  if(value==null || value==='') return 'Не заполнено';
  if(typeof value==='boolean') return value ? 'Да' : 'Нет';
  if(field==='storedPath') return 'Версия оригинала '+String(value).slice(-12);
  return String(value);
}
async function readJson(response:Response) {
  const data=await response.json();
  if(!response.ok) throw new Error(data?.error?.message ?? 'Не удалось выполнить синхронизацию');
  return data;
}
function initialDecisions(plan:MergePlan):Decisions {
  return Object.fromEntries(plan.records.map(r=>[r.key,{action:r.deletion || r.conflicts.length || r.constraint ? 'defer' : 'accept'}]));
}
function RecordReview({record,decision,onChange,disabled}:{record:RecordPlan;decision:RecordDecision;onChange:(v:RecordDecision)=>void;disabled:boolean}) {
  const changed=Object.keys(record.values).filter(f=>!['id','createdAt','updatedAt','thumbPath'].includes(f) && record.before?.[f]!==record.values[f]);
  return <Card>
    <Card.Header><Card.Title>{entityNames[record.entity]}: {record.label}</Card.Title><Card.Description>{record.kind==='create'?'Новая запись':record.kind==='delete'?'Удаление':record.kind==='unchanged'?'Подтверждение версии':'Изменения'}</Card.Description></Card.Header>
    <Card.Content className="flex flex-col gap-4 p-6">
      {record.deletion && <p className="text-sm text-danger">Поступило удаление{record.mergedIds.length ? ' при объединении карточек' : ''}. Выберите решение явно.</p>}
      {record.constraint && <p role="alert" className="text-sm text-danger">{record.constraint}</p>}
      {changed.length>0 && <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="p-2 text-left">Поле</th><th className="p-2 text-left">Сейчас</th><th className="p-2 text-left">После объединения</th></tr></thead><tbody>{changed.map(field=><tr key={field} className="border-t border-default-200"><td className="p-2">{fieldNames[field]??field}</td><td className="max-w-xs break-words p-2">{show(record.before?.[field],field)}</td><td className="max-w-xs break-words p-2">{show(record.values[field],field)}</td></tr>)}</tbody></table></div>}
      {record.conflicts.map(conflict=>{
        const values=[...conflict.options.map(o=>o.value)];
        if(!values.some(v=>JSON.stringify(v)===JSON.stringify(conflict.local))) values.push(conflict.local);
        const selected=decision.fields && Object.hasOwn(decision.fields,conflict.field) ? values.findIndex(v=>JSON.stringify(v)===JSON.stringify(decision.fields![conflict.field])) : -1;
        return <label key={conflict.field} className="flex flex-col gap-1 text-sm"><span>Конфликт: {fieldNames[conflict.field]??conflict.field}</span><select className="rounded-lg border border-default-300 bg-default-50 p-2" disabled={disabled} value={selected} onChange={event=>onChange({...decision,action:'accept',fields:{...decision.fields,[conflict.field]:values[Number(event.target.value)]}})}><option value={-1} disabled>Выберите значение</option>{values.map((value,index)=><option key={index} value={index}>{show(value,conflict.field)}{JSON.stringify(value)===JSON.stringify(conflict.local)?' (локальное)':''}</option>)}</select></label>;
      })}
      <label className="flex flex-col gap-1 text-sm"><span>Решение для записи</span><select className="rounded-lg border border-default-300 bg-default-50 p-2" value={decision.action} disabled={disabled} onChange={event=>onChange({...decision,action:event.target.value as RecordDecision['action']})}><option value="accept">{record.mergedIds.length?'Объединить карточки с выбранными значениями':record.kind==='delete'?'Принять удаление':'Применить выбранные значения'}</option><option value="keep-local">{record.mergedIds.length?'Объединить карточки, сохранить локальные значения':record.before?'Оставить локальную запись':'Не добавлять запись'}</option><option value="defer">Отложить всю запись</option></select></label>
      {decision.action==='defer' && <p className="text-xs text-default-500">Изменения этой записи останутся неподтверждёнными. Они появятся при следующем обмене.</p>}
    </Card.Content>
  </Card>;
}

export function SyncWorkspace() {
  const dispatch=useAppDispatch();
  const store=useAppStore();
  const [preview,setPreview]=useState<Preview|null>(null),[decisions,setDecisions]=useState<Decisions>({});
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null);
  const [file,setFile]=useState<File|null>(null),[password,setPassword]=useState(''),[localPassword,setLocalPassword]=useState('');
  const [accessChoice,setAccessChoice]=useState<'incoming'|'local'|'defer'>('defer'),[aliases,setAliases]=useState<Alias[]>([]);
  const [adminToken,setAdminToken]=useState<string|null>(null);
  function install(value:Preview) {setPreview(value);setDecisions(initialDecisions(value.plan));}
  async function operation(fn:()=>Promise<void>) {setBusy(true);setError(null);setMessage(null);try {await fn();}catch(e){setError(e instanceof Error?e.message:'Не удалось выполнить операцию');}finally{setBusy(false);}}
  async function chooseFile() {await operation(async()=>{const files=await openLocalFiles('sync');if(files?.[0])setFile(files[0]);});}
  async function download() {await operation(async()=>{
    const response=await fetch('/api/sync/export',{cache:'no-store'});if(!response.ok){await readJson(response);return;}
    const filename=/filename="([^"]+)"/.exec(response.headers.get('Content-Disposition')??'')?.[1]??'dolgoletie.tdbsync';
    if(await saveLocalFile(await response.blob(),filename)) setMessage(window.travelDesktop?'Файл обмена сохранён. Передайте его другим ноутбукам.':'Скачивание файла обмена началось. Проверьте завершение в браузере.');
  });}
  async function inspect() {if(!file)return;await operation(async()=>{
    const form=new FormData();form.append('file',file);if(password)form.append('password',password);
    const value=await readJson(await fetch('/api/sync/preview',{method:'POST',body:form}));
    if(preview) await fetch(`/api/sync/jobs/${preview.jobId}`,{method:'DELETE'});
    setAliases([]);setAccessChoice('defer');setPassword('');install(value);
  });}
  async function refresh(nextAliases=aliases) {if(!preview)return;await operation(async()=>{
    const value=await readJson(await fetch('/api/sync/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:preview.jobId,aliases:nextAliases})}));
    setAliases(nextAliases);install(value);
  });}
  async function apply() {if(!preview)return;await operation(async()=>{
    const result:ApplyResult=await readJson(await fetch('/api/sync/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:preview.jobId,fingerprint:preview.fingerprint,decisions,accessDecision:preview.access ? {choice:accessChoice,...(localPassword?{localPassword}:{})} : undefined})}));
    setLocalPassword('');dispatch(api.util.invalidateTags(['People','Person','Events','Event','Search']));
    setAdminToken(result.access?.requiresAdmin && result.access.adminToken ? result.access.adminToken : null);
    if(result.access?.requiresLogin) {setPreview(null);setFile(null);window.location.assign('/login');return;}
    setMessage(result.complete ? 'Синхронизация завершена. Создайте новый файл обмена и передайте остальным ноутбукам.' : `Применено записей: ${result.applied}. Отложено: ${result.deferred}.${result.access?.status==='pending'?' Завершение переноса доступа ожидает повторного запуска.':result.access?.status==='deferred'?' Изменения доступа отложены.':''}`);
    if(result.complete){await fetch(`/api/sync/jobs/${preview.jobId}`,{method:'DELETE'});setPreview(null);setFile(null);setAliases([]);}
    else if(result.access?.status!=='pending') {const value=await readJson(await fetch('/api/sync/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:preview.jobId})}));install(value);}
  });}
  const incomplete=preview?.plan.records.some(r=>decisions[r.key]?.action==='accept' && r.conflicts.some(c=>!decisions[r.key].fields || !Object.hasOwn(decisions[r.key].fields!,c.field)));
  return <div className="flex flex-col gap-6">
    <h1 className="text-2xl font-semibold">Ручная синхронизация</h1>
    <p className="text-sm text-default-500">Обменивайтесь одним файлом через флешку. Файл содержит записи, оригиналы фотографий и документов, историю изменений. При включённом шифровании он защищён паролем.</p>
    <Card><Card.Header><Card.Title>Передать изменения</Card.Title></Card.Header><Card.Content className="p-6"><Button variant="primary" onPress={download} isDisabled={busy}>Сохранить файл обмена</Button></Card.Content></Card>
    <Card><Card.Header><Card.Title>Получить изменения</Card.Title><Card.Description>Сначала проверьте предложенные изменения. Удаления и конфликты требуют вашего выбора.</Card.Description></Card.Header><Card.Content className="flex flex-col gap-3 p-6">
      <div className="flex items-center gap-3"><Button variant="outline" onPress={chooseFile} isDisabled={busy}>Выбрать файл обмена</Button><span className="break-all text-sm">{file?.name??'Файл не выбран'}</span></div>
      <label className="flex max-w-md flex-col gap-1 text-sm">Пароль файла, если он защищён<input className="rounded-lg border border-default-300 p-2" type="password" autoComplete="off" value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></label>
      <Button variant="primary" onPress={inspect} isDisabled={busy||!file}>Проверить и показать изменения</Button>
    </Card.Content></Card>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}{message && <p role="status" className="text-sm text-success">{message}</p>}
    {adminToken && <div className="flex flex-wrap items-center gap-3 text-sm"><span>Смену режима шифрования завершает admin.</span><Button variant="outline" onPress={() => leaveAccount(store, `/login?role=admin&syncToken=${encodeURIComponent(adminToken)}`)}>Войти как admin для подтверждения</Button></div>}
    {preview && <>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm">Записей в плане: {preview.plan.records.length}. Конфликтов: {preview.plan.records.filter(r=>r.conflicts.length||r.constraint).length}. Удалений: {preview.plan.records.filter(r=>r.deletion).length}.</p><Button variant="outline" onPress={()=>refresh()} isDisabled={busy}>Обновить план</Button></div>
      {preview.plan.candidates.length>0 && <Card><Card.Header><Card.Title>Возможные совпадения людей</Card.Title><Card.Description>Разные карточки с одинаковыми ФИО остаются отдельными. Объединяйте только после проверки.</Card.Description></Card.Header><Card.Content className="flex flex-col gap-3 p-6">{preview.plan.candidates.map(c=><label key={`${c.incomingId}:${c.localId}`} className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={busy} checked={aliases.some(a=>a.source===c.incomingId&&a.target===c.localId)} onChange={e=>{const next=aliases.filter(a=>a.source!==c.incomingId);if(e.target.checked)next.push({source:c.incomingId,target:c.localId});void refresh(next);}}/><span>Объединить карточки: {c.name}</span></label>)}</Card.Content></Card>}
      {preview.plan.records.map(r=><RecordReview key={r.key} record={r} decision={decisions[r.key]??{action:'defer'}} onChange={d=>setDecisions(prev=>({...prev,[r.key]:d}))} disabled={busy}/>)}
      {preview.access && <Card><Card.Header><Card.Title>Изменения доступа</Card.Title><Card.Description>{preview.access.message}</Card.Description></Card.Header><Card.Content className="flex flex-col gap-3 p-6"><label className="flex flex-col gap-1 text-sm">Решение<select className="rounded-lg border border-default-300 p-2" value={accessChoice} onChange={e=>setAccessChoice(e.target.value as typeof accessChoice)} disabled={busy}><option value="incoming">Принять доступ из файла</option><option value="local">Оставить локальный доступ</option><option value="defer">Отложить перенос доступа</option></select></label>{preview.access.requiresProof && accessChoice!=='defer' && <label className="flex max-w-md flex-col gap-1 text-sm">Текущий локальный пароль<input className="rounded-lg border border-default-300 p-2" type="password" autoComplete="off" value={localPassword} onChange={e=>setLocalPassword(e.target.value)} disabled={busy}/></label>}</Card.Content></Card>}
      <Button variant="primary" onPress={apply} isDisabled={busy||!!incomplete}>Подтвердить выбранные решения</Button>
      <p className="text-xs text-default-500">Отложенные записи и доступ не считаются принятыми. При изменении локальных данных потребуется обновить план.</p>
    </>}
  </div>;
}
