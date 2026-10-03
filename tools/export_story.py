"""Extract the original game commands without the project/account metadata."""
import sys,json,collections,hashlib
from pathlib import Path
from nrbf import Nrbf
from revise_story import revise_story

source=Path(sys.argv[1])
target=Path(sys.argv[2])
n=Nrbf(source.read_bytes()).read()
root=n.objects[n.root_id]
tree=n.get(root['stroy_tree'])
system=n.get(root['system'])

def flat(v):
    v=n.get(v)
    if isinstance(v,list):return [flat(x) for x in v]
    if isinstance(v,dict):
        if '_items' in v:return [flat(x) for x in n.list(v)]
        return {k:flat(x) for k,x in v.items() if not k.startswith('$')}
    return v

maps=[]
for m in n.list(tree['list']):
    evs=[{'code':n.get(e['code'])['value__'],'indent':e['indent'],'p':n.list(e['parameter'])} for e in n.list(m['list'])]
    # Resolve choice nesting from the explicit original indentation.
    for i,e in enumerate(evs):
        if e['code']!=101:continue
        end=next(j for j in range(i+1,len(evs)) if evs[j]['code']==102 and evs[j]['indent']==e['indent'])
        branches=[j for j in range(i+1,end) if evs[j]['code']==108 and evs[j]['indent']==e['indent']+1]
        if len(branches)!=len(e['p']):raise ValueError(f"Choice {m['id']}:{i} branch count mismatch")
        e['choices']=[{'text':e['p'][int(evs[j]['p'][0])],'target':j+1,'end':branches[k+1] if k+1<len(branches) else end} for k,j in enumerate(branches)]
        e['end']=end+1
        for j in branches:evs[j]['skip']=end+1
    maps.append({'id':m['id'],'title':n.get(m['name']),'events':evs})

assets=sorted({p.replace('\\','/') for m in maps for e in m['events'] for p in e['p'] if '\\' in p and p.lower().endswith(('.jpg','.png','.mp3','.ogg','.wav'))})
out={'schema':1,'title':n.get(tree['projectName']),'width':960,'height':540,'startMap':system['startMapId'],
     'sourceHash':hashlib.sha256(source.read_bytes()).hexdigest(),'maps':maps,'assets':assets,
     'titleSettings':flat(system['title']),'talkSettings':flat(system['talk'])}
out=revise_story(out)
target.parent.mkdir(parents=True,exist_ok=True)
target.write_text(json.dumps(out,ensure_ascii=False,separators=(',',':')))
stats={'maps':[{ 'id':m['id'],'title':m['title'],'events':len(m['events']),'dialogue':sum(e['code']==100 for e in m['events']),'choices':sum(e['code']==101 for e in m['events'])} for m in maps],'assets':assets,'titleSettings':out['titleSettings'],'talkSettings':out['talkSettings']}
print(json.dumps(stats,ensure_ascii=False,indent=2))
