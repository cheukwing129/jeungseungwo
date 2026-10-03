"""Generate three small replacement effects whose source files were absent."""
from pathlib import Path
import json,math,wave,struct,random,hashlib

rate=22050
root=Path(__file__).resolve().parents[1]/'dist'
manifest=json.loads((root/'assets.json').read_text())

def write(key,duration,fn):
    name='assets/'+hashlib.sha256(key.encode()).hexdigest()[:16]+'.wav'
    samples=[max(-32767,min(32767,int(fn(i/rate)*17000))) for i in range(int(duration*rate))]
    with wave.open(str(root/name),'wb') as f:
        f.setnchannels(1);f.setsampwidth(2);f.setframerate(rate)
        f.writeframes(struct.pack('<'+'h'*len(samples),*samples))
    manifest[key]={'src':name,'replacement':True}

def ding(t):
    return sum(math.sin(2*math.pi*freq*(t-offset))*math.exp(-6*(t-offset))*.19
               for freq,offset in [(523.25,0),(659.25,.08),(783.99,.16)] if t>=offset)

def pluck(t):
    return sum(math.sin(2*math.pi*freq*t)*math.exp(-9*t)*(.32/(j+1))
               for j,freq in enumerate([293.66,587.32,880.98,1174.64]))

rng=random.Random(17)
noise=[rng.uniform(-1,1) for _ in range(rate)]
def sword(t):
    envelope=math.sin(math.pi*min(1,t/.32))**2 if t<.32 else 0
    return (noise[int(t*rate)%len(noise)]*.3+math.sin(2*math.pi*(1800*t+2200*t*t))*.13)*envelope

write('SE/好感度提升.mp3',1.0,ding)
write('SE/琵琶.mp3',1.2,pluck)
write('SE/战斗-拔刀剑声(36).mp3',.4,sword)
(root/'assets.json').write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')))
print('Prepared three replacement effects.')
