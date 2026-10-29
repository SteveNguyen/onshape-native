import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {pageCommand} from '../extension/page-adapter.js';

const target = {did:'a'.repeat(24),wid:'b'.repeat(24),eid:'c'.repeat(24)};
const micro = 'd'.repeat(24);
class Folder {
  constructor(){this.elementId='';this.messageId='';this.folderName='';this.begin=null;this.end=null;this.editDescription='';}
  getMessageName(){return 'partstudiofolders.GBTUiCreateFolder';}
  getClassId(){return 2538;}
}
class Location {
  constructor(){this.nodeId='';this.before=true;this.childFieldIndex=-1;}
  getMessageName(){return 'tree.GBTInsertionLocation';}
}
let sent=[];
function setup(definition, current=false){
  globalThis.crypto ||= webcrypto;
  globalThis.location = {origin:'https://cad.onshape.com',pathname:`/documents/${target.did}/w/${target.wid}/e/${target.eid}`};
  sent=[];
  const controller = {getActiveElementTabId:()=>target.eid,
    documentModel:{get:k=>k==='microversionId'?{theId:micro}:{get:()=>null,definition}},
    documentClientCache:{getModelTreeState:()=>({diffableModelTree:{getRoot:()=>({children:[]})}})},
    elementConnection:{callAndPromise:async m=>{sent.push(m);return {errorEnum:0};}}};
  const modules = {27940:{CJP:()=>{},D0n:()=>{},Folder,Location},3392:{GI:{getOpenDocumentController:()=>controller}}};
  if (current) { modules[96402]=modules[27940]; modules[87539]=modules[3392]; delete modules[27940]; delete modules[3392]; }
  const chunks=[];chunks.push=value=>{Array.prototype.push.call(chunks,value);value[2](id=>modules[id]);};
  globalThis.webpackChunkNewton=chunks;
  return modules;
}
test('exact target and revision checked before mutation',async()=>{
  setup();const job={kind:'native',target,command:'partstudiofolders.GBTUiCreateFolder',body:{folderName:'Test'},expected_microversion:'e'.repeat(24)};
  assert.match((await pageCommand(job)).error,/revision changed/);assert.equal(sent.length,0);
  globalThis.location.pathname='/documents';assert.match((await pageCommand({...job,expected_microversion:micro})).error,/navigated/);assert.equal(sent.length,0);
});
test('typed nested messages reach native connection and caller IDs are replaced',async()=>{
  setup();await pageCommand({kind:'native',target,command:'partstudiofolders.GBTUiCreateFolder',expected_microversion:micro,
    body:{folderName:'Test',messageId:'captured',begin:{$type:'tree.GBTInsertionLocation',nodeId:'current-node'}}});
  assert.equal(sent.length,1);assert.ok(sent[0] instanceof Folder);assert.ok(sent[0].begin instanceof Location);assert.notEqual(sent[0].messageId,'captured');
});
test('schema drift and prototype fields fail before sending',async()=>{
  setup();const base={kind:'native',target,command:'partstudiofolders.GBTUiCreateFolder',expected_microversion:micro};
  assert.match((await pageCommand({...base,body:{inventedField:1}})).error,/Unknown.*field/);
  assert.match((await pageCommand({...base,body:JSON.parse('{"__proto__":{}}')})).error,/Invalid native field/);
  assert.equal(sent.length,0);
});
test('state returns the native tree and microversion without HTTP',async()=>{
  setup();const state=await pageCommand({kind:'state',target});assert.equal(state.microversion,micro);assert.deepEqual(state.tree,{children:[]});assert.equal(sent.length,0);
});

test('assembly sidebar Map entries survive serialization with typed nodes',async()=>{
  const node={displayName:'Folder',childrenCount:0,getMessageName(){return 'assembly.tree.GBTAssemblyTreeFolder'}};
  setup({assembly:{nodeId:'root'},assemblyTree:{isValid:true,pathToNodes:new Map([['Ffolder',node]])}});
  const state=await pageCommand({kind:'state',target});
  assert.equal(state.assemblyTreeValid,true);
  assert.deepEqual(state.assemblyTree.pathToNodes.$map,[['Ffolder',{$type:'assembly.tree.GBTAssemblyTreeFolder',displayName:'Folder',childrenCount:0}]]);
});

test('REST preserves errors and download metadata without forwarding CSRF on GET redirects',async()=>{
  setup();globalThis.document={cookie:'XSRF-TOKEN=test-cookie'};
  let request;
  globalThis.fetch=async(url,options)=>{request=options;return new Response(JSON.stringify({message:'Invalid parameter',status:400}),{status:400,headers:{'content-type':'application/json','etag':'version'}});};
  const result=await pageCommand({kind:'rest',path:'/api/v17/documents',method:'GET',request_headers:{'If-None-Match':'version'}});
  assert.equal(result.status,400);assert.equal(result.body.message,'Invalid parameter');assert.equal(result.response_headers.etag,'version');
  assert.equal(request.redirect,'follow');assert.equal(request.credentials,'same-origin');assert.equal(request.headers['X-XSRF-TOKEN'],undefined);
  assert.equal(request.headers['If-None-Match'],'version');
  await pageCommand({kind:'rest',path:'/api/v17/documents',method:'POST',body:{name:'sample'}});
  assert.equal(request.redirect,'error');assert.equal(request.headers['X-XSRF-TOKEN'],'test-cookie');
});

test('page and extension REST refuse non-canonical paths before fetching',async()=>{
  setup();globalThis.document={cookie:''};
  const {restGet}=await import('../extension/rest-get.js');
  globalThis.fetch=async()=>assert.fail('must not fetch');
  for (const path of ['/api/v6/documents;x=1','/api/v6/documents/a%252Fb','/api/v6/docu\tments','/api/v6/documents%09','/api/v6/x%5Cy','/api/v6/x%3Fy']) {
    assert.match((await pageCommand({kind:'rest',path,method:'GET'})).error,/Invalid API path/,path);
    await assert.rejects(restGet({kind:'rest',method:'GET',path}),/Invalid API path/,path);
  }
});

test('runtime rejection returns a structured diagnostic rather than a discarded promise',async()=>{
  setup();delete globalThis.webpackChunkNewton;
  const result=await pageCommand({kind:'state',target});assert.match(result.error,/runtime unavailable/);assert.match(result.outcome,/Inspect/);
});

test('extension GET observes only its own redirect Location and removes the listener',async()=>{
  const {restGet}=await import('../extension/rest-get.js');
  let listener,removed=false;
  globalThis.chrome={runtime:{id:'a'.repeat(32)},webRequest:{onHeadersReceived:{addListener(fn){listener=fn},removeListener(fn){removed=fn===listener}}}};
  globalThis.fetch=async(url,options)=>{
    assert.equal(options.redirect,'manual');assert.equal(options.credentials,'include');assert.equal(options.headers['X-XSRF-TOKEN'],undefined);
    listener({url:url.href,method:'GET',initiator:'https://cad.onshape.com',statusCode:307,responseHeaders:[{name:'Location',value:'https://wrong.example'}]});
    listener({url:url.href,method:'GET',initiator:`chrome-extension://${chrome.runtime.id}`,statusCode:307,responseHeaders:[{name:'Location',value:'https://sample.s3.amazonaws.com/sample'},{name:'set-cookie',value:'must-not-escape'}]});
    return {type:'opaqueredirect'};
  };
  const result=await restGet({kind:'rest',method:'GET',path:'/api/v17/export'});
  assert.equal(result.download_redirect,'https://sample.s3.amazonaws.com/sample');assert.ok(removed);assert.ok(!JSON.stringify(result).includes('must-not-escape'));
});

test('current captured frontend profile resolves state', async()=>{
  setup(undefined,true);assert.equal((await pageCommand({kind:'state',target})).microversion,micro);
});
test('missing controller export and accessor fail before native RPC',async()=>{
  for (const value of [{}, {GI:{}}]) {
    const modules=setup(undefined,true);modules[87539]=value;
    const result=await pageCommand({kind:'native',target,command:'partstudiofolders.GBTUiCreateFolder',body:{},expected_microversion:micro});
    assert.match(result.error,/87539:controller-accessor-missing/);assert.equal(sent.length,0);
  }
});
test('untested schema-only native commands require the policy opt-in',async()=>{
  const modules=setup();
  modules[27940].Untested=class{constructor(){this.messageId='';}getMessageName(){return 'ui.GBTUiUntestedCall';}getClassId(){return 1;}};
  const job={kind:'native',target,command:'ui.GBTUiUntestedCall',body:{},expected_microversion:micro};
  assert.match((await pageCommand(job)).error,/untested.*popup/i);assert.equal(sent.length,0);
  await pageCommand({...job,allow_untested_native:true});assert.equal(sent.length,1);
  await pageCommand({...job,command:'partstudiofolders.GBTUiCreateFolder'});assert.equal(sent.length,2);
});
test('ui_action refuses admin-looking controls unless the worker allowed admin',async()=>{
  setup();
  const act=async(label,admin_allowed)=>{
    let clicked=false;
    const el={isConnected:true,disabled:false,textContent:label,getClientRects:()=>[1],matches:()=>false,getAttribute:()=>null,focus(){},click(){clicked=true;}};
    globalThis.__onshapeNativeUI={snapshot:'s',nodes:[el],pathname:globalThis.location.pathname,created:Date.now()};
    const result=await pageCommand({kind:'ui_action',target,snapshot:'s',control:0,action:'click',expected_microversion:micro,admin_allowed});
    return {result,clicked};
  };
  for (const label of ['Share','Make public','Manage permissions','Delete document','Transfer ownership','Webhooks']) {
    const {result,clicked}=await act(label,undefined);assert.match(result.error,/admin/i,label);assert.equal(clicked,false);
  }
  assert.equal((await act('Share',true)).clicked,true);
  assert.equal((await act('Extrude',false)).clicked,true);
});
test('missing message classes fail before native RPC',async()=>{
  const modules=setup(undefined,true);delete modules[96402].CJP;
  assert.match((await pageCommand({kind:'state',target})).error,/96402:message-classes-missing/);assert.equal(sent.length,0);
});

class Measure {
  constructor(){this.elementId='';this.messageId='';this.viewerId='';this.entityQueries=[];}
  getMessageName(){return 'ui.GBTUiMeasureCall';}
}

test('Measure goes on the document connection with the 3D view id, like the editor measurement panel',async()=>{
  const modules=setup();modules[27940].Measure=Measure;
  const controller=modules[3392].GI.getOpenDocumentController();
  const onDocument=[];
  controller.connection={isClosed:()=>false,callAndPromise:async m=>{onDocument.push(m);return {measurements:[]};}};
  controller.getViewer=()=>({getViewerId:()=>'viewer-1'});
  const result=await pageCommand({kind:'native',target,command:'ui.GBTUiMeasureCall',body:{}});
  assert.equal(result.error,undefined);
  assert.equal(sent.length,0);assert.equal(onDocument.length,1);
  assert.equal(onDocument[0].viewerId,'viewer-1');
});

test('a native call the editor never answers ends after 60 s instead of holding the extension',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const job={kind:'native',target,command:'partstudiofolders.GBTUiCreateFolder',expected_microversion:micro,body:{folderName:'T'}};
  const modules=setup();modules[3392].GI.getOpenDocumentController().elementConnection.callAndPromise=()=>new Promise(()=>{});
  const pending=pageCommand(job);
  await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(60000);
  assert.match((await pending).error,/No reply from the editor within 60 s/);
});
