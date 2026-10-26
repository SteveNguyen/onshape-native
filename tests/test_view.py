"""View/inspection features: scripts, matrices and typed view_control dispatch (mocked, no live calls)."""
import json
import math
import pytest
from onshape_native.bridge import validate_job, BridgeError
from onshape_native.client import OnshapeError
from onshape_native.geometry import topology_script, view_matrix, face_query, face_plane_script, section_script

TARGET={'did':'a'*24,'wid':'b'*24,'eid':'c'*24}
MICRO='d'*24
URL=f"https://cad.onshape.com/documents/{'a'*24}/w/{'b'*24}/e/{'c'*24}"
PLANE={'origin':[0.01,0,0],'normal':[0,0,1],'x_dir':[1,0,0]}


def test_generated_featurescript_avoids_reserved_words():
    # Live Onshape rejected `const box = ...` with a parse error ("mismatched input 'box'").
    import re
    for script in (face_plane_script('qEverything(EntityType.FACE)'), section_script(plane={'origin_mm':[0,0,1],'normal':[0,0,1]}),
                   section_script(face='qEverything(EntityType.FACE)')):
        assert not re.search(r'\b(?:const|var)\s+box\b|\bbox\.', script)


def camera(args):
    return dict(kind='display',target=TARGET,tab_id=12,operation='camera',args=args,expected_microversion=MICRO)


def close(a,b): return all(math.isclose(x,y,abs_tol=1e-12) for x,y in zip(a,b,strict=True))


def test_topology_enumerates_only_solid_body_faces():
    script=topology_script('qEverything(EntityType.FACE)')
    assert 'qOwnedByBody(qBodyType(qEverything(EntityType.BODY), BodyType.SOLID), EntityType.FACE)' in script
    assert 'qIntersection' in script and '(qEverything(EntityType.FACE))' in script


def test_view_matrix_matches_documented_named_views():
    # shadedviews rows: right, up, toward-viewer in model coordinates; identity is "top".
    assert close(view_matrix([0,0,1]),[1,0,0,0,0,1,0,0,0,0,1,0])
    assert close(view_matrix([0,-1,0]),[1,0,0,0,0,0,1,0,0,-1,0,0])                    # front
    assert close(view_matrix([1,0,0]),[0,1,0,0,0,0,1,0,1,0,0,0])                     # right
    assert close(view_matrix([0,0,-1]),[1,0,0,0,0,-1,0,0,0,0,-1,0])                  # bottom (Onshape XYback)
    s,i,t=math.sqrt(.5),math.sqrt(1/6),math.sqrt(1/3)
    assert close(view_matrix([1,-1,1]),[s,s,0,0,-i,i,2*i,0,t,-t,t,0])               # Onshape isometric frame
    # Translation centers the given point (meters) at the view origin.
    m=view_matrix([0,-1,0],center=[0.1,0.2,0.3])
    assert close([m[3],m[7],m[11]],[-0.1,-0.3,0.2])
    assert close(view_matrix([0,-1,0],up=[1,0,0])[:3],[0,0,-1])
    for bad in ([0,0,0],[1,math.nan,0]):
        with pytest.raises(OnshapeError): view_matrix(bad)
    with pytest.raises(OnshapeError): view_matrix([0,0,1],up=[0,0,2])


def test_face_queries_use_transient_ids_or_expressions():
    assert face_query('JHD')==('queries.face',{'face':['JHD']})
    assert face_query('qCreatedBy(makeId("Top"), EntityType.FACE)')==('qCreatedBy(makeId("Top"), EntityType.FACE)',{})
    script=face_plane_script('queries.face')
    for token in ('evFaceTangentPlane','evApproximateCentroid','qEntityFilter((queries.face), EntityType.FACE)','/ meter'):
        assert token in script


def test_section_script_is_temporary_split_with_deduplicated_faces():
    script=section_script(plane={'origin_mm':[0,0,5],'normal':[0,0,2]},offset=0,limit=10)
    for token in ('opPlane','opSplitPart','qAllModifiableSolidBodies()','qCreatedBy(splitId, EntityType.FACE)',
                  'evEdgeTangentLines','evArea','coordSystem(origin, u, n)','> 0'):
        assert token in script
    assert 'vector(0, 0, 1)' in script and '* millimeter' in script
    assert 'qEntityFilter((queries.face)' in section_script(face='queries.face')
    for bad in ({'origin_mm':[0,0],'normal':[0,0,1]},{'origin_mm':[0,0,0],'normal':[0,0,0]},{'origin_mm':[0,0,math.inf],'normal':[0,0,1]}):
        with pytest.raises(OnshapeError): section_script(plane=bad)
    with pytest.raises(OnshapeError): section_script()


@pytest.mark.parametrize('args',[
 {'action':'normal_to','plane':{'origin':[0,0,0],'normal':[0,0,1]}},
 {'action':'normal_to','plane':{'origin':[0,0,0],'normal':[0,0,2],'x_dir':[1,0,0]}},
 {'action':'normal_to','plane':{'origin':[0,0,0],'normal':[0,0,1],'x_dir':[0,0,1]}},
 {'action':'section','plane':{'origin':[0,0],'normal':[0,0,1],'x_dir':[1,0,0]}},
 {'action':'section','plane':{**PLANE,'script':'x'}},
 {'action':'isolate'},
 {'action':'isolate','occurrence_paths':[['a']],'part_ids':['JHD']},
 {'action':'make_transparent','part_ids':['bad id']},
 {'action':'make_transparent','occurrence_paths':[[]]},
])
def test_invalid_view_actions_rejected(args):
    with pytest.raises(BridgeError): validate_job(camera(args))


def test_view_actions_are_revision_checked_writes():
    for args in ({'action':'normal_to','plane':PLANE,'fit':True},{'action':'section','plane':PLANE},{'action':'section_off'},
                 {'action':'isolate','occurrence_paths':[['a','b']]},{'action':'make_transparent','part_ids':['JHD']},
                 {'action':'exit_isolate'},{'action':'exit_make_transparent'}):
        assert validate_job(camera(args))
        stale=camera(args);stale.pop('expected_microversion')
        with pytest.raises(BridgeError): validate_job(stale)


class FakeService:
    def __init__(self,tmp_path,result):
        from onshape_native.store import Store
        self.store=Store(tmp_path);self.sent=[];self.evals=[];self.result=result;self.locks={}
        service=self
        class Client:
            async def status(self): return {'extension':{'capabilities':['display_v1']}}
            async def command(self,job): service.sent.append(job); return {'applied':True,'microversion':MICRO}
        self.client=Client()
    async def inspect(self,url,geometry=True,previous=None): return {'snapshot':'snap'}
    def target(self,url): return {'did':'a'*24,'wvm':'w','wvmid':'b'*24,'eid':'c'*24},''
    def snapshot_data(self,snapshot): return {'microversion':MICRO,'target':{},'configuration':'','libraryVersion':1}
    async def eval(self,data,script,queries=None): self.evals.append((script,queries)); return {'result':self.result}


async def test_normal_to_face_resolves_plane_in_python_before_dispatch(tmp_path,monkeypatch):
    from onshape_native import server
    fake=FakeService(tmp_path,{'count':1,'origin':[0.01,0.02,0.03],'normal':[0,0,2],'x':[1,0,0],'min':[0,0,0],'max':[1,1,0]})
    monkeypatch.setattr(server,'svc',lambda:fake)
    await server.view_control(URL,'normal_to',tab_id=12,expected_microversion=MICRO,face='JHD',fit=False,detail='full')
    assert fake.evals[0][1]=={'face':['JHD']}
    args=fake.sent[0]['args']
    assert args['action']=='normal_to' and args['fit'] is False
    assert args['plane']=={'origin':[0.01,0.02,0.03],'normal':[0.0,0.0,1.0],'x_dir':[1.0,0.0,0.0]}


async def test_section_plane_gets_stable_x_dir_and_face_must_be_unique(tmp_path,monkeypatch):
    from onshape_native import server
    fake=FakeService(tmp_path,{'count':2})
    monkeypatch.setattr(server,'svc',lambda:fake)
    await server.view_control(URL,'section',tab_id=12,expected_microversion=MICRO,plane={'origin':[0,0,0],'normal':[0,0,1]},detail='full')
    assert fake.sent[0]['args']['plane']['x_dir']==[1.0,0.0,0.0]
    with pytest.raises(OnshapeError,match='exactly one face'):
        await server.view_control(URL,'section',tab_id=12,expected_microversion=MICRO,face='qEverything(EntityType.FACE)')
    with pytest.raises(OnshapeError,match='plane or face'):
        await server.view_control(URL,'normal_to',tab_id=12,expected_microversion=MICRO)
    await server.view_control(URL,'isolate',tab_id=12,expected_microversion=MICRO,part_ids=['JHD'],detail='full')
    assert fake.sent[-1]['args']=={'action':'isolate','part_ids':['JHD']}


@pytest.mark.parametrize('kind,operation',[('ASSEMBLY','getAssemblyBoundingBoxes'),('PARTSTUDIO','getPartStudioBoundingBoxes')])
async def test_plane_origin_center_uses_this_elements_bounds(tmp_path,monkeypatch,kind,operation):
    # Live lesson: a plane placed from another element's centroid cut away almost the whole assembly.
    from onshape_native import server
    fake=FakeService(tmp_path,None);calls=[]
    async def call(op,path=None,query=None,body=None):
        calls.append((op,path,query))
        if op=='getElementsInDocument': return [{'id':'c'*24,'elementType':kind}]
        return {'lowX':-0.2,'lowY':-0.4,'lowZ':-0.3,'highX':0.0,'highY':0.2,'highZ':0.1}
    fake.call=call
    monkeypatch.setattr(server,'svc',lambda:fake)
    await server.view_control(URL,'section',tab_id=12,expected_microversion=MICRO,plane={'origin':'center','normal':[1,0,0]},detail='full')
    assert calls[0][0]=='getElementsInDocument' and calls[0][2]=={'elementId':'c'*24}
    assert calls[1][0]==operation and calls[1][1]['eid']=='c'*24
    assert fake.sent[0]['args']['plane']['origin']==pytest.approx([-0.1,-0.1,-0.1])
    with pytest.raises(OnshapeError,match='origin'):
        await server.view_control(URL,'section',tab_id=12,expected_microversion=MICRO,plane={'origin':'middle','normal':[1,0,0]})


async def test_evaluate_section_preset_uses_plane_or_face(tmp_path,monkeypatch):
    from onshape_native import server
    fake=FakeService(tmp_path,{'count':0,'rows':[]})
    monkeypatch.setattr(server,'svc',lambda:fake)
    await server.evaluate('snap',preset='section',plane={'origin_mm':[0,0,5],'normal':[0,0,1]})
    await server.evaluate('snap',preset='section',expression='JHD',offset=2,limit=3)
    (plane_script,plane_queries),(face_script,face_queries)=fake.evals
    assert 'opSplitPart' in plane_script and plane_queries=={}
    assert face_queries=={'face':['JHD']} and 'i = 2;' in face_script and 'min(size(faces), 5)' in face_script
    with pytest.raises(OnshapeError): await server.evaluate('snap',preset='section')


async def test_render_views_accept_directions_and_faces(tmp_path,monkeypatch):
    import base64, io
    from PIL import Image
    from onshape_native import server
    png=io.BytesIO();Image.new('RGB',(8,8),'red').save(png,format='PNG')
    calls=[]
    fake=FakeService(tmp_path,{'count':1,'origin':[0,0,0.01],'normal':[0,0,1],'x':[1,0,0],'min':[-0.01,-0.01,0.01],'max':[0.01,0.01,0.01]})
    async def call(operation,path=None,query=None,body=None):
        calls.append((operation,query))
        if operation=='getAssemblyBoundingBoxes': return {'lowX':-0.1,'lowY':-0.1,'lowZ':0,'highX':0.1,'highY':0.1,'highZ':0.2}
        return {'images':[base64.b64encode(png.getvalue()).decode()]}
    fake.call=call
    fake.snapshot_data=lambda s:{'microversion':MICRO,'target':{'did':'a'*24,'wvm':'w','wvmid':'b'*24,'eid':'c'*24},'configuration':'','libraryVersion':1,
                                  'solids':[{'min_mm':[-10,-10,0],'max_mm':[10,10,20]}]}
    fake.pinned=lambda data:{**data['target'],'wvm':'m','wvmid':MICRO}
    monkeypatch.setattr(server,'svc',lambda:fake)
    await server.render_views('snap',views=['front',{'direction':[0,-1,0]},{'face':'JHD'}],size=256)
    front,direction,face=[q['viewMatrix'] for _,q in calls]
    assert front=='front'
    assert close([float(x) for x in direction.split(',')],[1,0,0,0,0,0,1,-0.01,0,-1,0,0])
    assert close([float(x) for x in face.split(',')],[1,0,0,0,0,1,0,0,0,0,1,-0.01])
    assert calls[2][1]['pixelSize']<calls[0][1]['pixelSize']  # framed on the face bounds
    calls.clear()
    await server.render_views(url=URL,views=[{'direction':[1,0,0]}],size=256)
    assert [c[0] for c in calls]==['getAssemblyBoundingBoxes','getAssemblyShadedViews']
    with pytest.raises(OnshapeError): await server.render_views(url=URL,views=[{'face':'JHD'}])
    with pytest.raises(OnshapeError): await server.render_views(views=[{'direction':[0,0,1],'zoom':2}],snapshot='snap')
