"""Read the data-only subset of Microsoft NRBF used by this Orange project.

No CLR types are loaded, instantiated, or executed. Object references stay explicit.
"""
import struct
from pathlib import Path


class Nrbf:
    def __init__(self, data):
        self.data = data
        self.pos = 0
        self.objects = {}
        self.metadata = {}
        self.libraries = {}
        self.root_id = None
        self.records = {}

    def take(self, n):
        if self.pos + n > len(self.data):
            raise ValueError(f"Unexpected end at {self.pos}, need {n}")
        b = self.data[self.pos:self.pos+n]
        self.pos += n
        return b

    def byte(self):
        return self.take(1)[0]

    def int(self):
        return struct.unpack('<i', self.take(4))[0]

    def string(self):
        n = 0
        for shift in range(0, 35, 7):
            b = self.byte()
            n |= (b & 127) << shift
            if not b & 128:
                if n > 10_000_000:
                    raise ValueError("Invalid string length")
                return self.take(n).decode('utf-8')
        raise ValueError("Invalid length prefix")

    def primitive(self, p):
        # NRBF PrimitiveTypeEnumeration: 5 Decimal (string), 6 Double,
        # 7 Int16, 8 Int32, 9 Int64, 10 SByte, 11 Single, 12 TimeSpan,
        # 13 DateTime, 14 UInt16, 15 UInt32, 16 UInt64.
        fmt = {1:'?', 2:'B', 6:'d', 7:'h', 8:'i', 9:'q', 10:'b', 11:'f',
               12:'q', 13:'Q', 14:'H', 15:'I', 16:'Q'}
        if p in fmt:
            return struct.unpack('<'+fmt[p], self.take(struct.calcsize(fmt[p])))[0]
        if p == 3:
            first = self.byte()
            size = 1 if first < 128 else 2 if first < 224 else 3 if first < 240 else 4
            return (bytes([first])+self.take(size-1)).decode('utf-8')
        if p in (5,18):
            return self.string()
        if p == 17:
            return None
        raise ValueError(f"Unsupported primitive {p} at {self.pos}")

    def typeinfo(self, t):
        if t in (0,7): return self.byte()
        if t == 3: return self.string()
        if t == 4: return (self.string(), self.int())
        return None

    def values(self, types, infos):
        return [self.primitive(i) if t == 0 else self.record_value() for t,i in zip(types,infos)]

    def record_value(self):
        while True:
            value = self.record()
            if value is not SKIP: return value

    def array_values(self, length, t=2, info=None):
        values = []
        if not 0 <= length <= 1_000_000: raise ValueError("Invalid array length")
        if t == 0: return [self.primitive(info) for _ in range(length)]
        while len(values) < length:
            value = self.record_value()
            if isinstance(value, tuple) and value[0] == 'nulls': values.extend([None]*value[1])
            else: values.append(value)
        if len(values) != length: raise ValueError("Null run exceeds array length")
        return values

    def record(self):
        start = self.pos
        r = self.byte()
        self.records[r] = self.records.get(r,0) + 1
        if r == 0:
            self.root_id = self.int()
            self.int(); self.int(); self.int()
            return SKIP
        if r == 12:
            lid = self.int(); self.libraries[lid] = self.string()
            return SKIP
        if r == 6:
            oid = self.int(); self.objects[oid] = self.string()
            return {'$ref':oid}
        if r in (4,5):
            oid = self.int(); name = self.string(); count = self.int()
            if not 0 <= count <= 10000: raise ValueError("Invalid class member count")
            names = [self.string() for _ in range(count)]
            types = [self.byte() for _ in range(count)]
            infos = [self.typeinfo(t) for t in types]
            lid = self.int() if r == 5 else None
            self.metadata[oid] = (name, names, types, infos, lid)
            obj = {'$type':name, '$id':oid}
            self.objects[oid] = obj
            obj.update(zip(names, self.values(types, infos)))
            return {'$ref':oid}
        if r == 1:
            oid = self.int(); mid = self.int()
            name,names,types,infos,lid = self.metadata[mid]
            obj = {'$type':name, '$id':oid}; self.objects[oid] = obj
            obj.update(zip(names, self.values(types,infos)))
            return {'$ref':oid}
        if r == 9: return {'$ref':self.int()}
        if r == 10: return None
        if r == 13: return ('nulls',self.byte())
        if r == 14: return ('nulls',self.int())
        if r == 8: return self.primitive(self.byte())
        if r in (15,16,17):
            oid = self.int(); length = self.int()
            p = self.byte() if r == 15 else None
            self.objects[oid] = self.array_values(length, 0 if r == 15 else 2, p)
            return {'$ref':oid}
        if r == 7:
            oid = self.int(); kind = self.byte(); rank = self.int()
            lengths = [self.int() for _ in range(rank)]
            bounds = [self.int() for _ in range(rank)] if kind in (3,4,5) else []
            t = self.byte(); info = self.typeinfo(t)
            length = 1
            for n in lengths: length *= n
            self.objects[oid] = self.array_values(length,t,info)
            return {'$ref':oid}
        if r == 11: return END
        raise ValueError(f"Unsupported record {r} at {start} (hex {self.data[start:start+40].hex()})")

    def read(self):
        while self.pos < len(self.data):
            if self.record() is END: break
        if self.pos != len(self.data): raise ValueError(f"Trailing bytes: {len(self.data)-self.pos}")
        return self

    def get(self, v):
        while isinstance(v,dict) and set(v)=={'$ref'}: v=self.objects[v['$ref']]
        return v

    def list(self, v):
        v=self.get(v)
        if isinstance(v,list):return [self.get(x) for x in v]
        if isinstance(v,dict) and '_items' in v:
            return [self.get(x) for x in self.get(v['_items'])[:v['_size']]]
        raise ValueError(f"Not a list: {v}")

SKIP=object()
END=object()

if __name__ == '__main__':
    import sys,json,collections
    for path in sys.argv[1:]:
        n=Nrbf(Path(path).read_bytes()).read()
        root=n.objects[n.root_id]
        print(path, 'bytes',n.pos,'objects',len(n.objects),'records',n.records)
        print('ROOT',json.dumps(root,ensure_ascii=False))
        print('TYPES',dict(collections.Counter(x.get('$type') for x in n.objects.values() if isinstance(x,dict))))
