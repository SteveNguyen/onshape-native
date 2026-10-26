import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {displayCommand} from '../extension/display-adapter.js';
const target={did:'a'.repeat(24),wid:'b'.repeat(24),eid:'c'.repeat(24)}, micro='d'.repeat(24);
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function setup({parentHidden=false,offline=false,current=false,partStudio=false,section=true}={}) {
 globalThis.crypto ||= webcrypto;globalThis.location={origin:'https://cad.onshape.com',pathname:`/documents/${target.did}/w/${target.wid}/e/${target.eid}`,search:''};
 const sent=[],transforms=new Map([['part',identity.slice()]]);
 let revision=micro,closed=offline;
 const node=(type,name,children_count=0)=>({displayName:name,childrenCount:children_count,hidden:false,suppressed:false,suppressedByParent:false,getMessageName:()=>`assembly.tree.GBTAssemblyTree${type}`});
 const root=node('Instance','Root',2),part=node('Instance','Part',1),connector=node('MateConnector','Inherited'),mate=node('Mate','Joint');
 connector.featureId='Fderived.*merge.Fconnector';connector.partStudioMateConnector=true;mate.mateType='REVOLUTE';
 const makeItem=(node,path,feature_id)=>({treeNode:node,isFeature:!!feature_id,isFolder:false,isParentHidden:parentHidden&&node===connector,
  getCanBeHidden:()=>true,getOccurrence:()=>({path}),getFeatureId:()=>feature_id,getVisibility:()=>node.hidden?1:2});
 const items=[makeItem(part,['part']),makeItem(connector,['part'],connector.featureId),makeItem(mate,[],'mate')];
 const tree={isValid:true,pathToNodes:new Map([['',root],['part',part],['part.connector',connector],['mate',mate]])};
 const classes={CJP:()=>{},D0n:()=>{},z_V:{VISIBLE:2,HIDDEN:1}};
 for (const name of ['assembly.GBTOccurrence','assembly.GBTFeatureReference','ui.assembly.GBTUiBatchVisibilityChange','ui.assembly.GBTUiChangeOccurrenceVisibility','ui.assembly.GBTUiSetFeatureOccurrenceVisibility','assembly.GBTUiAssemblyAnimateMateRequest']) {
  classes[name]=class {
   constructor(){this.occurrenceVisibilityCalls=[];this.featureOccurrenceVisibilityCalls=[];this.mate={};this.numFrames={};this.startValue={};this.endValue={};}
   getMessageName(){return name;}
   getPathAsString(){return this.path.join('.');}
  };
 }
 const frames=[0,Math.PI/4,Math.PI/2].map((angle,i)=>({mateDofValue:angle,changedOccurrences:[{occurrence:{path:['part'],getPathAsString:()=> 'part'},transform:{getGlMatrix:()=>{const t=identity.slice();t[12]=i;return t;}}}]}));
 // Camera stub of Onshape's closest-normal-view: keeps right=-x (looking from behind) unless flipped.
 const rotated=[];
 const cameraAt=frame=>({getFrame:()=>frame,getCameraRotatedToViewAndTranslated:(m,origin,center,flip)=>{
  rotated.push({m,origin,center,flip});const s=flip?1:-1;
  return cameraAt([s*m[0],s*m[1],s*m[2],0,m[4],m[5],m[6],0,s*m[8],s*m[9],s*m[10],0,origin[0],origin[1],origin[2],1]);}});
 const camera={...cameraAt(identity),getViewMatrix:()=>identity,getViewport:()=>[0,0,100,100],isOrthographic:()=>true,getExtents:()=>[0,0,0,1,1,1],
  getViewportWidth:()=>100,getViewportHeight:()=>80,viewportToCanvas:p=>[p[0],80-p[1],p[2]],copyFrom(c){this.getFrame=c.getFrame;}};
 const manager={hasGraphicsOccurrenceData:()=>true,getOccurrenceTransform:()=>identity.slice(),
  batchUpdateOccurrenceTransforms:changes=>{for(const c of changes)transforms.set(c.pathId,[...c.transform]);return true;},
  getOccurrencesStartingWithPath:o=>o.path[0]==='part'?[o]:[],
  getDisplayedPartStudio:()=>({getBodyComponent:()=>({getBodyOccurrenceData:id=>id==='JHD'?{}:undefined})})};
 // Onshape's isolate/make-transparent managers: assembly effects key occurrences by path, Part Studio by part id.
 const effect=()=>({affected:partStudio?new Set():new Map(),affectId(o){this.affected.set(o.getPathAsString(),o);},
  affectParts(parts,v){assert.equal(v,viewer);this.affected=new Set(parts.map(p=>p.id));},getAffectedPartOrOccurrenceIds(){return this.affected;},
  clearIsolateNoAnimation(){this.affected.clear();},clearTransparentNoAnimation(){iso.currentMakeTransparentManager=null;}});
 const iso={currentIsolateManager:effect(),currentMakeTransparentManager:null,
  isInIsolateMode(){return this.currentIsolateManager.affected.size>0;},isInMakeTransparentMode(){return !!this.currentMakeTransparentManager;},
  getAffectedPartIdsOrOccurrences(){return (this.currentMakeTransparentManager??this.currentIsolateManager).getAffectedPartOrOccurrenceIds();},
  onMakeTransparentComponents(node,include,selections,v){assert.deepEqual([node,include,selections,v],[null,false,null,viewer]);this.currentMakeTransparentManager=effect();},
  onMakeTransparentParts(parts,v){this.currentMakeTransparentManager=effect();this.currentMakeTransparentManager.affectParts(parts,v);},
  removeMakeTransparentManager(){this.currentMakeTransparentManager=null;}};
 const view={updateCameraNearFar(){},afterViewChange(){},getZoomFitTargetCamera:frame=>cameraAt(frame)};
 const viewer={getOccurrenceIdManager:()=>({getIdForName:path=>path==='part'?1:-1}),getOccurrenceDataManager:()=>({getOccurrenceTransform:()=>transforms.get('part')}),getModelViewManagers:()=>({getManager:()=>manager}),getCamera:()=>camera,draw:()=>{},
  getPrimaryViewController:()=>view,getFitBounds:()=>({}),supportsGraphicalSectionPlanes:()=>section,getIsolatedOccurrenceManager:()=>iso,isIsolateEffectInUseForVisualization:()=>false};
 const connection={};
 const controller={connection:{isClosed:()=>closed},getActiveElementTabId:()=>target.eid,getViewer:()=>viewer,getElementConnection:()=>connection,
  documentModel:{get:k=>k==='microversionId'?{theId:revision}:{get:()=>'',isAssembly:()=>!partStudio,definition:{assemblyTree:tree}}},
  elementConnection:{callAndPromise:async message=>{
   sent.push(message);
   if(message.getMessageName().endsWith('AnimateMateRequest'))return {errorCode:0,frames};
   for(const call of message.featureOccurrenceVisibilityCalls)for(const ref of call.features){
    const item=items.find(i=>i.getFeatureId()===ref.featureId&&JSON.stringify(i.getOccurrence().path)===JSON.stringify(ref.occurrence.path));item.treeNode.hidden=call.visibility===1;
   }
   return {};
  }}};
 const modules={27940:classes,3392:{GI:{getOpenDocumentController:()=>controller}},64725:{V:{itemsByPath:new Map(items.map((v,i)=>[String(i),v]))}}};
 if(current) {modules[96402]=modules[27940];modules[87539]=modules[3392];modules[65443]=modules[64725];delete modules[27940];delete modules[3392];delete modules[64725];}
 // webgl barrel 41413: serialized section planes are {center,normal,tangent} with x/y/z fields.
 const sectioned={planes:[{center:{x:0,y:0,z:0.5},normal:{x:1,y:0,z:0},tangent:{x:0,y:1,z:0}}],calls:[]};
 if(current) modules[41413]={aL7:()=>({getElementId:()=>target.eid}),ejz:()=>structuredClone(sectioned.planes),
  Q0t:(planes,conn,v)=>{assert.equal(conn,connection);assert.equal(v,viewer);sectioned.calls.push(structuredClone(planes));sectioned.planes=structuredClone(planes);}};
 const chunks=[];chunks.push=value=>{Array.prototype.push.call(chunks,value);value[2](id=>{if(!(id in modules))throw new TypeError('module factory missing');return modules[id];});};globalThis.webpackChunkNewton=chunks;
 return {modules,sent,connector,mate,transforms,rotated,camera,sectioned,iso,setRevision:v=>revision=v,setClosed:v=>closed=v};
}
const run=(operation,args={},extra={})=>displayCommand({kind:'display',target,operation,args,expected_microversion:micro,...extra});
const fingerprint=state=>state.rows.map(r=>[r.tree_path,r.visibility,r.parent_hidden,r.suppressed,r.suppressed_by_parent]);
test('complete tree includes inherited exact feature reference and effective parent hiding',async()=>{
 setup({parentHidden:true});const state=await run('inspect');assert.equal(state.complete,true);assert.equal(state.connected,true);
 const row=state.rows.find(r=>r.inherited_connector);assert.deepEqual(row.reference,{kind:'feature',occurrence_path:['part'],feature_id:'Fderived.*merge.Fconnector'});assert.equal(row.effective_visible,false);
});
test('offline editor fails before sending and stale display state fails before mutation',async()=>{
 const env=setup({offline:true});const state=await run('inspect'),ref=state.rows.at(-1).reference;
 assert.equal(state.connected,false);
 assert.match((await run('visibility',{changes:[{reference:ref,visible:false}],expected_state:fingerprint(state)})).error,/disconnected/);assert.equal(env.sent.length,0);
 env.setClosed(false);env.mate.hidden=true;
 assert.match((await run('visibility',{changes:[{reference:ref,visible:false}],expected_state:fingerprint(state)})).error,/Display state changed/);assert.equal(env.sent.length,0);
});
test('mixed visibility uses one typed batch and reads observed values',async()=>{
 const env=setup();env.connector.hidden=true;const state=await run('inspect');const rows=state.rows.filter(r=>r.reference?.kind==='feature');
 const result=await run('visibility',{changes:rows.map(r=>({reference:r.reference,visible:!r.effective_visible})),expected_state:fingerprint(state)});
 assert.equal(result.verified,true);assert.equal(env.sent.length,1);assert.equal(env.sent[0].featureOccurrenceVisibilityCalls.length,2);
 assert.equal(env.sent[0].featureOccurrenceVisibilityCalls[1].features[0].featureId,'Fderived.*merge.Fconnector');
});
test('motion uses solved angles, applies frame transforms and restores actual baseline',async()=>{
 const env=setup();const state=await run('inspect');const mate=state.rows.at(-1).reference;
 const prepared=await run('motion',{action:'prepare',mate,frames:3,start_degrees:0,end_degrees:90});assert.equal(prepared.state,'prepared');
 assert.equal(env.sent[0].mate.queryData,'Rz');const session_id=prepared.session_id;
 const step=await run('motion',{action:'step',session_id,frame:1});assert.equal(step.angle_degrees,45);assert.equal(step.pose_verified,true);assert.equal(env.transforms.get('part')[12],1);
 const restored=await run('motion',{action:'restore',session_id});assert.equal(restored.state,'restored');assert.equal(restored.angle_degrees,null);assert.deepEqual(env.transforms.get('part'),identity);
});
test('motion refuses restoring an old pose over a newer model revision',async()=>{
 const env=setup();const state=await run('inspect');const prepared=await run('motion',{action:'prepare',mate:state.rows.at(-1).reference,frames:3,start_degrees:0,end_degrees:90});
 await run('motion',{action:'step',session_id:prepared.session_id,frame:1});env.setRevision('e'.repeat(24));
 assert.match((await run('motion',{action:'restore',session_id:prepared.session_id})).error,/Model changed/);assert.equal(env.transforms.get('part')[12],1);
});
test('wrong URL fails before any editor operation',async()=>{
 const env=setup();location.pathname='/documents/elsewhere';assert.match((await run('inspect')).error,/target navigated/);assert.equal(env.sent.length,0);
});

test('current captured frontend profile resolves display rows',async()=>{
 setup({current:true});assert.equal((await run('inspect')).complete,true);
});
test('missing controller fails before display mutation with bootstrap diagnostic',async()=>{
 const env=setup({current:true});env.modules[87539]={};
 assert.match((await run('visibility')).error,/87539:controller-accessor-missing/);assert.equal(env.sent.length,0);
});
test('missing sidebar registry returns bounded diagnostic',async()=>{
 const env=setup({current:true});env.modules[65443]={};
 assert.match((await run('inspect')).error,/sidebar-registry-missing:65443/);assert.equal(env.sent.length,0);
});

const plane={origin:[0.01,0.02,0.03],normal:[0,0,1],x_dir:[1,0,0]};
test('normal_to uses Onshape plane-matrix camera rotation and views the + normal side',async()=>{
 const env=setup({current:true});const result=await run('camera',{action:'normal_to',plane,fit:false});
 assert.equal(result.applied,true);assert.equal(result.facing_normal,true);
 // Column-major plane matrix: x_dir, normal × x_dir, normal, origin (meters).
 assert.deepEqual(env.rotated[0].m,[1,0,0,0,0,1,0,0,0,0,1,0,0.01,0.02,0.03,1]);
 assert.deepEqual(env.rotated[0].origin,plane.origin);assert.deepEqual(env.rotated[0].center,[50,40,0]);
 assert.deepEqual(env.rotated.map(r=>r.flip),[false,true]);
 assert.deepEqual(env.camera.getFrame().slice(8,11),[0,0,1]);
 assert.match((await run('camera',{action:'normal_to',plane},{expected_microversion:'e'.repeat(24)})).error,/revision changed/);
});
test('section saves prior planes once, sets one plane, reports and restores',async()=>{
 const env=setup({current:true});const prior=structuredClone(env.sectioned.planes);
 const first=await run('camera',{action:'section',plane});
 assert.equal(first.verified,true);assert.deepEqual(first.section_planes,[plane]);
 assert.deepEqual(env.sectioned.calls[0],[{center:{x:0.01,y:0.02,z:0.03},normal:{x:0,y:0,z:1},tangent:{x:1,y:0,z:0}}]);
 await run('camera',{action:'section',plane:{...plane,origin:[0,0,0]}});
 const off=await run('camera',{action:'section_off'});
 assert.equal(off.verified,true);assert.deepEqual(env.sectioned.planes,prior);
 assert.match((await run('camera',{action:'section_off'})).error,/No saved section/);
});
test('section refuses unsupported viewers and missing bundle helpers before changing planes',async()=>{
 let env=setup({current:true,section:false});
 assert.match((await run('camera',{action:'section',plane})).error,/graphical section planes/);assert.equal(env.sectioned.calls.length,0);
 env=setup({current:true});delete env.modules[41413];
 assert.match((await run('camera',{action:'section',plane})).error,/section-helpers-missing:41413/);
 setup();assert.match((await run('camera',{action:'section',plane})).error,/section-helpers-missing:null/);
});
test('assembly isolate and make transparent use Onshape effect managers and restore',async()=>{
 const env=setup({current:true});
 const isolated=await run('camera',{action:'isolate',occurrence_paths:[['part']]});
 assert.equal(isolated.verified,true);assert.deepEqual(isolated.isolation,{isolate:true,make_transparent:false,affected:['part']});
 assert.match((await run('camera',{action:'make_transparent',occurrence_paths:[['part']]})).error,/Exit the active/);
 assert.equal((await run('camera',{action:'exit_isolate'})).verified,true);
 assert.match((await run('camera',{action:'isolate',occurrence_paths:[['missing']]})).error,/absent from the viewer/);
 const transparent=await run('camera',{action:'make_transparent',occurrence_paths:[['part']]});
 assert.equal(transparent.verified,true);assert.equal(transparent.isolation.make_transparent,true);
 const exit=await run('camera',{action:'exit_make_transparent'});
 assert.equal(exit.verified,true);assert.equal(env.iso.currentMakeTransparentManager,null);
});
test('Part Studio isolate and make transparent take part ids',async()=>{
 setup({current:true,partStudio:true});
 assert.match((await run('camera',{action:'isolate',occurrence_paths:[['part']]})).error,/part_ids/);
 assert.match((await run('camera',{action:'isolate',part_ids:['NOPE']})).error,/absent from the viewer/);
 const isolated=await run('camera',{action:'isolate',part_ids:['JHD']});
 assert.equal(isolated.verified,true);assert.deepEqual(isolated.isolation.affected,['JHD']);
 await run('camera',{action:'exit_isolate'});
 assert.equal((await run('camera',{action:'make_transparent',part_ids:['JHD']})).verified,true);
 assert.equal((await run('camera',{action:'exit_make_transparent'})).verified,true);
});
