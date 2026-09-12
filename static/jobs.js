/* The database status is authoritative; this page can be closed at any time. */
const jobNames={clip:'匯出片段',trim:'整趟裁剪',restore:'還原影片',import:'整理上傳'};
const jobStates={queued:'等待執行',running:'處理中',cancelling:'正在取消',cancelled:'已取消',succeeded:'已完成',partial:'部分成功',failed:'失敗',interrupted:'重啟中斷'};
let jobRows=[],jobLimit=50,jobLoading=false;
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
function renderJobs(){
  const value=document.getElementById('filter').value,list=document.getElementById('job-list');list.replaceChildren();
  const rows=jobRows.filter(j=>!value||(value==='active'?['queued','running','cancelling'].includes(j.status):value==='failed'?['failed','interrupted'].includes(j.status):j.status===value));
  for(const j of rows){
    const card=node('article',undefined,'info-card');card.style.margin='16px 0';
    card.append(node('h2',jobNames[j.type]||j.type),node('p',(jobStates[j.status]||j.status)+' · '+new Date(j.created_at).toLocaleString()));
    const progress=node('progress');progress.max=100;progress.value=j.progress;progress.setAttribute('aria-label',jobStates[j.status]||j.status);card.append(progress,node('p',j.message));
    const actions=node('div',undefined,'form-row');
    for(const [action,label,allowed] of [['cancel','取消工作',j.can_cancel],['retry','重新執行',j.can_retry]])if(allowed){
      const button=node('button',label,'btn btn--ghost');button.onclick=async()=>{button.disabled=true;try{await apiFetch(`/api/jobs/${j.id}/${action}`,{method:'POST'});await loadJobs();}catch(e){showToast(e.message,'error');button.disabled=false;}};actions.append(button);
    }
    if(j.result?.clip?.id){const link=node('a','查看片段','btn');link.href='/clips#clip-'+j.result.clip.id;actions.append(link);}
    else if(j.type!=='import'){const link=node('a','回到旅程','btn');link.href='/trip/'+encodeURIComponent(j.target);actions.append(link);}
    else if(j.status==='succeeded'||j.status==='partial'){const link=node('a','瀏覽旅程','btn');link.href='/browse';actions.append(link);}
    card.append(actions);list.append(card);
  }
  if(!rows.length)list.append(node('p','目前沒有符合條件的工作。'));
}
async function loadJobs(){
  if(jobLoading)return;jobLoading=true;
  try {const rows=[];for(let offset=0;offset<jobLimit;offset+=50){const batch=await apiFetch('/api/jobs?offset='+offset);rows.push(...batch);if(batch.length<50)break;}jobRows=rows;renderJobs();document.getElementById('connection').textContent='狀態已更新';document.getElementById('more').hidden=rows.length<jobLimit;}
  catch(e){document.getElementById('connection').textContent='連線暫時中斷，背景工作不受影響：'+e.message;}finally{jobLoading=false;}
}
document.getElementById('filter').onchange=renderJobs;
document.getElementById('refresh').onclick=loadJobs;
document.getElementById('more').onclick=()=>{jobLimit+=50;loadJobs();};
(async()=>{await configReady;const user=await checkAuth();if(!user)return;renderHeader(user);await loadJobs();setInterval(()=>{if(!document.hidden)loadJobs();},4000);})();
