"""One-shot native-record-missing -> fresh session -> file-based continuation."""
import hashlib,json,os,shutil,subprocess,sys,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT.parent/'pi-cli-1.4.0';sys.path.insert(0,str(BASE/'scripts'))
from pi_rpc_probe import PiCLI,PROVIDER,MODEL
WORK=ROOT/'.work';FIXTURE=ROOT/'fixture';FIXTURE.mkdir(exist_ok=True)
for name in ('duration.py','test_duration.py'):shutil.copy2(BASE/'02-full-loop/fixture'/name,FIXTURE/name)
p=FIXTURE/'duration.py';p.write_text(p.read_text().replace('(3600, 60, 1)','(3600, 0, 0)'))
(FIXTURE/'task.md').write_text('# Duration task\nTask ID: fallback-fixture\nPhase: implement\nGoal: parse_duration(text) -> seconds. Ordered integer h/m/s groups, invalid text ValueError, non-string TypeError; zero is valid.\nScope: duration.py and test_duration.py only. No Git operations.\n')
(FIXTURE/'progress.md').write_text('# Saved progress\nCompleted: grammar validation and hour conversion.\nRemaining: minute/second conversion factors and verification. Existing unit tests express the original requirements. Inspect current code before making a minimal fix.\nRepair rounds already consumed: 1. Do not reset this counter.\n')
for name in ('duration.py','test_duration.py','task.md','progress.md'):shutil.copy2(FIXTURE/name,WORK/name)
old_id=str(uuid.uuid4());old_file=WORK/'lost-native-session.jsonl'
report={'status':'running','scenario':'native history missing; continue from durable task files','provider':PROVIDER,'model':MODEL,'old_session_id':old_id,'old_record_exists':old_file.exists(),'fallback_reason':'native_record_missing','task_id':'fallback-fixture','phase':'implement','repair_rounds':1,'helper_sha256':hashlib.sha256((BASE/'scripts/pi_rpc_probe.py').read_bytes()).hexdigest()}
client=None
try:
    before=subprocess.run([sys.executable,'-m','unittest','-v'],cwd=WORK,capture_output=True,text=True)
    assert before.returncode!=0
    (ROOT/'before-unittest.txt').write_text(before.stdout+before.stderr)
    # Do not pass a missing path to Pi: it can silently create an empty session.
    assert not old_file.exists()
    client=PiCLI(WORK,'fresh-fallback',tools='read,edit,write,bash')
    assert client.id!=old_id and client.call('get_messages')['data']['messages']==[]
    report['new_session_id']=client.id;report['new_session_initial_history_empty']=True
    client.prompt('The original native session record is missing. This fresh session continues the same task, not a new task. Read task.md and progress.md, then inspect duration.py and test_duration.py. Finish only the remaining work with minimal changes, run unittest, and return one JSON object with task_id, phase, repair_rounds, files_read, changes, and test_result. Follow saved progress. Do not access outside this directory. Do not use Git. Do not modify task.md or progress.md.')
    client.until(lambda:client.settled())
    final=client.last_text();(ROOT/'assistant-final.txt').write_text(final+'\n')
    actual=subprocess.run([sys.executable,'-m','unittest','-v'],cwd=WORK,capture_output=True,text=True)
    (ROOT/'after-unittest.txt').write_text(actual.stdout+actual.stderr);assert actual.returncode==0
    for name in ('task.md','progress.md'):assert (WORK/name).read_bytes()==(FIXTURE/name).read_bytes()
    assert 'fallback-fixture' in final and 'implement' in final and 'repair_rounds' in final
    report.update(status='passed',same_task_metadata_preserved=True,controller_unittest_passed=True,usage=client.stats(),agent_settled=True)
    client.refresh();native=Path(client.file);assert native.is_file()
    target=ROOT/'private-native'/native.name;shutil.copy2(native,target);target.chmod(0o600);report['native_record']=str(target.relative_to(ROOT))
    for name in ('duration.py','test_duration.py'):shutil.copy2(WORK/name,FIXTURE/('after-'+name))
except Exception as error:
    import traceback
    report.update(status='failed',error=str(error),traceback=traceback.format_exc())
finally:
    if client:client.close()
    (ROOT/'private-native').chmod(0o700);WORK.chmod(0o700)
    for source in WORK.glob('*-events.jsonl'):shutil.copy2(source,ROOT/source.name)
    (ROOT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))
if report['status']!='passed':raise SystemExit(1)
