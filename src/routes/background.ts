import type { FastifyInstance } from 'fastify';
import { makeRequireUser, type AppContext } from '../context.js';
import type { WorkRow } from '../background.js';
export function registerBackground(app:FastifyInstance,ctx:AppContext):void {
  const preHandler=makeRequireUser(ctx),tasks=ctx.tasks!;
  const publicRow=(r:WorkRow)=>({id:r.id,type:r.type,target:r.target,status:r.status,stage:r.stage,progress:r.progress,message:r.message,created_at:r.created_at,updated_at:r.updated_at,result:r.result?JSON.parse(r.result):null,can_cancel:tasks.canCancel(r.id),can_retry:tasks.retryable(r)&&(r.type!=='import'||ctx.sessions.get(r.target)?.status==='active')});
  app.get<{Querystring:{offset?:string}}>('/api/jobs',{preHandler},req=>{
    const offset=Math.max(0,Math.min(1e7,Number.parseInt(req.query.offset??'0',10)||0));
    return tasks.list(req.user!.id,false,offset).map(publicRow);
  });
  app.get<{Params:{id:string}}>('/api/jobs/:id',{preHandler},(req,reply)=>{
    const row=tasks.get(req.params.id);
    if(!row||row.owner_id!==req.user!.id)return reply.code(404).send({detail:'工作不存在'});
    return publicRow(row);
  });
  app.post<{Params:{id:string}}>('/api/jobs/:id/cancel',{preHandler},(req,reply)=>{
    const row=tasks.get(req.params.id);
    if(!row||row.owner_id!==req.user!.id)return reply.code(404).send({detail:'工作不存在'});
    if(!tasks.cancel(row.id))return reply.code(409).send({detail:'此階段無法取消，請等待結果儲存完成'});
    return {status:'cancelling'};
  });
  app.post<{Params:{id:string}}>('/api/jobs/:id/retry',{preHandler},async(req,reply)=>{
    const row=tasks.get(req.params.id);
    if(!row||row.owner_id!==req.user!.id)return reply.code(404).send({detail:'工作不存在'});
    if(!tasks.retryable(row))return reply.code(409).send({detail:'此工作不能重試'});
    const routes={clip:'/api/trip-clips/',trim:'/api/trip-trim/',restore:'/api/trip-trim/',import:'/api/upload-sessions/'};
    const result=await app.inject({method:row.type==='restore'?'DELETE':'POST',url:routes[row.type]+encodeURIComponent(row.target)+(row.type==='import'?'/confirm':''),headers:{cookie:req.headers.cookie??'',...(row.type==='clip'||row.type==='trim'?{'content-type':'application/json'}:{})},...(row.type==='clip'||row.type==='trim'?{payload:JSON.parse(row.payload)}:{})});
    return reply.code(result.statusCode).send(result.json());
  });
}
