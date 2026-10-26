"""Typed display/session commands, fresh-state guards and private image artifacts."""
from __future__ import annotations

import base64
import io
import math
import re
from typing import Literal

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .client import OnshapeError
from .geometry import dot, face_plane_script, face_query, unit, view_basis
from .structures import target_from_url


class Reference(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    kind: Literal['feature', 'occurrence']
    occurrence_path: list[str] = Field(max_length=64)
    feature_id: str | None = Field(default=None, min_length=1, max_length=1024)

    @model_validator(mode='after')
    def valid(self):
        if any(not p or len(p)>1024 or '.' in p for p in self.occurrence_path):
            raise ValueError('Use occurrence path segments returned by display_state.')
        if (self.kind == 'feature') != bool(self.feature_id):
            raise ValueError('Feature references require feature_id; occurrence references omit it.')
        if self.kind == 'occurrence' and not self.occurrence_path:
            raise ValueError('Select an occurrence, not the assembly root.')
        return self


class VisibilityChange(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    reference: Reference
    visible: bool


CAMERA_ACTIONS = {'read','save','restore','standard','orientation','fit','zoom','normal_to','section','section_off',
                  'isolate','exit_isolate','make_transparent','exit_make_transparent'}
PART_ID = re.compile(r'[A-Za-z0-9_+/=.:-]{1,128}')


def valid_plane(plane):
    """Viewer plane in meters with an orthonormal normal/x_dir (Python resolves faces and defaults first)."""
    if not isinstance(plane,dict) or set(plane)!={'origin','normal','x_dir'}: raise ValueError('plane must be {origin, normal, x_dir}.')
    for v in plane.values():
        if not isinstance(v,list) or len(v)!=3 or any(type(x) not in (int,float) or not math.isfinite(x) for x in v): raise ValueError('Plane vectors must be three finite numbers.')
    n,x=plane['normal'],plane['x_dir']
    if abs(dot(n,n)-1)>1e-6 or abs(dot(x,x)-1)>1e-6 or abs(dot(n,x))>1e-6: raise ValueError('Plane normal and x_dir must be orthonormal.')


async def element_center(service,url):
    """Bounding-box centre (meters) of the URL's own element, so planes are never placed from another element's frame."""
    path,configuration=service.target(url)
    elements=await service.call('getElementsInDocument',{k:path[k] for k in ('did','wvm','wvmid')},{'elementId':path['eid']})
    kind=next((e['elementType'] for e in elements if e.get('id')==path['eid']),None)
    if kind not in ('ASSEMBLY','PARTSTUDIO'): raise OnshapeError('origin "center" needs an assembly or Part Studio element.')
    b=await service.call('getAssemblyBoundingBoxes' if kind=='ASSEMBLY' else 'getPartStudioBoundingBoxes',path,{'configuration':configuration})
    return [(b['low'+a]+b['high'+a])/2 for a in 'XYZ']


async def resolve_plane(service,url,plane=None,face='',micro=''):
    """{origin m, normal, x_dir} from an explicit plane or one Part Studio face/plane, evaluated at micro.
    origin "center" means the element's own bounding-box centre."""
    if bool(plane)==bool(face): raise OnshapeError('Give exactly one of plane or face: plane {origin (meters), normal, x_dir?}, or a Part Studio face Query/ID.')
    if face:
        data=service.snapshot_data((await service.inspect(url,geometry=False))['snapshot'])
        if micro and data['microversion']!=micro: raise OnshapeError('Model revision differs from expected_microversion. Read fresh state.')
        expression,queries=face_query(face)
        result=(await service.eval(data,face_plane_script(expression),queries)).get('result')
        if not isinstance(result,dict) or result.get('count')!=1: raise OnshapeError(f"face must resolve to exactly one face (got {(result or {}).get('count')}).")
        plane={'origin':result['origin'],'normal':result['normal'],'x_dir':result['x']}
    if not isinstance(plane,dict) or not {'origin','normal'}<=set(plane)<={'origin','normal','x_dir'}: raise OnshapeError('plane must be {origin, normal, x_dir?}.')
    origin=await element_center(service,url) if plane['origin']=='center' else plane['origin']
    if not isinstance(origin,list) or len(origin)!=3 or any(type(v) not in (int,float) or not math.isfinite(v) for v in origin): raise OnshapeError('origin must be three finite numbers (meters) or "center".')
    normal=unit(plane['normal'],'normal')
    x=view_basis(normal)[0] if plane.get('x_dir') is None else unit(plane['x_dir'],'x_dir')
    x=unit([a-dot(x,normal)*b for a,b in zip(x,normal)],'x_dir')  # orthogonal to the normal
    return {'origin':[float(v) for v in origin],'normal':normal,'x_dir':x}


def validate_display_job(job):
    """Same bounds for direct /command requests and MCP. No executable payloads."""
    op, args = job.get('operation'), job.get('args', {})
    if not isinstance(args, dict): raise ValueError('Display args must be an object.')
    fields = {
        'inspect': set(), 'visibility': {'changes','expected_state'},
        'camera': {'action','view','frame','fit','occurrence_paths','camera_id','extents','plane','part_ids'},
        'capture': {'max_size'},
        'motion': {'action','mate','frames','start_degrees','end_degrees','session_id','frame','fps'},
    }
    if op not in fields or set(args)-fields[op]: raise ValueError('Unknown display operation/argument.')
    if op == 'visibility':
        changes=args.get('changes')
        if not isinstance(changes,list) or not 1<=len(changes)<=100: raise ValueError('Provide 1–100 visibility changes.')
        parsed=[VisibilityChange.model_validate(c) for c in changes]
        keys=[c.reference.model_dump_json() for c in parsed]
        if len(keys)!=len(set(keys)): raise ValueError('Duplicate visibility reference.')
        if not isinstance(args.get('expected_state'),list): raise ValueError('Use expected_state from a fresh display snapshot.')
    if op == 'camera':
        action=args.get('action')
        if action not in CAMERA_ACTIONS: raise ValueError('Unknown camera action.')
        if ('plane' in args) != (action in {'normal_to','section'}): raise ValueError('normal_to and section (only) take a plane.')
        if 'plane' in args: valid_plane(args['plane'])
        if action in {'isolate','make_transparent'}:
            if ('occurrence_paths' in args) == ('part_ids' in args): raise ValueError('Give assembly occurrence_paths or Part Studio part_ids.')
            if 'occurrence_paths' in args: action='zoom'  # same occurrence path checks below
            elif not isinstance(args['part_ids'],list) or not 1<=len(args['part_ids'])<=100 or len(set(args['part_ids']))!=len(args['part_ids']) \
                    or any(not isinstance(p,str) or not PART_ID.fullmatch(p) for p in args['part_ids']): raise ValueError('Provide 1–100 distinct part IDs.')
        elif 'part_ids' in args: raise ValueError('part_ids apply to isolate/make_transparent.')
        if action=='restore' and (not isinstance(args.get('camera_id'),str) or not 1<=len(args['camera_id'])<=128): raise ValueError('Use camera_id returned by save.')
        if 'fit' in args and type(args['fit']) is not bool: raise ValueError('fit must be boolean.')
        if 'extents' in args:
            extents=args['extents']
            if action!='orientation' or args.get('fit') is not False: raise ValueError('Extents require orientation with fit=false.')
            if not isinstance(extents,list) or len(extents)!=6 or any(type(x) not in (int,float) or not math.isfinite(x) for x in extents) or any(extents[i]>=extents[i+3] for i in range(3)): raise ValueError('Use six finite ordered orthographic extents from camera readback.')
        if action == 'standard' and args.get('view') not in {'front','back','left','right','top','bottom','isometric'}: raise ValueError('Unknown standard view.')
        if action == 'orientation':
            frame=args.get('frame')
            if not isinstance(frame,list) or len(frame)!=16 or any(type(x) not in (float,int) or not math.isfinite(x) for x in frame): raise ValueError('Camera frame must contain 16 finite numbers in column-major order.')
            if any(abs(frame[i]-v)>1e-8 for i,v in [(3,0),(7,0),(11,0),(15,1)]): raise ValueError('Camera frame must be affine.')
            axes=[frame[i:i+3] for i in (0,4,8)]
            if any(abs(sum(a*b for a,b in zip(axes[i],axes[j]))-(i==j))>1e-6 for i in range(3) for j in range(3)): raise ValueError('Camera axes must be orthonormal.')
            a,b,c=axes
            determinant=a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0])
            if determinant<0: raise ValueError('Camera frame must be right handed.')
        if action == 'zoom':
            paths=args.get('occurrence_paths')
            if not isinstance(paths,list) or not 1<=len(paths)<=100: raise ValueError('Provide 1–100 occurrence paths.')
            for path in paths: Reference(kind='occurrence',occurrence_path=path)
    if op == 'capture':
        size=args.get('max_size',1600)
        if type(size) is not int or not 256<=size<=4096: raise ValueError('max_size must be 256–4096 pixels.')
    if op == 'motion':
        action=args.get('action')
        if action not in {'prepare','start','stop','step','status','restore'}: raise ValueError('Unknown motion action.')
        if action == 'prepare':
            ref=Reference.model_validate(args.get('mate'))
            if ref.kind!='feature': raise ValueError('Select a mate feature reference.')
            frames=args.get('frames')
            if type(frames) is not int or not 2<=frames<=600: raise ValueError('frames must be 2–600.')
            for key in ('start_degrees','end_degrees'):
                value=args.get(key)
                if type(value) not in (int,float) or not math.isfinite(value) or abs(value)>36000: raise ValueError('Angles must be finite and within ±36000 degrees.')
        elif not isinstance(args.get('session_id'),str) or not 1<=len(args['session_id'])<=128: raise ValueError('Use a motion session ID returned by prepare.')
        if action=='step' and (type(args.get('frame')) is not int or not 0<=args['frame']<600): raise ValueError('Invalid frame index.')
        if action=='start' and (type(args.get('fps')) not in (int,float) or not 1<=args['fps']<=60): raise ValueError('fps must be 1–60.')
    return job


class Display:
    def __init__(self, service): self.s=service

    async def target(self, url, tab_id=None):
        target=target_from_url(url)
        if target['wvm']!='w' or not target.get('eid') or target.get('configuration'): raise OnshapeError('Display operations require an unconfigured workspace element URL.')
        native={'did':target['did'],'wid':target['wvmid'],'eid':target['eid']}
        status=await self.s.client.status()
        if 'display_v1' not in (status.get('extension') or {}).get('capabilities',[]):
            raise OnshapeError('Connected extension lacks display_v1. Update/reload Onshape Native 0.5.0 and restart the MCP/companion; bridge_status reports the loaded version and capabilities.')
        if tab_id is None:
            opened=await self.s.client.command({'kind':'open','target':native})
            tab_id=opened['tab_id']
        return native,tab_id

    async def command(self,target,tab_id,operation,args=None,micro=None):
        job={'kind':'display','target':target,'tab_id':tab_id,'operation':operation,'args':args or {}}
        if micro: job['expected_microversion']=micro
        validate_display_job(job)
        return await self.s.client.command(job)

    def snapshot(self,url,target,tab_id,data):
        value={'kind':'onshape-display','url':url,'target':target,'tab_id':tab_id,**data}
        value['expected_state']=[[r['tree_path'],r.get('visibility'),r.get('parent_hidden'),r.get('suppressed'),r.get('suppressed_by_parent')] for r in data['rows']]
        return self.s.store.put(value)['artifact']

    def load(self,snapshot):
        data=self.s.store.read(snapshot)
        if data.get('kind')!='onshape-display': raise OnshapeError('Use a snapshot from display_state or set_visibility.')
        return data

    def page(self,data,snapshot,offset,limit):
        page=self.s.store.page(data['rows'],offset=offset,limit=limit)
        while page.get('needs_narrower_pointer') and limit>1:
            limit=max(1,limit//2);page=self.s.store.page(data['rows'],offset=offset,limit=limit)
        return {'snapshot':snapshot,'microversion':data['microversion'],'tab_id':data['tab_id'],
                'connected':data.get('connected',False),'complete':data['complete'],'issues':data['issues'],'camera':data['camera'],
                'motion':data.get('motion'),'rpc_pending':data.get('rpc_pending'),**page}

    async def state(self,url,tab_id=None,snapshot='',offset=0,limit=20):
        if snapshot:
            data=self.load(snapshot)
            if data['url']!=url or (tab_id is not None and tab_id!=data['tab_id']): raise OnshapeError('Snapshot target differs.')
        else:
            target,tab_id=await self.target(url,tab_id)
            data=await self.command(target,tab_id,'inspect')
            snapshot=self.snapshot(url,target,tab_id,data)
        return self.page(data,snapshot,offset,limit)

    async def visibility(self,snapshot,changes):
        data=self.load(snapshot)
        result=await self.command(data['target'],data['tab_id'],'visibility',{
            'changes':[c.model_dump(exclude_none=True) if isinstance(c,VisibilityChange) else c for c in changes],
            'expected_state':data['expected_state']},data['microversion'])
        new=self.snapshot(data['url'],data['target'],data['tab_id'],result)
        checks=self.s.store.response(result['checks'],limit=5)
        return {'verified':result['verified'],'snapshot':new,'checks':checks,'microversion':result['microversion'],
                'next':'Read display_state with this snapshot to page the observed state; omit snapshot for a new verification read.'}

    async def operation(self,url,operation,args,tab_id=None,expected_microversion=''):
        target,tab_id=await self.target(url,tab_id)
        result=await self.command(target,tab_id,operation,args,expected_microversion)
        return {'target':target,'tab_id':tab_id,**result}

    async def capture(self,url,tab_id=None,max_size=1600):
        result=await self.operation(url,'capture',{'max_size':max_size},tab_id)
        try:
            raw=base64.b64decode(result.pop('image'),validate=True)
            with Image.open(io.BytesIO(raw)) as im:
                if im.format!='PNG' or im.size!=(result['width'],result['height']) or max(im.size)>max_size: raise ValueError()
                im.verify()
        except (ValueError,KeyError,OSError): raise OnshapeError('Invalid viewport image; no artifact saved.') from None
        return {**result,**self.s.store.put(raw,'png')},raw
