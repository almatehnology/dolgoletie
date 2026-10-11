import { emptySnapshots, type Operation, type Snapshot, type SyncData } from '../lib/sync/types';
export const date='2026-01-01T00:00:00.000Z';
export function person(id='person'):Snapshot {return {id,lastName:'Иванов',firstName:'Иван',middleName:null,phone:null,notes:null,birthPlace:null,deletedAt:null,createdAt:date,updatedAt:date};}
export function op(id:string,before:Snapshot|null,after:Snapshot|null,parents:string[]=[],entity:Operation['entity']='Person'):Operation {
  return {id,entity,entityId:(after??before)!.id,before,after,parents,deviceId:`device-${id}`,sequence:1,createdAt:date};
}
export function data(snapshots:Snapshot[],operations:Operation[]):SyncData {const values=emptySnapshots();values.Person=snapshots;return {snapshots:values,operations,aliases:[]};}
