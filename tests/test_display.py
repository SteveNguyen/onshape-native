import copy
import pytest
from pydantic import ValidationError
from onshape_native.bridge import validate_job, BridgeError, create_app
from onshape_native.client import BridgeAuth
from onshape_native.config import mac
from onshape_native.display import Reference, VisibilityChange, Display
from onshape_native.store import Store
from starlette.testclient import TestClient

TARGET={'did':'a'*24,'wid':'b'*24,'eid':'c'*24}
MICRO='d'*24
REF={'kind':'feature','occurrence_path':['instance+/'],'feature_id':'Fderived.*merge.Fconnector'}


def job(op,args):
    return dict(kind='display',target=TARGET,tab_id=12,operation=op,args=args,expected_microversion=MICRO)


def test_reference_preserves_full_inherited_feature_id():
    assert Reference.model_validate(REF).model_dump()==REF
    with pytest.raises(ValidationError): VisibilityChange(reference=REF,visible='false')
    with pytest.raises(ValidationError): Reference(kind='occurrence',occurrence_path=[])
    with pytest.raises(ValidationError): Reference(kind='feature',occurrence_path=['one.two'],feature_id='x')


@pytest.mark.parametrize('op,args',[
 ('visibility',{'changes':[{'reference':REF,'visible':'false'}],'expected_state':[]}),
 ('visibility',{'changes':[{'reference':REF,'visible':False}]*2,'expected_state':[]}),
 ('motion',{'action':'prepare','mate':REF,'frames':10000,'start_degrees':0,'end_degrees':90}),
 ('motion',{'action':'prepare','mate':REF,'frames':3,'start_degrees':float('nan'),'end_degrees':90}),
 ('motion',{'action':'start','session_id':'id','fps':0}),
 ('motion',{'action':'step','session_id':'id','frame':True}),
 ('motion',{'action':'restore','session_id':''}),
 ('camera',{'action':'orientation','frame':[1]*16}),
 ('camera',{'action':'orientation','frame':[-1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}),
 ('camera',{'action':'zoom','occurrence_paths':[[]]}),
 ('camera',{'action':'orientation','extents':[1]*6,'fit':False}),
 ('capture',{'max_size':4097}),
 ('inspect',{'script':'arbitrary()'}),
])
def test_invalid_display_jobs_rejected_before_dispatch(op,args):
    with pytest.raises(BridgeError): validate_job(job(op,args))


def test_revision_and_exact_tab_required():
    valid=job('visibility',{'changes':[{'reference':REF,'visible':False}],'expected_state':[]})
    assert validate_job(valid)==valid
    for field in ('expected_microversion','tab_id'):
        broken=copy.deepcopy(valid);broken.pop(field)
        with pytest.raises(BridgeError): validate_job(broken)
    assert validate_job(job('camera',{'action':'orientation','frame':[1,0,0,0,0,1,0,0,0,0,1,0,1,2,3,1]}))


def test_loaded_extension_capabilities_reported_and_old_workers_rejected():
    config={'host':'127.0.0.1','port':8766,'token':'x'*40}
    client=TestClient(create_app(config),base_url="http://127.0.0.1:8766");auth=BridgeAuth(config['token'])
    with client.websocket_connect('/extension',headers={'origin':'chrome-extension://'+'a'*32}) as ws:
        nonce=ws.receive_json()['nonce']
        ws.send_json({'type':'hello','nonce':'e'*32,'mac':mac(config['token'],f"ext\n{nonce}\n{'e'*32}"),'capabilities':['policy_v2']});ws.receive_json()
        state=client.get('/health',auth=auth).json()
        assert state['extension']=={'version':'unknown','capabilities':['policy_v2']}
        response=client.post('/command',auth=auth,json=job('inspect',{}))
        assert response.status_code==400
        assert 'display_v1' in response.json()['error']


def test_snapshot_paging_keeps_exact_display_tab_and_fingerprint(tmp_path):
    class Service: store=Store(tmp_path)
    d=Display(Service())
    rows=[dict(tree_path='instance.mate',visibility=1,parent_hidden=False,suppressed=False,suppressed_by_parent=False)]
    snapshot=d.snapshot('url',TARGET,77,dict(rows=rows,microversion=MICRO,complete=True,issues=[],camera={}))
    saved=d.load(snapshot)
    assert saved['tab_id']==77
    assert saved['expected_state']==[['instance.mate',1,False,False,False]]
    assert d.page(saved,snapshot,0,10)['data']==rows


@pytest.mark.parametrize('args',[
 {'action':'zoom','box':[0,0,0,0.01,0.01,0.01]},
 {'action':'zoom','part_ids':['JKD']},
 {'action':'zoom','occurrence_paths':[['MpLBWsAGviJgbfSTU']]},
])
def test_zoom_takes_exactly_one_of_box_parts_or_occurrences(args):
    assert validate_job(job('camera',args))


@pytest.mark.parametrize('args',[
 {'action':'zoom'},
 {'action':'zoom','box':[0,0,0,0.01,0.01,0.01],'part_ids':['JKD']},
 {'action':'zoom','box':[0,0,0,0.01,0.01]},
 {'action':'zoom','box':[0,0,0,0.01,-0.01,0.01]},
 {'action':'zoom','box':[0,0,0,float('nan'),0.01,0.01]},
 {'action':'zoom','part_ids':['bad id']},
 {'action':'fit','box':[0,0,0,0.01,0.01,0.01]},
])
def test_malformed_zoom_targets_are_rejected(args):
    with pytest.raises(BridgeError): validate_job(job('camera',args))


def test_zoom_box_in_mm_becomes_metres_with_a_margin():
    from onshape_native.server import zoom_box
    from onshape_native.client import OnshapeError
    # 10 mm wide in x: 2 mm margin; flat in z: the 1 mm minimum.
    assert zoom_box([0, 0, 5, 10, 20, 5]) == pytest.approx([-0.002, -0.004, 0.004, 0.012, 0.024, 0.006])
    with pytest.raises(OnshapeError): zoom_box([0, 0, 0, -1, 1, 1])
