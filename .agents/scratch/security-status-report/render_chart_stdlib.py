#!/usr/bin/env python3
"""Dependency-free bar chart for the security status report (stdlib zlib/struct PNG writer)."""
import json, struct, zlib, sys

final_path, out_path = sys.argv[1], sys.argv[2]
data = json.load(open(final_path))
rows = sorted(data, key=lambda r: r.get("threat_id", ""))
W, H, PAD, BAR_W, GAP = 900, 420, 48, 78, 28
plot_h = H - 2 * PAD

def pix_color(score):
    return (0xdc, 0x2626 // 0x100, 0x26)  # replaced below

rows_rgb = [(0x16,0xa3,0x4a) if s>=0.95 else ((0xea,0xb3,0x08) if s>=0.5 else (0xf9,0x73,0x16))
            for s in [max(0.0,min(1.0,float(r.get("quality",0.0)))) for r in rows]]
scores = [max(0.0,min(1.0,float(r.get("quality",0.0)))) for r in rows]

canvas = bytearray(b'\xff' * (W*H*3))
def rect(x0,y0,x1,y1,c):
    for y in range(max(0,y0),min(H,y1)):
        base=y*W*3
        for x in range(max(0,x0),min(W,x1)):
            canvas[base+x*3:base+x*3+3]=bytes(c)

# axes
rect(PAD, H-PAD, W-PAD, H-PAD+2, (0,0,0))
for i,s in enumerate(scores):
    x0 = PAD + 20 + i*(BAR_W+GAP)
    filled = int(plot_h*s)
    rect(x0, H-PAD-filled, x0+BAR_W, H-PAD, rows_rgb[i])
    rect(x0, H-PAD-plot_h, x0+BAR_W, H-PAD-filled, (0xdc,0x26,0x26))
    rect(x0, H-PAD-filled-3, x0+BAR_W, H-PAD-filled, (0,0,0))  # colourblind cap

def png_chunk(t,d):
    return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
raw=b''.join(b'\x00'+bytes(canvas[y*W*3:(y+1)*W*3]) for y in range(H))
png=b'\x89PNG\r\n\x1a\n'+png_chunk(b'IHDR',struct.pack('>IIBBBBB',W,H,8,2,0,0,0))+png_chunk(b'IDAT',zlib.compress(raw,6))+png_chunk(b'IEND',b'')
open(out_path,'wb').write(png)
print(f"wrote {out_path} for {len(rows)} threats: "+", ".join(f"{r['threat_id']}={s:.2f}" for r,s in zip(rows,scores)))
