import struct, os
# A fully-transparent X cursor so cage draws nothing — the web UI's own
# (eye) cursor is then the only pointer the user sees.
d = "/usr/share/icons/blank/cursors"
os.makedirs(d, exist_ok=True)
w = h = 32
data = (b'Xcur' + struct.pack('<3I', 16, 0x00010000, 1)
        + struct.pack('<3I', 0xfffd0002, 32, 28)
        + struct.pack('<9I', 36, 0xfffd0002, 32, 1, w, h, 0, 0, 0)
        + b'\x00\x00\x00\x00' * (w * h))
open(d + "/left_ptr", "wb").write(data)
for n in ["default", "arrow", "top_left_arrow", "cursor", "pointer", "hand1", "hand2", "xterm", "text", "watch"]:
    p = d + "/" + n
    try: os.remove(p)
    except FileNotFoundError: pass
    os.symlink("left_ptr", p)
open("/usr/share/icons/blank/index.theme", "w").write("[Icon Theme]\nName=blank\n")
print("transparent cage cursor installed")
