import {writeFileSync} from 'node:fs'
import {expect,it,vi} from 'vitest'
import type {PersistedStreamRequest} from '@action-driver/agent-runtime/ports'
import {RequestEventViews} from '__ROLLOUT__/request-event-view'
import {deriveRolloutEvents,rolloutEvents} from '__ROLLOUT__/event-bridge'
import type {RolloutLine} from '__ROLLOUT__/model'

it('returns the same first page as full replay after the request exceeds the cache budget',()=>{
  const request:PersistedStreamRequest={requestId:'r',taskId:'t',sessionId:'s',idempotencyKey:'k',responseId:'response',streamId:'stream',messageId:'message',status:'running',lastSequence:-1,createdAt:'2026-10-29T00:00:00Z',updatedAt:'2026-10-29T00:00:00Z'}
  const lines:RolloutLine[]=Array.from({length:2048},(_,i)=>({t:'event',seq:i+1,ts:request.createdAt,turnId:'t',type:'test.event',payload:{i}}))
  const expected=deriveRolloutEvents(lines,request).slice(0,1)
  expect(expected).toHaveLength(1)
  const views=new RequestEventViews({maxBytes:1,maxRequests:1})
  views.listAfter(request,lines,0,1)
  const spy=vi.spyOn(rolloutEvents,'deriveLine')
  const samples:number[]=[]
  try{
    for(let repeat=0;repeat<5;repeat++){
      spy.mockClear()
      expect(views.listAfter(request,lines,0,1)).toEqual(expected)
      samples.push(spy.mock.calls.length)
    }
  }finally{spy.mockRestore()}
  const output=process.env.ARCHITECTURE_KIT_MEASUREMENT
  if(output)writeFileSync(output,JSON.stringify({workload:'2048 test.event lines; budget=1 byte; oversized memo warmed; cursor=0; limit=1; 5 reads',samples}))
})
